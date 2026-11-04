// WP4：365 天确定性归档（设计文档 §6，测试清单 §10 第 11 条 + §8「不占归档预算」
// + 任务追加：纯归档轮 status=ok、归档行不进增量选窗统计）。
// 时间一律注入（createDreamScheduler({now})），测试内不 sleep；改 updated_at 走
// store.db.prepare（test/dream.test.js 同款先例）。saveWithDedupe 会 mint 新
// UUID → 用 title 锚定行 id（id(title) 解析）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDreamScheduler } from '../src/dream.js';
import { createStore } from '../src/store.js';
import { Config } from '../src/config.js';
import { createService } from '../src/service.js';
import { eligible } from '../src/dream/grouped.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
const iso = ms => new Date(ms).toISOString();
const types = ['project', 'history', 'decision', 'constraint', 'pitfall', 'preference', 'rejected_solution'];
const rows = n => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0'), type: types[i % 7], title: `title ${i}`, content: `FULL_BODY_${i}`, importance: 3, created_at: '2020-01-01T00:00:00Z', updated_at: iso(T0) }));

// 默认桩：整理/扫描/裁决全部返回空数组、summary 返回空文本 → 除被测机制外零副作用
// （summaryStored=false，纯归档轮的 status 完全由 applied 决定）。调用识别口径同
// test/incremental-review.test.js：sweep 系统提示含 'UUID/type/updated/title'、
// 裁决含 'supplied UUID/type'、整理线载荷带 '| type='，其余 = summary。
function fixture(n, runConfig) {
  const store = createStore(':memory:'); const service = createService({ store, config: {}, logger: { warn() {} } });
  for (const m of rows(n)) service.saveWithDedupe({ ...m, source: 'manual' });
  const calls = [];
  const ctx = { logger: { warn() {} }, llm: { async *stream(options) { calls.push(options); const system = options.messages[0].content[0].text, body = options.messages[1].content[0].text; const isLlmJson = system.includes('UUID/type/updated/title') || system.includes('supplied UUID/type') || body.includes('| type='); yield { type: 'text-delta', index: 0, text: isLlmJson ? '[]' : '' }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  const scheduler = createDreamScheduler({ onRun: () => {}, now: () => T0 });
  const run = () => scheduler.runDream(ctx, service, { dreamConsolidationMode: 'grouped', dreamProvider: 'mock', dreamModel: 'sol', dreamReasoningEffort: 'low', ...runConfig });
  const id = title => store.db.prepare('SELECT id FROM memories WHERE title = ?').get(title).id;
  const age = (title, ms) => store.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(iso(ms), id(title));
  return { store, service, calls, run, id, age };
}
const sentIds = f => f.calls.flatMap(c => [...c.messages[1].content[0].text.matchAll(/id=([^\s|]+)/g)].map(m => m[1]));

test('config: aged archive keys default 0/50 and validate ranges', () => {
  assert.equal(Config({}).dreamAgedArchiveDays, 0);
  assert.equal(Config({}).dreamAgedArchiveMaxPerRun, 50);
  assert.equal(Config({ dreamAgedArchiveDays: 365, dreamAgedArchiveMaxPerRun: 2 }).dreamAgedArchiveMaxPerRun, 2);
  for (const v of [3651, -1, '365']) assert.throws(() => Config({ dreamAgedArchiveDays: v }));
  for (const v of [0, 501, '50']) assert.throws(() => Config({ dreamAgedArchiveMaxPerRun: v }));
});

// §10-11 主路径：366 天前的行 → archived=1、正文不变、outcome.aged_archive 有记录、
// decisions 落确定性条目；同轮 364 天前的行不动。纯归档轮 applied=1 → status=ok。
test('row aged 366d archives with unchanged body and a full audit trail; 364d row is untouched', async () => {
  const f = fixture(2, { dreamAgedArchiveDays: 365 });
  try {
    f.age('title 0', T0 - 366 * DAY);
    f.age('title 1', T0 - 364 * DAY);
    const r = await f.run();
    assert.equal(r.status, 'ok', 'archive counts applied → pure-archive round is ok, not noop');
    assert.equal(r.applied, 1);
    const a = r.outcome.aged_archive;
    assert.deepEqual(Object.keys(a), ['days', 'cutoff', 'ids', 'count', 'capped', 'records']);
    assert.equal(a.days, 365);
    assert.equal(a.cutoff, iso(T0 - 365 * DAY));
    assert.deepEqual(a.ids, [f.id('title 0')]);
    assert.equal(a.count, 1);
    assert.equal(a.capped, false);
    // 正文与标题逐字不变，只动 archived/archived_at。
    const row0 = f.service.getById(f.id('title 0'));
    assert.equal(row0.archived, true);
    assert.equal(row0.title, 'title 0');
    assert.equal(row0.content, 'FULL_BODY_0');
    assert.ok(Number.isFinite(Date.parse(row0.archived_at)), 'archived_at stamped');
    // 可追溯：records 带归档前 evidence（含旧 updated_at 与正文）+ 归档时刻。
    assert.equal(a.records.length, 1);
    assert.equal(a.records[0].id, f.id('title 0'));
    assert.equal(a.records[0].evidence.content, 'FULL_BODY_0');
    assert.equal(a.records[0].evidence.updated_at, iso(T0 - 366 * DAY));
    assert.ok(Number.isFinite(Date.parse(a.records[0].archived_at)));
    // decisions 审计（经 dream_runs 落库回读）。
    const run = f.service.getDreamRun(r.runId);
    assert.deepEqual(run.decisions, [{ action: 'archive', ids: [f.id('title 0')], reason: 'aged_archive: updated_at>=365d', source: 'deterministic' }]);
    // 364 天前的行不动。
    assert.equal(f.service.getById(f.id('title 1')).archived, false);
    // 归档动作本身零 LLM 调用、零预算：归档行在开跑前就退出 eligible，
    // 不出现在任何一轮载荷里。
    assert.ok(!sentIds(f).includes(f.id('title 0')), 'archived row never reaches the model');
  } finally { f.store.close(); }
});

// §10-11 上限：3 条超龄行、MaxPerRun=2 → 只归最旧 2 条（updated_at 升序），capped=true。
test('per-run cap keeps the oldest rows first and flags capped', async () => {
  const f = fixture(3, { dreamAgedArchiveDays: 365, dreamAgedArchiveMaxPerRun: 2 });
  try {
    f.age('title 0', T0 - 380 * DAY);
    f.age('title 1', T0 - 400 * DAY);
    f.age('title 2', T0 - 390 * DAY);
    const r = await f.run();
    const a = r.outcome.aged_archive;
    assert.equal(a.capped, true);
    assert.equal(a.count, 2);
    assert.deepEqual(a.ids, [f.id('title 1'), f.id('title 2')], 'ascending updated_at: 400d then 390d');
    assert.equal(f.service.getById(f.id('title 1')).archived, true);
    assert.equal(f.service.getById(f.id('title 2')).archived, true);
    assert.equal(f.service.getById(f.id('title 0')).archived, false, '380d row waits for the next ignition');
  } finally { f.store.close(); }
});

// §10-11 恢复：archiveMemory(id,false)（service 出口名 setArchived）把行放回活跃面。
test('setArchived(id,false) restores the aged row to the eligible set', async () => {
  const f = fixture(1, { dreamAgedArchiveDays: 365 });
  try {
    f.age('title 0', T0 - 366 * DAY);
    const r = await f.run();
    assert.equal(r.outcome.aged_archive.count, 1);
    assert.equal(eligible(f.service).length, 0, 'archived row left eligible');
    const restored = f.service.setArchived(f.id('title 0'), false);
    assert.equal(restored.archived, false);
    assert.equal(restored.content, 'FULL_BODY_0', 'restore keeps the body intact');
    assert.deepEqual(eligible(f.service).map(m => m.id), [f.id('title 0')]);
  } finally { f.store.close(); }
});

// days=0（默认关）：完全不动——366 天前的行保持活跃、outcome 无 aged_archive 块、
// decisions 无确定性条目（关 = 逐字节现状）。
test('days=0 leaves everything untouched and emits no audit block', async () => {
  const f = fixture(2, {});
  try {
    f.age('title 0', T0 - 366 * DAY);
    f.age('title 1', T0 - 400 * DAY);
    const r = await f.run();
    assert.equal(r.outcome.aged_archive, undefined);
    assert.equal(r.applied, 0);
    assert.equal(r.status, 'noop', 'no archive, no summary → the noop status is preserved byte-for-byte');
    assert.equal(f.service.getById(f.id('title 0')).archived, false);
    assert.equal(f.service.getById(f.id('title 1')).archived, false);
    assert.deepEqual(f.service.getDreamRun(r.runId).decisions, []);
  } finally { f.store.close(); }
});

// §8：归档不占每类型 ≤8 的 LLM 归档预算——dreamMaxArchivePerRun=1 时确定性归档
// 3 条照归，outcome.budgets 零记录（budget 只被 LLM 决定的 account() 写入）。
test('aged archive runs on its own budget, not the per-type LLM archive budget', async () => {
  const f = fixture(3, { dreamAgedArchiveDays: 365, dreamMaxArchivePerRun: 1 });
  try {
    for (const [i, t] of ['title 0', 'title 1', 'title 2'].entries()) f.age(t, T0 - (366 + i) * DAY);
    const r = await f.run();
    assert.equal(r.outcome.aged_archive.count, 3);
    assert.deepEqual(r.outcome.budgets, {}, 'deterministic archive never touches the LLM budget map');
  } finally { f.store.close(); }
});

// 先归档、后取 eligible：归档行不进增量选窗的 due/notDue/sunk 统计，也不写
// review_state（首轮 = 全量兜底，到期数只数幸存者）。
test('archived rows are excluded from the incremental due/notDue/sunk tallies', async () => {
  const f = fixture(3, { dreamAgedArchiveDays: 365, dreamIncrementalReview: true });
  try {
    f.age('title 0', T0 - 366 * DAY);
    const r = await f.run();
    assert.equal(r.outcome.aged_archive.count, 1);
    assert.deepEqual(r.outcome.incremental.due, { consolidation: 2, sweep: 2 }, 'only the two survivors are due');
    assert.deepEqual(r.outcome.incremental.not_due, { consolidation: 0, sweep: 0 });
    assert.deepEqual(r.outcome.incremental.sunk_now, { consolidation: 0, sweep: 0 });
    for (const lane of ['consolidation', 'sweep']) {
      const st = f.service.getReviewStates(lane);
      assert.equal(st.size, 2);
      assert.ok(!st.has(f.id('title 0')), 'archived row has no review_state entry');
    }
    assert.ok(!sentIds(f).includes(f.id('title 0')), 'archived row appears in no LLM payload');
  } finally { f.store.close(); }
});
