import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidationGroups, sweepWindows, eligible } from '../src/dream/grouped.js';
import { createDreamScheduler } from '../src/dream.js';
import { createStore } from '../src/store.js';
import { Config } from '../src/config.js';
import { createService } from '../src/service.js';
test('grouped independent window defaults 500 capped 500; legacy unchanged',()=>{assert.equal(Config({dreamConsolidationMode:'grouped'}).dreamGroupedWindow,500);assert.equal(Config({}).dreamConsolidationMode,'legacy');assert.equal(Config({}).dreamMaxSnapshotSize,200);assert.equal(Config({dreamMaxSnapshotSize:1000}).dreamMaxSnapshotSize,1000);for(const v of [0,1000,-1,'500'])assert.throws(()=>Config({dreamGroupedWindow:v}));});
const types = ['project','history','decision','constraint','pitfall','preference','rejected_solution'];
const rows = n => Array.from({length:n}, (_,i) => ({id:String(i).padStart(5,'0'),type:types[i%7],title:`title ${i}`,content:`FULL_BODY_${i}`,importance:3,created_at:'2020-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}));
test('each pack independently selects newest 500, not global slice then split', () => {
 const groups=consolidationGroups(rows(4000),500); assert.deepEqual(groups.map(g=>g.rows.length),[500,500,500]);
 assert.equal(new Set(groups.flatMap(g=>g.rows.map(m=>m.id))).size,1500);
});
for (const n of [700,701,1200,1201,2400,2401]) test(`sweep ${n}: balanced ABC, stable AC/AB/CB subsets and cap`,()=>{
 const plan=sweepWindows(rows(n)); assert.equal(plan.total,n);
 if(n<=700){assert.equal(plan.windows.length,1);assert.equal(plan.covered,n);return;}
 assert.deepEqual(plan.windows.map(w=>w.label),['AC','AB','CB']);
 const counts=plan.segments.map(s=>s.source_count);assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
 assert.ok(plan.windows.every(w=>w.rows.length<=1000));assert.equal(plan.covered,Math.min(n,1500));assert.equal(plan.dropped,Math.max(0,n-1500));
 for(const segment of plan.segments) for(const w of plan.windows.filter(w=>w.label.includes(segment.label))) assert.ok(segment.selected_ids.every(id=>w.rows.some(m=>m.id===id)));
 if(n<=1500){const windows=plan.windows.map(w=>new Set(w.rows.map(m=>m.id)));const all=rows(n);for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)assert.ok(windows.some(w=>w.has(all[i].id)&&w.has(all[j].id)));}
});
test('eligible excludes forgotten imported archived summary document paused',()=>{
 const all=rows(8);all[0].forgotten=true;all[1].archived=true;all[2].type='summary';all[3].type='document';all[4].source='imported';
 const result=eligible({all:()=>all,filterPaused:r=>r.filter(m=>m.id!==all[5].id)});assert.ok(!result.includes(all[0]));assert.ok(!result.includes(all[1]));assert.ok(!result.includes(all[2]));assert.ok(!result.includes(all[3]));assert.ok(!result.includes(all[4]));assert.ok(!result.includes(all[5]));
});
function fixture(n=7, handler){
 const store=createStore(':memory:');const service=createService({store,config:{},logger:{warn(){}}});
 for(const m of rows(n))service.saveWithDedupe({...m,source:'manual'});
 const calls=[];const ctx={logger:{warn(){}},llm:{async *stream(options){calls.push(options);const system=options.messages[0].content[0].text;const body=options.messages[1].content[0].text;let text=system.includes('UUID/type/updated/title')||system.includes('supplied UUID/type')?'[]':body.includes('| type=')?'[]':'overview';if(handler)text=handler({options,system,body,text,calls});yield {type:'text-delta',index:0,text};yield {type:'finish',reason:{kind:'stop'}};}}};
 const scheduler=createDreamScheduler({onRun:()=>{}});
 const run=()=>scheduler.runDream(ctx,service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',dreamMaxSnapshotSize:500,dreamMergeGuard:true});
 return {store,service,calls,run,scheduler,ctx};
}
test('grouped five logical calls, strict low all stages, summary once and persisted sweep audit',async()=>{
 const f=fixture();try{const r=await f.run();assert.equal(f.calls.length,5);assert.ok(f.calls.every(c=>c.reasoningEffort==='low'));assert.equal(r.summary,true);assert.equal(r.outcome.sweep.stages.length,1);const saved=f.store.getDreamRun(r.runId);assert.equal(saved.outcome.mode,'grouped');assert.equal(saved.outcome.groups.length,3);}finally{f.store.close();}
});
test('group failure preserves remaining groups and summary, no invented keep',async()=>{
 let count=0;const f=fixture(7,({body,text})=>body.includes('| type=')&&++count===1?'not JSON':text);try{const r=await f.run();assert.equal(r.status,'degraded');assert.equal(r.outcome.groups[0].status,'failed');assert.equal(r.outcome.groups[1].status,'ok');assert.equal(r.summary,true);}finally{f.store.close();}
});
test('metadata sweep stores full directed evidence but never applies candidate',async()=>{
 let pair;const f=fixture(7,({system,body,text})=>{if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);pair=ids.slice(0,2);assert.ok(!body.includes('FULL_BODY_'));return JSON.stringify([{a:pair[0],b:pair[1],reason:'state_replacement: title-only candidate; body review required'}]);}return text;});try{const r=await f.run();assert.equal(r.outcome.sweep.candidates.length,1);assert.ok(r.outcome.sweep.candidates[0].evidence.a.content.includes('FULL_BODY_'));assert.equal(f.service.countConflictPending(),0);assert.equal(r.applied,0);assert.ok(pair.every(id=>!f.service.getById(id).archived));}finally{f.store.close();}
});
test('701 eligible rows produce seven calls and duplicate candidates retain provenance',async()=>{
 let chosen;
 const f=fixture(701,({system,body,text})=>{if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);if(!chosen)chosen=ids.slice(0,2);if(chosen.every(id=>ids.includes(id)))return JSON.stringify([{a:chosen[0],b:chosen[1],reason:'state_replacement: title limits'}]);}return text;});
 try{const r=await f.run();assert.equal(f.calls.length,8);assert.equal(r.outcome.sweep.total,701);assert.deepEqual(r.outcome.sweep.stages.map(s=>s.label),['AC','AB','CB']);assert.equal(r.outcome.sweep.candidates.length,1);assert.ok(r.outcome.sweep.candidates[0].provenance.length>=1);}finally{f.store.close();}
});
test('per-type update budgets are independent within one pack',async()=>{
 const f=fixture(14,({body,text,system})=>{if(body.includes('| type=')&&!system.includes('UUID/type/updated/title')){const entries=[...body.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)/g)];return JSON.stringify(entries.map(m=>({action:'update',ids:[m[1]],content:'corrected original fact',reason:'partial outdated correction'})));}return text;});
 try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z',m.id);const r=await f.run();assert.equal(r.applied,14);assert.ok(!r.outcome.groups.some(g=>g.status==='failed'));}finally{f.store.close();}
});
test('cross-type consolidate conflict is auditable candidate, not queue or applied',async()=>{
 const f=fixture(7,({body,system,text})=>{if(body.includes('| type=')&&!system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);if(ids.length===2)return JSON.stringify([{action:'conflict',winner:ids[0],loser:ids[1],reason:'overlapping facts require body review'}]);}return text;});try{const r=await f.run();assert.equal(r.applied,0);assert.ok(r.outcome.cross_type_candidates.length>0);assert.equal(f.service.countConflictPending(),0);assert.ok(!r.outcome.groups.some(g=>g.error?.includes('all grouped decisions invalid')));}finally{f.store.close();}
});
test('unsupported type is retained, swept and explicitly degrades audit',async()=>{
 const f=fixture(7);f.service.saveWithDedupe({type:'pattern',title:'pattern',content:'unique pattern must stay',importance:3});try{const r=await f.run();assert.equal(r.status,'degraded');assert.equal(r.outcome.skippedUnsupportedTypes.length,1);assert.equal(r.outcome.sweep.total,8);assert.equal(r.outcome.sweep.stages[0].input_count,8);}finally{f.store.close();}
});
test('consolidate hallucination persists top-level skipped ids and error',async()=>{
 let sent=false;const f=fixture(7,({body,text})=>{if(!sent&&body.includes('| type=')){sent=true;return JSON.stringify([{action:'archive',ids:['hallucinated-id'],reason:'outdated'}]);}return text;});try{const r=await f.run();const saved=f.store.getDreamRun(r.runId);assert.ok(saved.skipped.some(s=>s.ids.includes('hallucinated-id')&&s.error&&s.stage));assert.ok(f.store.listDreamRuns()[0].skipped.length>0);}finally{f.store.close();}
});
for(const failure of ['count','save','full'])test(`freeze ${failure} failure preserves unrelated archive`,async()=>{
 const f=fixture(21,({body,system,text})=>{if(body.includes('| type=')&&!system.includes('UUID/type/updated/title')){const entries=[...body.matchAll(/id=([^\s|]+)\s*\|\s*type=(\w+)/g)].filter(m=>m[2]==='project');if(entries.length===3)return JSON.stringify([{action:'conflict',winner:entries[0][1],loser:entries[1][1],reason:'incompatible whole facts'},{action:'archive',ids:[entries[2][1]],reason:'outdated whole record'}]);}return text;});
 if(failure==='count')f.service.countConflictPending=()=>{throw new Error('queue unavailable');};else if(failure==='save')f.service.saveConflictPending=()=>{throw new Error('save unavailable');};else f.service.countConflictPending=()=>100;
 try{const r=await f.scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',conflictFreezeEnabled:true,dreamMinExplicitCoverage:0});assert.equal(r.applied,1);assert.ok(f.store.getDreamRun(r.runId).skipped.some(s=>s.action==='conflict'&&s.error.includes('queue')));}finally{f.store.close();}
});
test('summary refresh reembeds fresh overview with semantic enabled',async()=>{
 const f=fixture();const embedded=[];const vectors=[];const scheduler=createDreamScheduler({onRun:()=>{},semantic:{embedder:{embedSingle:async text=>{embedded.push(text);return [1,0];}},vectorIndex:{saveEmbedding:(id,v)=>vectors.push(id)}}});try{const r=await scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low'});const summary=f.service.all().find(m=>m.type==='summary'&&m.source==='dream');assert.equal(r.summary,true);assert.ok(embedded.some(t=>t.includes('overview')));assert.ok(vectors.includes(summary.id));}finally{f.store.close();}
});
test('explicit low rejection is not retried without effort',async()=>{
 const f=fixture(7,()=>{throw new Error('unsupported reasoning effort low');});
 try{const r=await f.run();assert.equal(r.status,'failed');assert.equal(f.calls.length,5);assert.ok(f.calls.every(c=>c.reasoningEffort==='low'));assert.equal(r.summary,false);}finally{f.store.close();}
});
test('hallucinated sweep ids rejected and never queued',async()=>{
 const f=fixture(7,({system,text})=>system.includes('UUID/type/updated/title')?'[{"a":"fake","b":"fake2","reason":"strict_conflict: no"}]':text);try{const r=await f.run();assert.equal(r.outcome.sweep.candidates.length,0);assert.equal(f.service.countConflictPending(),0);}finally{f.store.close();}
});

function adjudicationFixture(mode='conflict') {
 let pair;const f=fixture(7,({system,body,text})=>{
  if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);pair=ids.slice(0,2);return JSON.stringify([{a:pair[0],b:pair[1],reason:'strict_conflict: title recall only'}]);}
  if(system.startsWith('Full-body')){
   assert.ok(body.includes('FULL_BODY_'));const data=JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));assert.equal(data.memories.length,2);assert.ok(data.memories.every(m=>m.created_at&&m.updated_at));
   if(mode==='failure')throw new Error('mock adjudication failure');
   if(mode==='stale')f.store.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('concurrent edit',pair[1]);
   const base={pair,classification:'strict_conflict',reason:`${pair[0]} says old; ${pair[1]} says corrected; retained all unique evidence`};
   if(mode==='merge')return JSON.stringify([{...base,action:'merge',ids:pair,keepSource:pair[0],title:'bad',content:'bad'}]);
   if(mode==='fake')return JSON.stringify([{...base,action:'archive',ids:['fake']}]);
   if(mode==='partial')return JSON.stringify([{...base,classification:'partial_correction',action:'update',ids:[pair[0]],content:'corrected assertion; retained unique method age24'}]);
   if(mode==='evolution')return JSON.stringify([{...base,classification:'state_replacement',action:'archive',ids:[pair[0]]}]);
   return JSON.stringify([{...base,action:'conflict',winner:pair[0],loser:pair[1]}]);
  }return text;
 });
 return f;
}
for(const mode of ['conflict','merge','fake','partial','evolution','stale','failure'])test(`batch full-body ${mode}`,async()=>{
 const f=adjudicationFixture(mode);try{
  for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z',m.id);
  const r=await f.run();assert.equal(f.calls.length,6);assert.ok(f.calls[4].messages[0].content[0].text.startsWith('Full-body'));assert.equal(f.calls[4].reasoningEffort,'low');assert.ok(!f.calls[5].messages[0].content[0].text.startsWith('Full-body'));
  const c=r.outcome.sweep.candidates[0];
  if(mode==='conflict'){assert.equal(r.applied,1);assert.equal(c.status,'adjudicated');assert.equal(c.applied,1);assert.equal(f.service.getById(c.b).archived||f.service.getById(c.a).archived,true);assert.ok(f.store.getDreamRun(r.runId).outcome.adjudication.inputDigest);}
  else if(mode==='partial'){assert.equal(r.applied,1);assert.ok(f.service.all().some(m=>m.content.includes('retained unique method age24')));assert.ok(f.calls[5].messages[1].content[0].text.includes('retained unique method age24'));}
  else {assert.equal(r.applied,0);if(mode==='stale')assert.equal(r.status,'reconcile');if(mode==='failure'){assert.equal(r.status,'degraded');assert.equal(r.summary,true);}}
 }finally{f.store.close();}
});
for(const cross of [false,true])test(`adjudication conflict parking cross=${cross}`,async()=>{
 const f=adjudicationFixture();try{if(cross){const m=f.service.all()[0];f.store.db.prepare('UPDATE memories SET agent_scope = ? WHERE id = ?').run('other-agent',m.id);}
 const r=await f.scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',conflictFreezeEnabled:!cross});assert.equal(r.applied,0);assert.equal(f.service.countConflictPending(),1);assert.equal(r.outcome.sweep.candidates[0].status,'frozen');
 }finally{f.store.close();}
});

test('pack successful mutation claim prevents second batch mutation',async()=>{
 let changed;const f=fixture(7,({body,system,text})=>{
  if(body.includes('| type=')&&!system.includes('UUID/type/updated/title')&&!changed){changed=[...body.matchAll(/id=([^\s|]+)/g)][0][1];return JSON.stringify([{action:'update',ids:[changed],content:'pack correction',reason:'partial outdated assertion'}]);}
  if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);return JSON.stringify([{a:changed,b:ids.find(id=>id!==changed),reason:'partial_correction: title only'}]);}return text;
 });try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z',m.id);const r=await f.run();assert.equal(r.applied,1);assert.equal(f.calls.length,5);assert.equal(r.outcome.sweep.candidates[0].unapplied_reason,'claimed_this_run');}finally{f.store.close();}
});
test('oversize full bodies defer complete pair without extra call or truncation',async()=>{
 const f=adjudicationFixture();try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('X'.repeat(100000),m.id);const r=await f.run();assert.equal(f.calls.length,5);assert.equal(r.outcome.sweep.candidates[0].unapplied_reason,'deferred_budget');assert.equal(r.outcome.sweep.candidates[0].evidence.a.content.length,100000);}finally{f.store.close();}
});
test('shared endpoints apply once and cumulative pertype budget blocks separate targets',async()=>{
 let pairs;const f=fixture(21,({system,body,text})=>{
  if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);const all=f.service.all();const projects=all.filter(m=>m.type==='project').map(m=>m.id);const other=all.find(m=>m.type==='decision').id;pairs=projects.map(a=>[a,other]);return JSON.stringify(pairs.map(([a,b])=>({a,b,reason:'partial_correction: titles only'})));}
  if(system.startsWith('Full-body'))return JSON.stringify(pairs.map(pair=>({pair,classification:'partial_correction',action:'update',ids:[pair[0]],content:'unique retained correction',reason:`${pair[0]} original evidence and ${pair[1]} specific correction`})).concat([{pair:pairs[0],classification:'partial_correction',action:'update',ids:[pairs[0][0]],content:'second bad edit',reason:`${pairs[0][0]} and ${pairs[0][1]}`} ]));return text;
 });try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z',m.id);const r=await f.scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',reflectionUpdateMaxPerRun:1});assert.equal(r.applied,1);assert.equal(r.outcome.budgets.project.update,1);assert.ok(r.outcome.adjudication.skipped.some(s=>s.error.includes('too many update')));assert.ok(r.outcome.adjudication.skipped.some(s=>s.error.includes('claimed_this_run')));}finally{f.store.close();}
});

test('adjudication failure preserves successful pack commit and final summary',async()=>{
 let changed;const f=fixture(7,({system,body,text})=>{
 if(system.startsWith('Full-body'))throw new Error('batch unavailable');
 if(body.includes('| type=')&&!system.includes('UUID/type/updated/title')&&!changed){changed=[...body.matchAll(/id=([^\s|]+)/g)][0][1];return JSON.stringify([{action:'update',ids:[changed],content:'surviving pack correction',reason:'outdated assertion'}]);}
 if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]).filter(id=>id!==changed);return JSON.stringify([{a:ids[0],b:ids[1],reason:'partial_correction: metadata'}]);}return text;
 });try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z',m.id);const r=await f.run();assert.equal(r.applied,1);assert.equal(r.status,'degraded');assert.equal(r.summary,true);assert.equal(f.service.getById(changed).content,'surviving pack correction');assert.ok(f.calls.at(-1).messages[1].content[0].text.includes('surviving pack correction'));}finally{f.store.close();}
});
test('young partial correction stays intact under native age24 guard',async()=>{
 const f=adjudicationFixture('partial');try{const r=await f.run();assert.equal(r.applied,0);assert.ok(r.outcome.adjudication.skipped.some(s=>s.error.includes('too young')));}finally{f.store.close();}
});
test('post adjudication index embeds changed body before summary',async()=>{
 const f=adjudicationFixture('partial'),embedded=[];try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z',m.id);const scheduler=createDreamScheduler({onRun:()=>{},semantic:{embedder:{embedSingle:async text=>{embedded.push(text);return [1,0];}},vectorIndex:{saveEmbedding(){},deleteEmbedding(){}}}});const r=await scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low'});assert.equal(r.applied,1);assert.ok(embedded.some(t=>t.includes('retained unique method age24')));assert.ok(embedded.at(-1).includes('overview'));}finally{f.store.close();}
});
test('freeze queue error remains audited without auto fallback',async()=>{
 const f=adjudicationFixture();f.service.saveConflictPending=()=>{throw new Error('queue offline');};try{const r=await f.scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',conflictFreezeEnabled:true});assert.equal(r.applied,0);assert.equal(r.outcome.sweep.candidates[0].status,'failed');assert.ok(f.store.getDreamRun(r.runId).skipped.some(s=>s.error.includes('queue')));}finally{f.store.close();}
});

for(const action of ['archive','update'])test(`strict conflict ${action} cannot bypass freeze`,async()=>{
 const f=adjudicationFixture();const original=f.ctx.llm.stream;f.ctx.llm.stream=async function*(options){if(options.messages[0].content[0].text.startsWith('Full-body')){f.calls.push(options);const body=options.messages[1].content[0].text;const data=JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1)),pair=[data.candidates[0].a,data.candidates[0].b];yield {type:'text-delta',index:0,text:JSON.stringify([{action,ids:[pair[0]],pair,classification:'strict_conflict',reason:`${pair[0]} versus ${pair[1]}`,content:'replacement'}])};yield {type:'finish',reason:{kind:'stop'}};}else yield* original(options);};
 try{const r=await f.scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',conflictFreezeEnabled:true});assert.equal(r.applied,0);assert.ok(r.outcome.adjudication.skipped.some(s=>s.error.includes('freeze_enabled')));}finally{f.store.close();}
});
test('audit byte count matches actual sent system plus fenced user prompt',async()=>{
 const f=adjudicationFixture('partial');try{const r=await f.run();const request=f.calls[4];const bytes=Buffer.byteLength(request.messages.map(m=>m.content[0].text).join(''),'utf8');assert.equal(r.outcome.adjudication.prompt_bytes,bytes);assert.ok(bytes<=98304);}finally{f.store.close();}
});

test('archive budget consumed in pack prevents later same-type archive',async()=>{
 let archived,target,pair;const f=fixture(14,({system,body,text})=>{
 if(system.startsWith('Full-body'))return JSON.stringify([{action:'archive',ids:[target],pair,classification:'strict_conflict',reason:`${pair[0]} original duplicate versus ${pair[1]} retained evidence`}]);
 if(body.includes('| type=')&&!system.includes('UUID/type/updated/title')&&!archived){const projects=[...body.matchAll(/id=([^\s|]+)\s*\|\s*type=project/g)].map(m=>m[1]);archived=projects[0];target=projects[1];return JSON.stringify([{action:'archive',ids:[archived],reason:'outdated whole entry'}]);}
 if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);pair=[target,ids.find(id=>id!==target&&f.service.getById(id).type!=='project')];return JSON.stringify([{a:pair[0],b:pair[1],reason:'strict_conflict: title only'}]);}return text;
 });try{const r=await f.scheduler.runDream(f.ctx,f.service,{dreamConsolidationMode:'grouped',dreamProvider:'mock',dreamModel:'sol',dreamReasoningEffort:'low',dreamMaxArchivePerRun:1});assert.equal(r.applied,1);assert.equal(f.service.getById(target).archived,false);assert.ok(r.outcome.adjudication.skipped.some(s=>s.error.includes('too many archive')));}finally{f.store.close();}
});
test('full-input id outside linked candidate relation cannot be targeted',async()=>{
 let pairs;const f=fixture(7,({system,body,text})=>{
 if(system.includes('UUID/type/updated/title')){const ids=[...body.matchAll(/id=([^\s|]+)/g)].map(m=>m[1]);pairs=[[ids[0],ids[1]],[ids[2],ids[3]]];return JSON.stringify(pairs.map(([a,b])=>({a,b,reason:'strict_conflict: metadata'})));}
 if(system.startsWith('Full-body'))return JSON.stringify([{action:'archive',ids:[pairs[1][0]],pair:pairs[0],classification:'strict_conflict',reason:`${pairs[0][0]} versus ${pairs[0][1]}`}]);return text;
 });try{const r=await f.run();assert.equal(r.applied,0);assert.ok(r.outcome.adjudication.skipped.some(s=>s.error.includes('candidate relation')));}finally{f.store.close();}
});

test('near byte cap retains whole bodies and measures fenced actual request',async()=>{
 const f=adjudicationFixture();try{for(const m of f.service.all())f.store.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('FULL_BODY_'+ 'X'.repeat(45000),m.id);const r=await f.run();const a=r.outcome.adjudication;assert.ok(a.prompt_bytes>90000&&a.prompt_bytes<=98304);assert.equal(a.input.memories[0].content.length,45010);const req=f.calls[4];assert.equal(a.prompt_bytes,Buffer.byteLength(req.messages.map(m=>m.content[0].text).join('')));}finally{f.store.close();}
});
