import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool, hook, ToolTask, AssistantEntry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
const self=fileURLToPath(import.meta.url);
if (process.argv[2] !== 'worker') {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-durable-recovery-'));
  console.log(JSON.stringify({reportDirectory:base}));
  for(const mode of ['unsafe','safe-duplicate','safe-idempotent']) {
    const dir=path.join(base,mode); fs.mkdirSync(dir);
    const first=spawnSync(process.execPath,[self,'worker',dir,mode,'start'],{encoding:'utf8',timeout:15000});
    assert.equal(first.signal,'SIGKILL',first.stderr+first.stdout);
    const second=spawnSync(process.execPath,[self,'worker',dir,mode,'resume'],{encoding:'utf8',timeout:15000});
    assert.equal(second.status,0,second.stderr+second.stdout); console.log(second.stdout.trim());
  }
} else {
 const [, , ,dir,mode,stage]=process.argv;
 const attemptsFile=path.join(dir,'attempts.json'), effectsFile=path.join(dir,'effects.json'), hooksFile=path.join(dir,'hooks.json');
 const load=p=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):[];
 const add=(p,v)=>fs.writeFileSync(p,JSON.stringify([...load(p),v]));
 const tool=defineTool({name:'record_change',description:'A local simulated external mutation',parameters:Type.Object({key:Type.String()}),
   replay:mode==='unsafe'?'unsafe':'safe',execute:async(args,api)=>{
     add(attemptsFile,{taskId:api.taskId,key:args.key});
     if(mode!=='safe-idempotent'||!load(effectsFile).some(x=>x.key===args.key)) add(effectsFile,{key:args.key,value:3});
     // External effect is durable, but Pi has no tool-result commit yet.
     if(stage==='start')process.kill(process.pid,'SIGKILL');
     return {output:[{type:'text',text:'retries=3'}]};
   }});
 const registry=createRegistry();registry.install(defineExtension({name:'fixture',tools:[tool],hooks:[hook(ToolTask,{beforeTool:call=>{add(hooksFile,call.name);}})]}));
 const h=await Harness.open(await openNodeSqliteStorage(path.join(dir,'session.sqlite')),{models:createModels(),registry},ctx);
 const root=await h.root(ctx); let taskId;
 if(stage==='start') {
  taskId=await root.commit(async tx=>{
   const a=await tx.appendEntry(AssistantEntry,root.id,{model:[{role:'assistant',api:'fixture',provider:'fixture',model:'fixture',timestamp:0,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',
    content:[{type:'toolCall',id:'call-1',name:'record_change',arguments:{key:'job-42:config'}}]}]});
   return tx.createTask(ToolTask,{kind:'model',assistant:a.id,callId:'call-1'},{ownership:{kind:'conversation'}});
  },ctx);fs.writeFileSync(path.join(dir,'task.json'),JSON.stringify(taskId));
 }else taskId=JSON.parse(fs.readFileSync(path.join(dir,'task.json'),'utf8'));
 const before=await h.getTask(taskId,ctx);h.resume();const settled=await h.waitForTask(taskId,ctx);
 const entry=await root.commit(tx=>tx.entry(settled.state.outcome.result.entryId),ctx);
 const result={mode,reopenedStatus:before.state.status,reopenedPhase:before.state.checkpoint.phase,attempts:load(attemptsFile).length,effects:load(effectsFile).length,hooks:load(hooksFile).length,isError:entry.model[0].isError,diagnostics:entry.data.diagnostics.map(x=>x.code),resultContent:entry.model[0].content,committedDetails:entry.model[0].details};
 assert.equal(result.hooks,1);assert.equal(result.attempts,mode==='unsafe'?1:2);assert.equal(result.effects,mode==='safe-duplicate'?2:1);assert.equal(result.isError,mode==='unsafe');
 console.log(JSON.stringify(result));await h.close(ctx);
}
