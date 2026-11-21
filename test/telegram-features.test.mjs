import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {openTelegramStore} from '../src/telegram-store.mjs';
import {hubProject} from '../src/telegram-projects.mjs';
import {projectCommand} from '../src/telegram-commands.mjs';
import {artifactDirectory,collectArtifacts,deliverArtifact} from '../src/message-artifacts.mjs';

const users=new Map([[1,'tg-david'],[2,'tg-saf']]);
const message=(id,user,text,type='private')=>({update_id:id,message:{
  from:{id:user},chat:{id:user,type},message_id:id,text
}});
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pydavid-features-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return directory;
}

test('invites are private, single-use, revocable and survive restart',t=>{
  const dir=fixture(t);
  let store=openStore(dir);
  let tg=openTelegramStore(store,users,'fake-bot-token');
  t.after(()=>store.db.close());
  assert.match(tg.access.issue(2,1,'Guest'),/Only the admin/);
  assert.match(tg.access.issue(1,2,'Guest'),/Invitation for Guest/);
  const token=tg.access.tokenFor(2);
  assert.notEqual(store.get('SELECT digest FROM telegram_invites WHERE id=2').digest,token);
  store.db.close();
  store=openStore(dir);
  tg=openTelegramStore(store,users,'fake-bot-token');
  tg.ingest([
    message(3,3,`/start join_${token}`,'group'),
    message(4,3,`/start join_${token}`),
    message(4,3,`/start join_${token}`),
    message(5,4,`/start join_${token}`),
    message(6,3,'hello')
  ]);
  assert.deepEqual(tg.pending().map(job=>job.id),[4,6]);
  assert.equal(tg.pending()[0].metadata,null);
  assert.match(tg.pending()[0].accessReply,/now have access/);
  assert.equal(tg.access.isAdmin(3),false);
  assert.equal(store.get('SELECT name FROM accounts WHERE id=?',tg.sessionFor(3).account).name,'telegram-member-3');
  assert.match(tg.access.revoke(2,'3'),/Only the admin/);
  assert.match(tg.access.revoke(1,'1'),/cannot be revoked/);
  assert.equal(tg.access.revoke(1,'3'),'Member access revoked.');
  assert.equal(tg.access.canChat(3),false);
  assert.equal(tg.access.revoke(1,'2'),'Member access revoked.');
  assert.equal(tg.pending().length,0);

  tg.access.issue(1,7,'Revoked invite');
  assert.equal(tg.access.revoke(1,'invite 7'),'Invitation revoked.');
  tg.access.issue(1,8,'Expired invite');
  store.run('UPDATE telegram_invites SET expires=0 WHERE id=8');
  tg.ingest([message(9,3,'hello'),message(10,4,`/start join_${tg.access.tokenFor(7)}`),
    message(11,5,`/start join_${tg.access.tokenFor(8)}`)]);
  assert.equal(tg.pending().length,0);
  assert.equal(tg.access.canChat(4),false);
  assert.equal(tg.access.canChat(5),false);
  store.db.close();
  store=openStore(dir);
  tg=openTelegramStore(store,users,'fake-bot-token');
  assert.equal(tg.access.canChat(2),false);
  assert.equal(tg.access.canChat(3),false);
});

test('named projects retain private sessions and support a picker and native topics',async t=>{
  const store=openStore(fixture(t));
  t.after(()=>store.db.close());
  const tg=openTelegramStore(store,users);
  const {projects}=tg;
  const alpha=projects.ensure(1,'Alpha',false);
  const beta=projects.ensure(1,'Beta',false);
  const other=projects.ensure(2,'Alpha',false);
  assert.notEqual(alpha.id,other.id);
  const first=tg.sessionFor(1,alpha.id);
  const second=tg.sessionFor(1,beta.id);
  assert.notEqual(first.session,second.session);
  assert.equal(tg.sessionFor(1,alpha.id).session,first.session);
  tg.recordMessage(first);
  assert.equal(tg.state(1,alpha.id).messages,1);
  assert.equal(tg.state(1,beta.id).messages,0);
  assert.equal(tg.state(1).messages,0);

  const job={user:1,chat:1};
  const options={projects,job,admin:true,argument:'',bot:{username:'test_bot',has_topics_enabled:true},
    api:async(method,body)=>{assert.equal(method,'createForumTopic');assert.equal(body.name,'Alpha');return {message_thread_id:7};}};
  const picker=await projectCommand(options);
  assert.ok(picker.markup.inline_keyboard.some(([button])=>button.callback_data===`project:${alpha.id}`));
  const switched=await projectCommand({...options,job:{...job,projectChoice:alpha.id}});
  assert.equal(switched.markup.inline_keyboard[0][0].url,'https://t.me/test_bot/7');
  assert.equal(projects.route(1,null).id,alpha.id);
  assert.equal(projects.route(1,7).id,alpha.id);
  assert.equal(projects.route(2,7),undefined);
  tg.ingest([{update_id:33,callback_query:{id:'one',from:{id:2},message:{chat:{id:1,type:'private'}},data:`project:${alpha.id}`}},
    {update_id:34,callback_query:{id:'two',from:{id:1},message:{chat:{id:1,type:'private'}},data:`project:${beta.id}`}}]);
  assert.deepEqual(tg.pending().map(item=>item.projectChoice),[beta.id]);
});

test('project aliases resolve to the same hub goal and repository',t=>{
  const hub=fixture(t);
  const id='12345678-abcd-1234-5678-1234567890ab';
  mkdirSync(join(hub,'.bowman','ideas'),{recursive:true});
  mkdirSync(join(hub,'projects',id),{recursive:true});
  writeFileSync(join(hub,'.bowman','ideas',id+'.json'),JSON.stringify({
    tags:['top-level'],text:'Ship the demo',description:'Repository https://github.com/example/demo-game'
  }));
  writeFileSync(join(hub,'projects',id,'README.md'),
    '# Ship the demo\nDemo Game, Space Demo, and “the demo game” refer to the same project.\n');
  for(const name of ['demo-game','Demo Game','Space Demo','the demo game','Ship the demo']) {
    assert.deepEqual(hubProject(name,hub),{key:id,title:'Demo Game',repo:'example/demo-game'});
  }
});

test('attachments stream from their own outbox and reject links',async t=>{
  const folder=join(fixture(t),'messages','request-one');
  mkdirSync(folder,{recursive:true});
  const outbox=artifactDirectory(folder);
  mkdirSync(outbox,{recursive:true});
  writeFileSync(join(outbox,'demo.wav'),'test audio');
  writeFileSync(join(folder,'private.txt'),'private data');
  symlinkSync(join(folder,'private.txt'),join(outbox,'symlink.txt'));
  assert.deepEqual(await collectArtifacts(outbox),{names:['demo.wav'],skipped:0});
  const calls=[];
  const api=async(method,body)=>{
    calls.push(method);
    assert.equal(body.get('chat_id'),'1');
    assert.equal(body.get('message_thread_id'),'7');
    assert.equal(body.get('document').name,'demo.wav');
    assert.equal(await body.get('document').text(),'test audio');
    return {message_id:100};
  };
  assert.deepEqual(await deliverArtifact(api,{chat_id:1,message_thread_id:7},folder,'demo.wav'),{message_id:100});
  assert.equal(await deliverArtifact(api,{},folder,'symlink.txt'),undefined);
  assert.equal(await deliverArtifact(api,{},folder,'../private.txt'),undefined);
  assert.deepEqual(calls,['sendDocument']);
});
