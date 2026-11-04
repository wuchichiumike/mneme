// WP2 台账四态 + 白卷批级重试（设计文档 §4.2/§4.3/§7，测试清单 §10 第 5/6/7/8 条）。
// 时间一律注入 FIXED 毫秒基准，测试内不 sleep。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDreamScheduler } from '../src/dream.js';
import { createStore } from '../src/store.js';
import { Config } from '../src/config.js';
import { createService } from '../src/service.js';
import { recordLedger, classifyLedgerReject } from '../src/dream/adjudication.js';
import { strictHashOf, contentHashOf } from '../src/content-hash.js';

const DAY = 24 * 60 * 60 * 1000;
const types = ['project', 'history', 'decision', 'constraint', 'pitfall', 'preference', 'rejected_solution'];
const rows = n => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0'), type: types[i % 7], title: `title ${i}`, content: `FULL_BODY_${i}`, importance: 3, created_at: '2020-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));

function fixture(n, runConfig, handler) {
 const FIXED = Date.now();
 const store = createStore(':memory:'); const service = createService({ store, config: {}, logger: { warn() {} } });
 for (const m of rows(n)) service.saveWithDedupe({ ...m, source: 'manual' });
 const calls = [];
 const ctx = { logger: { warn() {} }, llm: { async *stream(options) { calls.push(options); const system = options.messages[0].content[0].text; const body = options.messages[1].content[0].text; let text = system.includes('UUID/type/updated/title') || system.includes('supplied UUID/type') ? '[]' : body.includes('| type=') ? '[]' : 'overview'; if (handler) text = handler({ options, system, body, text, calls }); yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
 const scheduler = createDreamScheduler({ onRun: () => {}, now: () => FIXED });
 const run = () => scheduler.runDream(ctx, service, { dreamConsolidationMode: 'grouped', dreamProvider: 'mock', dreamModel: 'sol', dreamReasoningEffort: 'low', ...runConfig });
 return { store, service, calls, run, scheduler, ctx, FIXED };
}
// 扫到候选对后送全文裁决的骨架（同 dream-grouped.test.js 的 adjudicationFixture）。
function adjudicationFixture(runConfig, decide) {
 const f = fixture(7, runConfig, ({ system, body, text }) => {
  if (system.includes('UUID/type/updated/title')) { const ids = [...body.matchAll(/id=([^\s|]+)/g)].map(m => m[1]); f.pair = ids.slice(0, 2); return JSON.stringify([{ a: f.pair[0], b: f.pair[1], reason: 'strict_conflict: title recall only' }]); }
  if (system.startsWith('Full-body')) {
   const data = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
   const pair = [data.candidates[0].a, data.candidates[0].b];
   return decide({ f, pair, n: (f.adjudicateCalls = (f.adjudicateCalls ?? 0) + 1) });
  }
  return text;
 });
 return f;
}
const aged = f => { for (const m of f.service.all()) f.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', m.id); };
const keyOf = c => [c.a, c.b].sort().join(':');

test('config: dreamLedgerExtended defaults false and rejects non-boolean', () => {
 assert.equal(Config({}).dreamLedgerExtended, false);
 assert.equal(Config({ dreamLedgerExtended: true }).dreamLedgerExtended, true);
 assert.throws(() => Config({ dreamLedgerExtended: 'yes' }));
});

test('classifyLedgerReject maps §4.2 guardrail strings, ignores the rest', () => {
 assert.deepEqual(classifyLedgerReject('cross_scope mutation parked'), { kind: 'permanent', guard: 'permanent:cross_scope' });
 assert.deepEqual(classifyLedgerReject('0: merge ids span multiple types (project, preference)'), { kind: 'permanent', guard: 'permanent:cross_type_merge' });
 assert.deepEqual(classifyLedgerReject('0: archive of long-retention type(s) constraint needs a duplicate/outdated rationale'), { kind: 'permanent', guard: 'permanent:long_retention_archive' });
 assert.deepEqual(classifyLedgerReject('0: memory too young (< 24h)'), { kind: 'temporary', fail_reason: 'too_young' });
 assert.deepEqual(classifyLedgerReject('too many archive decisions: 9 > 8'), { kind: 'temporary', fail_reason: 'archive_budget' });
 assert.deepEqual(classifyLedgerReject('cumulative pertype archive budget includes conflict loser'), { kind: 'temporary', fail_reason: 'archive_budget' });
 assert.deepEqual(classifyLedgerReject('claimed_this_run'), { kind: 'temporary', fail_reason: 'claimed_this_run' });
 assert.equal(classifyLedgerReject('invalid exact id whitelist, candidate relation, action, classification or evidence references'), null);
 assert.equal(classifyLedgerReject('supersede_time_order: winner must not precede loser'), null);
});

// §10-5：被 too-young 拒 → 台账 guard_rejected、cooldown=+24h、fail_count=1。
test('§10-5 too-young rejection records guard_rejected with 24h cooldown', async () => {
 const f = adjudicationFixture({ dreamLedgerExtended: true }, ({ pair }) => JSON.stringify([{ pair, classification: 'partial_correction', action: 'update', ids: [pair[0]], content: 'corrected assertion; retained unique method', reason: `${pair[0]} says old; ${pair[1]} says corrected` }]));
 try {
  const r = await f.run();
  assert.equal(r.applied, 0);
  assert.ok(r.outcome.adjudication.skipped.some(s => s.error.includes('too young')));
  const rec = f.service.getConflictResolution(keyOf(r.outcome.sweep.candidates[0]));
  assert.ok(rec, 'ledger row written');
  assert.equal(rec.verdict, 'guard_rejected');
  assert.equal(rec.fail_reason, 'too_young');
  assert.equal(rec.fail_count, 1);
  assert.equal(rec.needs_human, 0);
  assert.equal(rec.cooldown_until, new Date(f.FIXED + DAY).toISOString());
  assert.equal(rec.strict_hash_a, strictHashOf(f.service.getById(rec.id_a)));
  assert.equal(rec.strict_hash_b, strictHashOf(f.service.getById(rec.id_b)));
 } finally { f.store.close(); }
});

// §10-6：cross_scope parked → verdict=keep + guard=permanent:cross_scope；同对再提名 → 跳过送审。
test('§10-6 permanent cross_scope guard lands as keep+guard and skips next review', async () => {
 let scopePair;
 const f = fixture(7, { dreamLedgerExtended: true }, ({ system, body, text }) => {
  if (system.includes('UUID/type/updated/title')) { const [a, b] = scopePair; return JSON.stringify([{ a, b, reason: 'strict_conflict: title recall only' }]); }
  if (system.startsWith('Full-body')) { const data = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); const pair = [data.candidates[0].a, data.candidates[0].b]; return JSON.stringify([{ pair, classification: 'partial_correction', action: 'update', ids: [pair[0]], content: 'corrected assertion', reason: `${pair[0]} versus ${pair[1]} correction` }]); }
  return text;
 });
 try {
  // 候选对里一方改到另一 agent_scope → 非 keep 改动应被 parked 并入册为永久护栏。
  const all = f.service.all();
  scopePair = [all.find(m => m.type === 'project').id, all.find(m => m.type === 'history').id];
  f.store.db.prepare('UPDATE memories SET agent_scope = ? WHERE id = ?').run('other-agent', scopePair[0]);
  aged(f);
  const r1 = await f.run();
  assert.equal(r1.applied, 0);
  const c1 = r1.outcome.sweep.candidates[0];
  assert.equal(c1.status, 'skipped');
  assert.equal(c1.unapplied_reason, 'cross_scope');
  const rec = f.service.getConflictResolution(keyOf(c1));
  assert.equal(rec.verdict, 'keep');
  assert.equal(rec.guard, 'permanent:cross_scope');
  assert.equal(rec.fail_count, 0);
  assert.equal(rec.cooldown_until, null);
  const callsAfter1 = f.calls.length;
  const r2 = await f.run();
  const c2 = r2.outcome.sweep.candidates[0];
  assert.equal(c2.status, 'resolved_keep');
  assert.equal(r2.outcome.sweep.resolved_keep_skipped, 1);
  assert.equal(r2.outcome.sweep.candidates.length, 1);
  // 第二次运行没有新的 Full-body 裁决调用（跳过送审 = 零裁决请求）。
  assert.equal(f.calls.slice(callsAfter1).filter(c => c.messages[0].content[0].text.startsWith('Full-body')).length, 0);
 } finally { f.store.close(); }
});

// §10-7a：第一次白卷 → medium 重试；第二次正常 → 结果被应用，台账记 applied。
test('§10-7 blank batch retries once at medium and the second result replaces the first', async () => {
 const f = adjudicationFixture({ dreamLedgerExtended: true }, ({ pair, n }) => n === 1
  ? JSON.stringify([{ pair: ['fake-a', 'fake-b'], action: 'archive', ids: ['fake-a'], classification: 'strict_conflict', reason: 'unrelated ids' }])
  : JSON.stringify([{ pair, action: 'conflict', winner: pair[0], loser: pair[1], classification: 'strict_conflict', reason: `${pair[0]} versus ${pair[1]} incompatible whole facts` }]));
 try {
  aged(f);
  const r = await f.run();
  const adjudicate = f.calls.filter(c => c.messages[0].content[0].text.startsWith('Full-body'));
  assert.equal(adjudicate.length, 2);
  assert.equal(adjudicate[0].reasoningEffort, 'low');
  assert.equal(adjudicate[1].reasoningEffort, 'medium');
  assert.equal(r.applied, 1);
  assert.deepEqual(r.outcome.adjudication.blank_retry, { first_invalid: 1, second_invalid: null, effort: 'medium' });
  const rec = f.service.getConflictResolution(keyOf(r.outcome.sweep.candidates[0]));
  assert.equal(rec.verdict, 'applied');
  assert.equal(rec.fail_count, 0);
 } finally { f.store.close(); }
});

// §10-7b：重试仍白卷 → 整批 invalid + 24h 冷却；冷却期内同对跳过（ledger_cooling）。
test('§10-7 second blank marks batch invalid with cooldown, cooling pairs skip next run', async () => {
 const f = adjudicationFixture({ dreamLedgerExtended: true }, () => JSON.stringify([{ pair: ['fake-a', 'fake-b'], action: 'archive', ids: ['fake-a'], classification: 'strict_conflict', reason: 'unrelated ids' }]));
 try {
  const r1 = await f.run();
  const adjudicate1 = f.calls.filter(c => c.messages[0].content[0].text.startsWith('Full-body'));
  assert.equal(adjudicate1.length, 2);
  const c1 = r1.outcome.sweep.candidates[0];
  assert.equal(c1.status, 'skipped');
  assert.equal(c1.unapplied_reason, 'blank_batch_cooldown');
  assert.deepEqual(r1.outcome.adjudication.blank_retry, { first_invalid: 1, second_invalid: 1, effort: 'medium' });
  assert.equal(r1.applied, 0);
  const rec = f.service.getConflictResolution(keyOf(c1));
  assert.equal(rec.verdict, 'invalid');
  assert.equal(rec.fail_reason, 'blank_batch');
  assert.equal(rec.fail_count, 1);
  assert.equal(rec.cooldown_until, new Date(f.FIXED + DAY).toISOString());
  const callsAfter1 = f.calls.length;
  const r2 = await f.run();
  const c2 = r2.outcome.sweep.candidates[0];
  assert.equal(c2.status, 'ledger_cooling');
  assert.equal(r2.outcome.sweep.ledger_cooling_skipped, 1);
  assert.equal(f.calls.slice(callsAfter1).filter(c => c.messages[0].content[0].text.startsWith('Full-body')).length, 0);
  // 冷却跳过不算降级噪音：不进 adjudicationSkipped。
  assert.ok(!r2.outcome.adjudication.skipped.some(s => s.error === 'blank_batch_cooldown'));
 } finally { f.store.close(); }
});

// §10-8：同一 fail_reason 连续 3 次 → needs_human=1、cooldown=+7d；keep 清零。
test('§10-8 third consecutive same-reason write escalates to needs_human with 7d cooldown', () => {
 const FIXED = Date.now();
 const store = createStore(':memory:'); const service = createService({ store, config: {}, logger: { warn() {} } });
 const memA = { id: 'm1', title: 'A', content: 'alpha fact', updated_at: '2020-01-01T00:00:00Z' };
 const memB = { id: 'm2', title: 'B', content: 'beta fact', updated_at: '2020-01-01T00:00:00Z' };
 const rowsMap = new Map([[memA.id, memA], [memB.id, memB]]);
 const base = { service, rows: rowsMap, pair: [memB.id, memA.id], now: FIXED };
 try {
  recordLedger({ ...base, verdict: 'guard_rejected', fail_reason: 'too_young', cooldown_ms: DAY });
  let rec = service.getConflictResolution('m1:m2');
  assert.equal(rec.fail_count, 1); assert.equal(rec.needs_human, 0);
  assert.equal(rec.cooldown_until, new Date(FIXED + DAY).toISOString());
  assert.equal(rec.hash_a, contentHashOf(memA), 'legacy content hash 口径不变');
  recordLedger({ ...base, verdict: 'guard_rejected', fail_reason: 'too_young', cooldown_ms: DAY });
  rec = service.getConflictResolution('m1:m2');
  assert.equal(rec.fail_count, 2); assert.equal(rec.needs_human, 0);
  recordLedger({ ...base, verdict: 'guard_rejected', fail_reason: 'too_young', cooldown_ms: DAY });
  rec = service.getConflictResolution('m1:m2');
  assert.equal(rec.fail_count, 3); assert.equal(rec.needs_human, 1);
  assert.equal(rec.cooldown_until, new Date(FIXED + 7 * DAY).toISOString());
  // 换原因 → 计数回到 1。
  recordLedger({ ...base, verdict: 'invalid', fail_reason: 'blank_batch', cooldown_ms: DAY });
  rec = service.getConflictResolution('m1:m2');
  assert.equal(rec.fail_count, 1); assert.equal(rec.needs_human, 0);
  assert.equal(rec.verdict, 'invalid');
  // keep → 清零。
  recordLedger({ ...base, verdict: 'keep', relation: 'strict_conflict', reason: 'both retained' });
  rec = service.getConflictResolution('m1:m2');
  assert.equal(rec.verdict, 'keep'); assert.equal(rec.fail_count, 0);
  assert.equal(rec.fail_reason, null); assert.equal(rec.cooldown_until, null); assert.equal(rec.needs_human, 0);
  assert.equal(rec.strict_hash_a, strictHashOf(memA));
  assert.equal(rec.strict_hash_b, strictHashOf(memB));
 } finally { store.close(); }
});

// 开关关 = 现行行为不变：too-young 不落台账、白卷不重试、显式 keep 照旧落账（带严格哈希）。
test('switch off preserves current ledger behavior', async () => {
 const young = adjudicationFixture({}, ({ pair }) => JSON.stringify([{ pair, classification: 'partial_correction', action: 'update', ids: [pair[0]], content: 'corrected assertion', reason: `${pair[0]} old; ${pair[1]} corrected` }]));
 try {
  const r = await young.run();
  assert.equal(r.applied, 0);
  assert.ok(r.outcome.adjudication.skipped.some(s => s.error.includes('too young')));
  assert.equal(young.service.getConflictResolution(keyOf(r.outcome.sweep.candidates[0])), undefined, 'no ledger row for guard rejects when off');
  assert.equal(r.outcome.sweep.ledger_cooling_skipped, undefined);
 } finally { young.store.close(); }
 const blank = adjudicationFixture({}, () => JSON.stringify([{ pair: ['fake-a', 'fake-b'], action: 'archive', ids: ['fake-a'], classification: 'strict_conflict', reason: 'unrelated ids' }]));
 try {
  const r = await blank.run();
  const adjudicate = blank.calls.filter(c => c.messages[0].content[0].text.startsWith('Full-body'));
  assert.equal(adjudicate.length, 1, 'no medium retry when off');
  assert.equal(adjudicate[0].reasoningEffort, 'low');
  assert.equal(r.outcome.adjudication.blank_retry, undefined);
  assert.equal(r.outcome.sweep.candidates[0].unapplied_reason, 'omitted_no_mutation_not_resolution');
  assert.equal(blank.service.getConflictResolution(keyOf(r.outcome.sweep.candidates[0])), undefined);
 } finally { blank.store.close(); }
 const keep = adjudicationFixture({}, ({ pair }) => JSON.stringify([{ pair, classification: 'uncertain', action: 'keep', ids: [pair[0], pair[1]], reason: `${pair[0]} and ${pair[1]} both stand, no mutation` }]));
 try {
  const r = await keep.run();
  const rec = keep.service.getConflictResolution(keyOf(r.outcome.sweep.candidates[0]));
  assert.ok(rec, 'explicit keep still lands in ledger');
  assert.equal(rec.verdict, 'keep');
  assert.ok(rec.strict_hash_a && rec.strict_hash_b, 'strict hashes written unconditionally');
  assert.equal(rec.guard, null);
 } finally { keep.store.close(); }
});

// 台账命中后正文严格哈希变化 → 失配重审（§4.3 hashOk）。
test('ledger cooling skip requires hash match; content change re-adjudicates', async () => {
 const f = adjudicationFixture({ dreamLedgerExtended: true }, () => JSON.stringify([{ pair: ['fake-a', 'fake-b'], action: 'archive', ids: ['fake-a'], classification: 'strict_conflict', reason: 'unrelated ids' }]));
 try {
  const r1 = await f.run();
  const key = keyOf(r1.outcome.sweep.candidates[0]);
  assert.equal(f.service.getConflictResolution(key).verdict, 'invalid');
  f.store.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('FULL_BODY_changed body text', r1.outcome.sweep.candidates[0].a);
  const callsAfter1 = f.calls.length;
  const r2 = await f.run();
  const c2 = r2.outcome.sweep.candidates.find(c => `${c.a}:${c.b}` === key);
  assert.notEqual(c2.status, 'ledger_cooling', 'hash changed → cooling no longer applies');
  assert.ok(f.calls.slice(callsAfter1).some(c => c.messages[0].content[0].text.startsWith('Full-body')));
 } finally { f.store.close(); }
});
