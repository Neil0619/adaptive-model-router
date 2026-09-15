// Isolated parser replay of real generic Hook captures. This is not a Router
// dispatch, qualification, retirement, migration or production outcome proof.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
export async function verifyCapturedMessageCheckpoint(root) {
  const lib = fileURLToPath(new URL('../../scripts/lib/', import.meta.url));
  const [{ prepareMessageCheckpoint, prepareMessageContinuation, commitMessageCheckpoint, messageContinuationProjection },
    { sealPrivateState }, { payloadHash }, { opaqueId, projectIdentityMaterial }, { readChildTurnEvidence }] = await Promise.all([
    import(pathToFileURL(join(lib,'message-checkpoint.mjs'))), import(pathToFileURL(join(lib,'private-state.mjs'))),
    import(pathToFileURL(join(lib,'io.mjs'))), import(pathToFileURL(join(lib,'context.mjs'))), import(pathToFileURL(join(lib,'child-turn-evidence.mjs')))
  ]);
  const read = (file) => JSON.parse(readFileSync(join(root,file),'utf8'));
  const a = read('queued-AB-A-report.json'), recovery = read('queued-message-recovery-report.json');
  const parentBytes = readFileSync(a.parent.path), childBytes = readFileSync(a.child.path);
  const parse = (bytes) => bytes.toString().trimEnd().split('\n').map(JSON.parse);
  const parent = parse(parentBytes), child = parse(childBytes);
  const hookRows = parse(readFileSync(join(root,'native-hooks.jsonl'))).map(row=>row.input);
  const temp = realpathSync(mkdtempSync(join(tmpdir(),'router-real-capture-replay-')));
  const parentPath = join(temp,'parent.jsonl'), childPath = join(temp,'child.jsonl');
  const db = new DatabaseSync(':memory:');
  const output = { scope: 'isolated_real_capture_parser_replay', productionQualification: false };
  try {
    db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE delegation_children(route_id TEXT PRIMARY KEY,project_id TEXT,context_key TEXT,locator TEXT,revision INTEGER,verified_revision INTEGER,verified_digest TEXT,state TEXT,created_at TEXT);
      CREATE TABLE delegation_attempts(route_id TEXT PRIMARY KEY,ticket_consumed INTEGER,post_observed INTEGER,ambiguous INTEGER,no_child INTEGER);
      CREATE TABLE delegation_messages(route_id TEXT,caller_turn_id TEXT,call_id TEXT,author TEXT,kind TEXT,input_digest TEXT,revision INTEGER,status TEXT);
      CREATE TABLE delegation_child_stops(route_id TEXT,turn_id TEXT,result_digest TEXT);
      CREATE TABLE runtime_invocations(id TEXT,project_id TEXT,context_key TEXT,state TEXT);
      CREATE TABLE runtime_call_receipts(id TEXT,project_id TEXT,context_key TEXT,state TEXT);
      CREATE TABLE delegation_child_commands(route_id TEXT,call_id TEXT,record TEXT);`);
    const salt = randomBytes(32).toString('hex'); db.prepare("INSERT INTO meta VALUES('local_salt',?)").run(salt);
    const context = {projectId:opaqueId(salt,'project',projectIdentityMaterial(parent[0].payload.cwd)),contextKey:'capture-replay-context'};
    const routeId = 'isolated-generic-capture-replay';
    const locator = {childId:a.childId,parentContextId:a.threadId,agentPath:child[0].payload.agent_path,taskName:'cold_entry_child',transcriptPath:childPath};
    db.prepare("INSERT INTO delegation_children VALUES(?,?,?,?,0,NULL,NULL,'open',?)").run(routeId,context.projectId,context.contextKey,sealPrivateState(db,JSON.stringify(locator)),child[0].timestamp);
    // Generic captures have no Router ticket. This fixture row supplies only the
    // isolated parser precondition; it never attests native Router admission.
    db.prepare('INSERT INTO delegation_attempts VALUES(?,1,1,0,0)').run(routeId);
    const store = {db,transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
    const writePrefix = (lines, turn, path) => {
      const index=lines.findIndex(row=>row.type==='event_msg'&&row.payload.type==='task_complete'&&row.payload.turn_id===turn);
      assert.ok(index>=0);writeFileSync(path,lines.slice(0,index+1).map(JSON.stringify).join('\n')+'\n',{mode:0o600});
    };
    const addMessage = (callId,revision) => {
      const item=parent.find(row=>row.type==='response_item'&&row.payload.type==='function_call'&&row.payload.call_id===callId).payload;
      const done=parent.find(row=>row.type==='response_item'&&row.payload.type==='function_call_output'&&row.payload.call_id===callId).payload;
      assert.equal(done.output,''); const args=JSON.parse(item.arguments);
      assert.ok(hookRows.some(row=>row.hook_event_name==='PreToolUse'&&row.tool_use_id===callId&&JSON.stringify(row.tool_input)===JSON.stringify(args)));
      assert.ok(hookRows.some(row=>row.hook_event_name==='PostToolUse'&&row.tool_use_id===callId&&row.tool_response===''));
      db.prepare('INSERT INTO delegation_messages VALUES(?,?,?,?,?,?,?,?)').run(routeId,item.internal_chat_message_metadata_passthrough.turn_id,callId,payloadHash('/root'),item.name,payloadHash(args),revision,'accepted');
      db.prepare('UPDATE delegation_children SET revision=? WHERE route_id=?').run(revision,routeId);
    };
    const addStop = (turn) => {
      const row=hookRows.find(row=>row.hook_event_name==='SubagentStop'&&row.agent_id===a.childId&&row.turn_id===turn);
      assert.ok(row);db.prepare('INSERT INTO delegation_child_stops VALUES(?,?,?)').run(routeId,turn,payloadHash(row.last_assistant_message));
    };
    writePrefix(parent,a.completed.params.turn.id,parentPath);writePrefix(child,a.child.turns.at(-1).id,childPath);
    addMessage(recovery.originalQueuedCall,1);addStop(a.child.turns.at(-1).id);
    const original=JSON.stringify(db.prepare('SELECT * FROM delegation_messages').get());
    const initial=readChildTurnEvidence(locator);output.initial={finished:initial.finished,pendingCalls:initial.pendingCalls.length,pendingOperations:initial.pendingOperations.length};
    const checkpoint=commitMessageCheckpoint(store,prepareMessageCheckpoint(store,context,{routeId,expectedRevision:1,parentTranscriptPath:parentPath}));
    assert.equal(checkpoint.checkpointed,1);output.checkpoint='retained_unconsumed';
    writeFileSync(parentPath,parentBytes,{mode:0o600});writeFileSync(childPath,childBytes,{mode:0o600});
    const finalInput=child.filter(row=>row.type==='response_item'&&row.payload.type==='agent_message').at(-1).payload;
    const cipher=finalInput.content.find(part=>part.type==='encrypted_content').encrypted_content;
    const finalCall=parent.find(row=>row.type==='response_item'&&row.payload.type==='function_call'&&row.payload.name==='followup_task'&&JSON.parse(row.payload.arguments).message===cipher).payload;
    addMessage(finalCall.call_id,2);addStop(recovery.child.turns.at(-1).id);
    // No migration/epoch marker: ordinary native App restart recovery must
    // work for a new task too. This cannot supply an installation proof.
    const disposition={intent:'collect',basis:'Real source captures show original queued requirement absent after cold restart; root supplemented same child from retained context.',pendingOperations:[],
      resultReview:'Verified real final QUEUED_A_REQUIREMENT_HANDLED RECOVERED_REQUIREMENT_DONE, same child and no pending operation.',
      requirements:[{messageId:checkpoint.checkpoints[0],source:'Original accepted native send',disposition:'fulfilled',receipt:'Actual recovery child final contains original required marker',owner:'/root'}]};
    const continued=commitMessageCheckpoint(store,prepareMessageContinuation(store,context,{routeId,expectedRevision:2,parentTranscriptPath:parentPath,checkpointId:checkpoint.checkpoints[0],nativeInputId:finalInput.id,disposition}));
    assert.equal(continued.state,'responsibility_resolved');
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM delegation_messages WHERE revision=1').get()),original);
    const projection=messageContinuationProjection(db,context,db.prepare('SELECT * FROM delegation_children').get());
    assert.equal(projection.conflict,undefined);assert.equal(projection.resolved.size,1);
    assert.ok(readFileSync(a.parent.path).equals(parentBytes));assert.ok(readFileSync(a.child.path).equals(childBytes));
    output.continuation='verified';output.originalCallUnchanged=true;output.originalNativeSourcesUnchanged=true;
    output.realParentId=a.threadId;output.realChildId=a.childId;output.nativeInputId=finalInput.id;
    return output;
  } finally {db.close();rmSync(temp,{recursive:true,force:true});}
}
