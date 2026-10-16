import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture,threadId} from './fixtures.js';
import {createCodexStore} from '../src/codex-store.js';
import {createApp} from '../src/server.js';

test('model catalog is paired-only and model options pass through both authenticated send routes',async t=>{
  const {dir,cleanup}=fixture(t),store=createCodexStore({codexHome:dir});let reads=0,sent,created;
  const models={list:async()=>{reads++;return {models:[{id:'choice',name:'Choice',efforts:[{id:'high',label:'高'}],defaultEffort:'high'}],defaultModel:'choice',defaultEffort:'high'};}};
  const app=createApp({store,dataDir:join(dir,'state'),adminToken:'test-admin',models,
    queue:{send:async input=>{sent=input;return{status:'started',messageId:'turn-1'};}},
    creator:{create:async input=>{created=input;return {status:'created',threadId:'new-thread'};},stop:async()=>{}}});
  const {phoneUrl:phone}=await app.start({adminPort:0,phonePort:0,phoneHost:'127.0.0.1'});t.after(async()=>{await app.stop();store.close();cleanup();});
  assert.equal((await fetch(phone+'/api/models')).status,401);assert.equal(reads,0);
  const session=app.auth.pair(app.auth.createGrant().token,'fixture'),headers={Cookie:`crw_device=${session.token}`,Origin:phone,'Content-Type':'application/json'};
  const data=await(await fetch(phone+'/api/models',{headers})).json();assert.equal(data.models[0].id,'choice');
  const payload={text:'hello',requestId:'routes-model-request',model:'choice',effort:'high'};
  let response=await fetch(phone+`/api/threads/${threadId}/messages`,{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,200);assert.equal(sent.model,'choice');assert.equal(sent.effort,'high');
  response=await fetch(phone+'/api/projects/p1/threads',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,201);assert.equal(created.model,'choice');assert.equal(created.effort,'high');
});
