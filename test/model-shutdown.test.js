import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture,threadId} from './fixtures.js';
import {createCodexStore} from '../src/codex-store.js';
import {Queue} from '../src/queue.js';
import {SessionCreator} from '../src/session-creator.js';

function deferredModels(){let enter,release;const entered=new Promise(r=>enter=r);const data=new Promise(r=>release=r);return {entered,release,models:{normalize:()=>{enter();return data;}}};}
test('shutdown during model normalization prevents an existing-thread dispatch',async t=>{
  const {dir,cleanup}=fixture(t),store=createCodexStore({codexHome:dir}),deferred=deferredModels();t.after(()=>{store.close();cleanup();});let calls=0;
  const queue=new Queue({store,dataDir:join(dir,'queue'),executable:'must-not-run',models:deferred.models,configuredTurns:{has:()=>false,stop:async()=>{},send:async()=>{calls++;return{status:'queued',messageId:'bad'};}}});
  const pending=queue.send({threadId,text:'hello',requestId:'shutdown-request-001',deviceId:'phone',model:'choice'});
  await deferred.entered;const stopping=queue.stop();deferred.release({model:'choice'});
  await assert.rejects(pending,e=>e.notSubmitted===true&&e.statusCode===503);await stopping;assert.equal(calls,0);
});
test('shutdown during model normalization prevents creation of a new app-server child',async t=>{
  const {dir,cleanup}=fixture(t),store=createCodexStore({codexHome:dir}),deferred=deferredModels();
  const creator=new SessionCreator({store,dataDir:join(dir,'create'),executable:'must-not-run',models:deferred.models});
  t.after(async()=>{await creator.stop();store.close();cleanup();});
  const pending=creator.create({projectId:'p1',text:'hello',requestId:'shutdown-request-002',deviceId:'phone',model:'choice'});
  await deferred.entered;const stopping=creator.stop();deferred.release({model:'choice'});
  await assert.rejects(pending,e=>e.notSubmitted===true&&e.statusCode===503);await stopping;assert.equal(creator.children.size,0);
});
