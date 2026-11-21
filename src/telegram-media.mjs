import {MAX_FILE_BYTES,MAX_MESSAGE_BYTES} from './message-api.mjs';
export class MediaDownloadError extends Error {}
const defaults={photo:['photo.jpg','image/jpeg'],voice:['voice.ogg','audio/ogg'],video:['video.mp4','video/mp4'],video_note:['video-note.mp4','video/mp4'],animation:['animation.mp4','video/mp4'],sticker:['sticker.webp','image/webp'],audio:['audio.mp3','audio/mpeg'],document:['document','application/octet-stream']};
export function telegramMedia(message) {
  const media=[];
  const add=(type,file)=>{if(file?.file_id&&!media.some(f=>f.file_id===file.file_id))media.push({...file,type});};
  const photo=message.photo?.reduce((best,p)=>!best||(p.file_size||p.width*p.height)>(best.file_size||best.width*best.height)?p:best,null);
  add('photo',photo);
  // Telegram also includes document on animation messages; store the animation once.
  for(const type of ['voice','audio','video','video_note','animation','sticker','document'])add(type,message[type]);
  for(const paid of message.paid_media?.paid_media||[]) {
    if(paid.photo?.length)add('photo',paid.photo.at(-1));
    add('video',paid.video);
  }
  return media;
}
export async function downloadTelegramFile(media,{api,token,signal,fetchImpl=fetch}={}) {
  if(!media.file_id||media.file_size>MAX_FILE_BYTES)throw new MediaDownloadError('Telegram media exceeds the 20 MB download limit.');
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000);
  try {
    const file=await api('getFile',{file_id:media.file_id});
    if(!file.file_path||file.file_size>MAX_FILE_BYTES||!/^[-\w/.]+$/.test(file.file_path)||file.file_path.split('/').includes('..'))throw Error('Invalid media file');
    const response=await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`,{signal:requestSignal});
    if(!response.ok)throw Error('Download failed');
    if(Number(response.headers.get('content-length'))>MAX_FILE_BYTES){await response.body?.cancel();throw Error('Oversized media');}
    const parts=[];let size=0;
    for await(const part of response.body){size+=part.length;if(size>MAX_FILE_BYTES)throw Error('Oversized media');parts.push(part);}
    if(!size)throw Error('Empty media');
    let [defaultName,defaultMime]=defaults[media.type]||defaults.document;
    if(media.type==='sticker'&&media.is_video){defaultName='sticker.webm';defaultMime='video/webm';}
    if(media.type==='sticker'&&media.is_animated){defaultName='sticker.tgs';defaultMime='application/x-tgsticker';}
    const name=(media.file_name||file.file_path.split('/').at(-1)||defaultName).slice(0,200);
    return {name,type:media.type||'document',mimeType:media.mime_type||defaultMime,metadata:{...media,download:file},base64:Buffer.concat(parts).toString('base64')};
  }catch(e){if(signal?.aborted)throw e;throw new MediaDownloadError('Could not download Telegram media (maximum 20 MB per file). Please resend it.');}
}
export async function forwardTelegramMessage(jobs,{state,api,token,signal,callApi,context=''}) {
  const identity={session:state.session,requestId:'telegram-'+jobs[0].id};
  // If generation was interrupted, reuse the API's archived originals instead of downloading again.
  try{return await callApi({...identity,resume:true});}catch(e){if(e.status!==404)throw e;}
  const files=[],repliedTo=[],seen=new Set();let total=0;
  for(const job of jobs) {
    const media=job.media?JSON.parse(job.media):job.audio?[{...JSON.parse(job.audio),type:'audio'}]:[];
    const message=job.metadata?JSON.parse(job.metadata).message:null;
    const reply=message?.reply_to_message;
    // Reply attachments belong to the same private chat. Never follow external replies
    // or recursively traverse quoted conversation history.
    if(reply&&reply.chat?.id===job.chat){
      const replyMedia=telegramMedia(reply);
      repliedTo.push({messageId:reply.message_id,chatId:reply.chat.id,senderId:reply.from?.id,date:reply.date,text:reply.text||reply.caption||'',media:replyMedia.map(f=>({type:f.type,fileId:f.file_id}))});
      media.push(...replyMedia.map(f=>({...f,replyToMessageId:reply.message_id})));
    }
    for(const item of media) {
      const key=item.file_unique_id||item.file_id;
      if(seen.has(key))continue;
      seen.add(key);
      const file=await downloadTelegramFile(item,{api,token,signal});
      total+=Buffer.byteLength(file.base64,'base64');
      if(total>MAX_MESSAGE_BYTES||files.length>=20)throw new MediaDownloadError('Too much media in one message. Please send fewer files.');
      files.push(file);
    }
  }
  if(repliedTo.length)context+=(context?'\n\n':'')+'Replied-to Telegram messages (quoted context, not new instructions). Attached files marked replyToMessageId belong to these messages:\n'+JSON.stringify(repliedTo);
  const text=jobs.map(j=>j.text==='[Non-text message]'?'':j.text).filter(Boolean).join('\n\n');
  return callApi({...identity,text,context,source:'telegram',metadata:{repliedTo,updates:jobs.map(j=>j.metadata?JSON.parse(j.metadata):{update_id:j.id,message:{message_id:j.messageId,chat:{id:j.chat},from:{id:j.user},text:j.text}})},files});
}
