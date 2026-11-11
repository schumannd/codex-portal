import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGitHubTool} from '../src/github-tools.mjs';
const call=(handler,arguments_)=>handler({tool:'github_repository',arguments:arguments_});
test('GitHub tool restricts repositories and blocks summary writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'github-test-'));try{
 const handler=createGitHubTool({cwd:dir,run:()=>assert.fail()});
 assert.equal((await call(handler,{action:'checkout',repository:'other/private'})).success,false);
 assert.equal((await call(handler,{action:'checkout',repository:'schumannd/../../escape'})).success,false);
 assert.equal((await call(handler,{action:'checkout',repository:'schumannd/test',branch:'--unsafe'})).success,false);
 assert.equal((await call(createGitHubTool({cwd:dir,enabled:false}),{action:'checkout',repository:'schumannd/test'})).success,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('publish commits and pushes the current branch using the fixed repository origin',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'github-test-'));mkdirSync(join(dir,'repositories','test'),{recursive:true});const commands=[];
 try{const h=createGitHubTool({cwd:dir,run:async(c,a)=>{commands.push([c,a]);if(a.includes('get-url'))return 'git@github.com:schumannd/test.git';if(a.includes('--show-current'))return 'feature';if(a.includes('--cached'))return '+normal code';if(a.includes('rev-parse'))return 'abc';return '';}});
 const r=await call(h,{action:'publish',repository:'schumannd/test',branch:'feature',message:'Fix bug'});assert.equal(r.success,true);assert.ok(commands.some(([,a])=>a.includes('commit')));assert.ok(commands.some(([,a])=>a.includes('push')&&a.at(-1)==='feature'));assert.ok(commands.every(([,a])=>!a.includes('--force')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('publishing a credential-like diff is blocked before commit or push',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'github-test-'));mkdirSync(join(dir,'repositories','test'),{recursive:true});const commands=[];
 try{const h=createGitHubTool({cwd:dir,run:async(c,a)=>{commands.push(a);if(a.includes('get-url'))return 'git@github.com:schumannd/test.git';if(a.includes('--show-current'))return 'main';if(a.includes('--cached'))return '+-----BEGIN OPENSSH PRIVATE KEY-----';return '';}});
 assert.equal((await call(h,{action:'publish',repository:'schumannd/test',message:'oops'})).success,false);assert.ok(!commands.some(a=>a.includes('push')||a.includes('commit')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('deployment dispatch reports requested rather than completed and passes workflow inputs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'github-test-'));const commands=[];
 try{const h=createGitHubTool({cwd:dir,run:async(c,a)=>{commands.push([c,a]);return '';}});const r=await call(h,{action:'deploy',repository:'schumannd/test',branch:'main',workflow:'deploy.yml',inputs:{environment:'production'}});
 assert.equal(r.success,true);assert.equal(JSON.parse(r.contentItems[0].text).dispatched,true);assert.ok(commands[0][1].includes('inputs[environment]=production'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('shared tools can use an explicitly approved existing repository outside the session directory',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'github-shared-'));mkdirSync(join(dir,'session'));mkdirSync(join(dir,'live'));const commands=[];
 try{const h=createGitHubTool({cwd:join(dir,'session'),repositoryRoot:join(dir,'shared'),localRepositories:{'schumannd/test':join(dir,'live')},run:async(c,a)=>{commands.push(a);if(a.includes('get-url'))return 'git@github.com:schumannd/test.git';if(a.includes('--show-current'))return 'main';return '';}});
 const r=await call(h,{action:'checkout',repository:'schumannd/test'});assert.equal(r.success,true);assert.equal(JSON.parse(r.contentItems[0].text).path,join(dir,'live'));assert.ok(!commands.some(a=>a.includes('clone')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
