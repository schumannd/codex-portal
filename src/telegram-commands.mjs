export function telegramCommand(job, username) {
  if ((job.media && JSON.parse(job.media).length) || job.audio) return {};
  const match = job.text.match(/^\s*(\/\w+)(?:@(\w+))?(?:\s+([\s\S]*))?\s*$/);
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return {};
  return {command:match[1].toLowerCase(), argument:(match[3] || '').trim()};
}

export function replyRoute(job, quoted=false) {
  return {
    chat_id:job.chat,
    ...(job.topic ? {message_thread_id:job.topic} : {}),
    ...(quoted && job.messageId ? {reply_parameters:{message_id:job.messageId,allow_sending_without_reply:true}} : {})
  };
}

export async function projectCommand({projects, job, argument, admin, api, bot}) {
  if (job.projectChoice === 'general' || /^off$/i.test(argument)) {
    if (job.topic) return {text:'Open the main chat to switch to the general conversation.'};
    projects.select(job.user,null);
    return {text:'General conversation selected.'};
  }
  if (!argument && !job.projectChoice) {
    const saved = projects.list(job.user).slice(0,40);
    return {
      text:saved.length ? 'Choose a project, or type /project followed by a new name.' : 'Type /project followed by a name to start a project.',
      markup:{inline_keyboard:[
        ...saved.map(project=>[{text:project.title,callback_data:`project:${project.id}`}]),
        [{text:'General conversation',callback_data:'project:general'}]
      ]}
    };
  }

  let project = job.projectChoice
    ? projects.byId(job.user,job.projectChoice)
    : projects.ensure(job.user,argument,admin);
  if (!project) return {text:'Type /project followed by a project name of up to 80 characters.'};

  if (job.topic) {
    const current = projects.route(job.user,job.topic);
    if (!current && !project.topic) projects.setTopic(job.user,project.id,job.topic);
    else if (current?.id !== project.id) {
      return {text:'This topic belongs to a different project. Open the main chat to switch projects.'};
    }
  } else {
    projects.select(job.user,project.id);
    if (bot.has_topics_enabled && !project.topic) {
      try {
        const topic = await api('createForumTopic',{chat_id:job.chat,name:project.title},6000);
        if (topic?.message_thread_id) projects.setTopic(job.user,project.id,topic.message_thread_id);
      } catch { /* The project can still be opened in the main chat. */ }
    }
  }
  project = projects.byId(job.user,project.id);
  const text = `Project selected: ${project.title}` + (project.repo ? `\nRepository: ${project.repo}` : '');
  return project.topic && project.topic!==job.topic ? {
    text, markup:{inline_keyboard:[[{text:'Open topic',url:`https://t.me/${bot.username}/${project.topic}`}]]}
  } : {text};
}
