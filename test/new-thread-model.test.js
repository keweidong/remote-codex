import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './fixtures.js';
import {createCodexStore} from '../src/codex-store.js';
import {SessionCreator} from '../src/session-creator.js';
import {appServerFixture} from './app-server-fixture.js';

test('new thread receives model at creation and model/effort on first turn with selection-aware deduplication',async t=>{
  const {dir,cleanup}=fixture(t),store=createCodexStore({codexHome:dir});const cli=join(dir,'new-model.cjs');writeFileSync(cli,appServerFixture());
  const creator=new SessionCreator({store,dataDir:join(dir,'state'),executable:process.execPath,prefixArgs:[cli],models:{normalize:async s=>s}});
  t.after(async()=>{await creator.stop();store.close();cleanup();});
  const input={projectId:'p1',text:'hello',deviceId:'phone',requestId:'new-model-request-001',model:'chosen-model',effort:'high'};
  const result=await creator.create(input);assert.equal(result.status,'created');
  const calls=JSON.parse(readFileSync(join(dir,'requests.json'),'utf8'));
  assert.equal(calls.find(r=>r.method==='thread/start').params.model,'chosen-model');
  assert.equal(calls.find(r=>r.method==='turn/start').params.model,'chosen-model');
  assert.equal(calls.find(r=>r.method==='turn/start').params.effort,'high');
  assert.deepEqual(await creator.create(input),result);
  await assert.rejects(creator.create({...input,effort:'low'}),e=>e.statusCode===409);
});
