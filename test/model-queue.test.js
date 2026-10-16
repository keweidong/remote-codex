import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture,threadId} from './fixtures.js';
import {createCodexStore} from '../src/codex-store.js';
import {Queue} from '../src/queue.js';
import {error} from '../src/auth.js';

test('model choice participates in server deduplication and is passed to configured runner',async t=>{
  const {dir,cleanup}=fixture(t),store=createCodexStore({codexHome:dir});t.after(()=>{store.close();cleanup();});
  let calls=0,received;
  const models={normalize:async s=>s};const configuredTurns={has:()=>false,send:async(thread,text,settings)=>{calls++;received={thread,text,settings};return {status:'started',messageId:'turn-model'};}};
  const queue=new Queue({store,dataDir:join(dir,'state'),executable:'must-not-run',models,configuredTurns});
  const input={threadId,text:'Hello',requestId:'model-request-0001',deviceId:'phone',model:'chosen-model',effort:'high'};
  assert.equal((await queue.send(input)).status,'started');assert.equal(received.settings.model,'chosen-model');assert.equal(received.settings.effort,'high');
  assert.equal((await queue.send(input)).messageId,'turn-model');assert.equal(calls,1);
  await assert.rejects(queue.send({...input,model:'other-model'}),e=>e.statusCode===409);
});
test('known owner rejection can retry the same request without persisting an unknown dispatch',async t=>{
  const {dir,cleanup}=fixture(t),store=createCodexStore({codexHome:dir});t.after(()=>{store.close();cleanup();});
  let busy=true;const configuredTurns={has:()=>false,send:async()=>{if(busy)throw Object.assign(error('桌面占用',409),{notSubmitted:true});return{status:'started',messageId:'accepted'};}};
  const queue=new Queue({store,dataDir:join(dir,'state'),executable:'must-not-run',models:{normalize:async s=>s},configuredTurns});
  const input={threadId,text:'Hello',requestId:'model-request-0002',deviceId:'phone',model:'chosen-model'};
  await assert.rejects(queue.send(input),e=>e.notSubmitted===true);busy=false;
  assert.equal((await queue.send(input)).messageId,'accepted');
});
