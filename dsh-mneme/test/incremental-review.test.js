// WP3 增量送审：两条线阶梯选窗 + BM25 邻居陪绑 + 7 天全量兜底
// （设计文档 §3.2/§3.3/§5/§8/§9，测试清单 §10 第 4/9/10/13/14 条 + 首次点火/
// 到期窗重点火/决定即 hold）。时间一律注入（createDreamScheduler({now})，
// 已由 dream.js 透传进 runGroupedDream 的 helpers.now），测试内不 sleep。
// saveWithDedupe 会 mint 新 UUID → 用 title 锚定行 id（id(title) 解析）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDreamScheduler } from '../src/dream.js';
import { createStore } from '../src/store.js';
import { Config } from '../src/config.js';
import { createService } from '../src/service.js';
import { strictHashOf } from '../src/content-hash.js';
import { jitterOf, LADDERS } from '../src/dream/review-ladder.js';
import { consolidationGroups, eligible } from '../src/dream/grouped.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
const types = ['project', 'history', 'decision', 'constraint', 'pitfall', 'preference', 'rejected_solution'];
const rows = n => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0'), type: types[i % 7], title: `title ${i}`, content: `FULL_BODY_${i}`, importance: 3, created_at: '2020-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));

function fixture(n, runConfig, handler) {
  const store = createStore(':memory:'); const service = createService({ store, config: {}, logger: { warn() {} } });
  for (const m of rows(n)) service.saveWithDedupe({ ...m, source: 'manual' });
  let T = T0;
  const calls = [];
  const ctx = { logger: { warn() {} }, llm: { async *stream(options) { calls.push(options); const system = options.messages[0].content[0].text; const body = options.messages[1].content[0].text; let text = system.includes('UUID/type/updated/title') || system.includes('supplied UUID/type') ? '[]' : body.includes('| type=') ? '[]' : 'overview'; if (handler) text = handler({ options, system, body, text, calls }); yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  const scheduler = createDreamScheduler({ onRun: () => {}, now: () => T });
  const run = () => scheduler.runDream(ctx, service, { dreamConsolidationMode: 'grouped', dreamProvider: 'mock', dreamModel: 'sol', dreamReasoningEffort: 'low', dreamIncrementalReview: true, ...runConfig });
  const id = title => service.all().find(m => m.title === title).id;
  return { store, service, calls, run, id, setNow: t => { T = t; }, advance: ms => { T += ms; } };
}
// 整理线载荷 = 含 '| type=' 的行清单（sweep 的标题行系统提示词带 UUID/type/updated/title）。
const packBodies = f => f.calls.filter(c => { const s = c.messages[0].content[0].text, b = c.messages[1].content[0].text; return b.includes('| type=') && !s.includes('UUID/type/updated/title'); }).map(c => c.messages[1].content[0].text);
const sentIds = body => [...body.matchAll(/id=([^\s|]+)/g)].map(m => m[1]);
const statesOf = (f, lane) => f.service.getReviewStates(lane);

test('config: incremental keys default off/3/7 and validate ranges', () => {
  assert.equal(Config({}).dreamIncrementalReview, false);
  assert.equal(Config({}).dreamIncrementalNeighborK, 3);
  assert.equal(Config({}).dreamIncrementalFullReviewDays, 7);
  assert.equal(Config({ dreamIncrementalReview: true }).dreamIncrementalReview, true);
  for (const v of [0, 21, '3']) assert.throws(() => Config({ dreamIncrementalNeighborK: v }));
  for (const v of [0, 91, '7']) assert.throws(() => Config({ dreamIncrementalFullReviewDays: v }));
  assert.throws(() => Config({ dreamIncrementalReview: 'yes' }));
});

// 首次点火（无 review_meta）= 全量兜底轮：全部送审、全部清白 → 全部进第 1 阶。
test('first ignition reviews everything and advances every row to stage 1', async () => {
  const f = fixture(7);
  try {
    const r = await f.run();
    assert.equal(r.status, 'ok');
    assert.equal(r.outcome.incremental.fullReview, true);
    assert.deepEqual(r.outcome.incremental.due, { consolidation: 7, sweep: 7 });
    assert.deepEqual(r.outcome.incremental.not_due, { consolidation: 0, sweep: 0 });
    assert.deepEqual(r.outcome.incremental.sunk_now, { consolidation: 0, sweep: 0 });
    assert.deepEqual(r.outcome.incremental.neighbors, { consolidation: [], sweep: [] });
    for (const lane of ['consolidation', 'sweep']) {
      const st = statesOf(f, lane);
      assert.equal(st.size, 7);
      for (const [id, row] of st) {
        assert.equal(row.streak, 1);
        assert.equal(row.sunk, 0);
        assert.equal(row.strict_hash, strictHashOf(f.service.getById(id)));
        assert.equal(row.next_due_at, new Date(T0 + LADDERS[lane][0] * HOUR * (1 + jitterOf(id))).toISOString());
        assert.equal(row.last_run_id, r.runId);
      }
    }
    assert.equal(f.service.getReviewMeta('last_full_review_at'), new Date(T0).toISOString());
  } finally { f.store.close(); }
});

// §10-4 + 任务追加：被提出决定的行 hold（next_due_at=NULL、不推阶）；下次点火
// 只有到期行入窗，零到期组不调 LLM（audit.status='skipped_not_due'）。
test('a row with a proposed decision holds; next ignition sends only due rows', async () => {
  let target;
  const f = fixture(14, {}, ({ system, body, text }) => {
    // 第二轮的 decision+constraint 组：对一条 constraint 行提 archive（无重复/
    // 过时理由 → 长保留护栏拒 → 进 audit.skipped → 该行阶梯记 hold）。同批给
    // 同类型另一条提合法 keep，避开「该类型全部决策被拒」的整单拒绝闸（#89
    // 防洗白）——没有合法幸存者时 stage 判 failed、整轮不提交。
    if (target && body.includes('| type=') && !system.includes('UUID/type/updated/title') && body.includes(`id=${target} |`)) {
      const cons = [...body.matchAll(/id=([^\s|]+) \| type=constraint/g)].map(m => m[1]);
      const keepId = cons.find(id => id !== target);
      return JSON.stringify([{ action: 'archive', ids: [target], reason: 'low reference value' }, { action: 'keep', ids: [keepId], reason: 'both facts stand' }]);
    }
    return text;
  });
  try {
    target = f.id('title 3');
    await f.run(); // 首次全量，全部清白 → streak1
    f.setNow(T0 + 1.1 * HOUR);
    const r2 = await f.run();
    assert.equal(r2.outcome.incremental.fullReview, false);
    assert.equal(r2.outcome.incremental.due.consolidation, 14, '1.1h after stage-1 all consolidation rows are due again');
    const st2 = statesOf(f, 'consolidation');
    assert.equal(st2.get(target).next_due_at, null, 'held row stays due for the next ignition');
    assert.equal(st2.get(target).streak, 0, 'hold does not advance the ladder（首轮也被同一决定击中 → 从未推阶）');
    assert.equal(st2.get(f.id('title 0')).streak, 2, 'clean rows advanced to stage 2 (4h)');
    assert.ok(r2.outcome.groups.some(g => g.types.includes('constraint') && g.skipped.some(s => s.ids.includes(target))));

    // 只到期 target 一行：零到期组不调 LLM，载荷里只有它。
    target = null;
    f.setNow(T0 + 1.2 * HOUR);
    f.calls.length = 0;
    const r3 = await f.run();
    assert.equal(r3.outcome.incremental.due.consolidation, 1);
    assert.equal(r3.outcome.incremental.not_due.consolidation, 13);
    const ids = packBodies(f).flatMap(sentIds);
    assert.deepEqual(ids, [f.id('title 3')], 'only the due row enters the payload');
    assert.equal(packBodies(f).length, 1, 'exactly one consolidation call');
    assert.deepEqual(r3.outcome.groups.map(g => g.status).sort(), ['ok', 'skipped_not_due', 'skipped_not_due']);
    assert.equal(statesOf(f, 'consolidation').get(f.id('title 3')).streak, 1, 'the clean held row now advances to stage 1');
    assert.equal(statesOf(f, 'consolidation').get(f.id('title 0')).streak, 2, 'not-due rows keep their state untouched');
  } finally { f.store.close(); }
});

// §10-9：沉底条目作为新种子的 BM25 邻居陪绑入同组载荷；陪绑行不计阶、状态不变。
test('sunk row joins as a BM25 neighbor of a new seed and keeps its state', async () => {
  const f = fixture(7);
  try {
    // X = constraint 行已沉底；同组其它行在长冷却；last_full_review_at 新鲜 →
    // 非兜底轮。新写入的 Y 与 X 词面强相似（zzz quantum flange）。
    const x = f.id('title 3');
    f.store.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('zzz quantum flange spec alpha', x);
    const all = new Map(f.service.all().map(m => [m.id, m]));
    const far = new Date(T0 + 100 * HOUR).toISOString();
    f.service.upsertReviewStates('consolidation', [
      { memory_id: x, strict_hash: strictHashOf(all.get(x)), streak: LADDERS.consolidation.length, next_due_at: far, sunk: 1 },
      ...[...all.keys()].filter(id => id !== x).map(id => ({ memory_id: id, strict_hash: strictHashOf(all.get(id)), streak: 2, next_due_at: far, sunk: 0 }))
    ]);
    f.service.setReviewMeta('last_full_review_at', new Date(T0 - HOUR).toISOString());
    f.service.saveWithDedupe({ type: 'constraint', title: 'zzz quantum flange notes', content: 'zzz quantum flange revisited beta', importance: 3, source: 'manual' });
    const y = f.id('zzz quantum flange notes');
    const r = await f.run();
    assert.equal(r.outcome.incremental.due.consolidation, 1, 'only the new row is due');
    assert.ok(r.outcome.incremental.neighbors.consolidation.includes(x), 'sunk neighbor recorded');
    const body = packBodies(f).find(b => b.includes('type=constraint'));
    assert.ok(body.includes(`id=${y}`) && body.includes(`id=${x}`), 'neighbor rides in the same group payload');
    // 陪绑不计阶：X 状态逐字段不变（本轮没有决定落在它身上）。
    const st = statesOf(f, 'consolidation').get(x);
    assert.equal(st.sunk, 1); assert.equal(st.streak, LADDERS.consolidation.length); assert.equal(st.next_due_at, far);
    assert.equal(st.strict_hash, strictHashOf(all.get(x)));
    // Y 清白 → 第 1 阶。
    assert.equal(statesOf(f, 'consolidation').get(y).streak, 1);
  } finally { f.store.close(); }
});

// §10-10：last_full_review_at 距今 8 天 → 全量兜底（忽略阶梯），ok 后刷新 meta。
test('seven day fallback forces a full review and refreshes the meta timestamp', async () => {
  const f = fixture(7);
  try {
    await f.run(); // 首轮全量 → 全部 streak1
    f.setNow(T0 + 8 * DAY);
    const r = await f.run();
    assert.equal(r.outcome.incremental.fullReview, true);
    assert.equal(r.outcome.incremental.due.consolidation, 7, 'streak rows far past their due dates are all re-reviewed');
    assert.equal(r.outcome.incremental.due.sweep, 7);
    assert.equal(f.service.getReviewMeta('last_full_review_at'), new Date(T0 + 8 * DAY).toISOString());
    for (const [, row] of statesOf(f, 'consolidation')) assert.equal(row.streak, 2);
    // 兜底后 1 小时：streak2 的下一次到期在 4h 阶之后 → 全部冷却中、零整理线调用。
    f.setNow(T0 + 8 * DAY + HOUR);
    f.calls.length = 0;
    const r2 = await f.run();
    assert.equal(r2.outcome.incremental.fullReview, false);
    assert.equal(r2.outcome.incremental.due.consolidation, 0);
    assert.equal(r2.outcome.incremental.not_due.consolidation, 7);
    assert.deepEqual(packBodies(f), [], 'zero due → zero consolidation calls');
  } finally { f.store.close(); }
});

// §10-13：sweep stage 抛错 → 非 ok 轮 → 两条 lane 都不写 review_state、不刷 meta。
test('a failed run commits no ladder state', async () => {
  const f = fixture(7, {}, ({ system, text }) => {
    if (system.includes('UUID/type/updated/title')) throw new Error('sweep stage offline');
    return text;
  });
  try {
    const r = await f.run();
    assert.notEqual(r.ok, true);
    assert.equal(r.outcome.sweep.stages[0].status, 'failed');
    assert.equal(statesOf(f, 'consolidation').size, 0, 'ok=false → consolidation lane not written');
    assert.equal(statesOf(f, 'sweep').size, 0, 'ok=false → sweep lane not written');
    assert.equal(f.service.getReviewMeta('last_full_review_at'), undefined, 'fallback meta not refreshed by a failed round');
  } finally { f.store.close(); }
});

// §10-14：开关全关 = 逐字节现状——载荷与调用次数等于基线，outcome/新表零触碰；
// 开关开的首轮（全量兜底）与基线逐调用载荷一致。
test('switch off preserves the baseline payload and call sequence byte for byte', async () => {
  const sweepHandler = ({ system, body, text }) => {
    // 裁决调用返回假 pair → 降级（applied=0）；两 fixture 同构，载荷仍逐 id 集比对。
    if (system.includes('UUID/type/updated/title') && !body.includes('candidates')) { const ids = [...body.matchAll(/id=([^\s|]+)/g)].map(m => m[1]); return JSON.stringify([{ a: ids[0], b: ids[2], reason: 'strict_conflict: title recall only' }]); }
    return text;
  };
  const on = fixture(7, {}, sweepHandler);
  const off = fixture(7, { dreamIncrementalReview: false }, sweepHandler);
  try {
    const ro = await off.run();
    assert.equal(ro.outcome.incremental, undefined, 'no incremental block when disabled');
    assert.equal(ro.outcome.input_count, undefined);
    assert.equal(statesOf(off, 'consolidation').size, 0);
    assert.equal(statesOf(off, 'sweep').size, 0);
    assert.equal(off.service.getReviewMeta('last_full_review_at'), undefined);
    // 与 consolidationGroups/sweepWindows 的纯函数基线口径一致（全量载荷）。
    const base = consolidationGroups(eligible(off.service), 500);
    const bodies = packBodies(off);
    assert.equal(bodies.length, 3);
    for (const [i, g] of base.entries()) assert.deepEqual(sentIds(bodies[i]), g.rows.map(m => m.id));
    const rn = await on.run();
    assert.equal(rn.outcome.incremental.fullReview, true);
    assert.equal(on.calls.length, off.calls.length, 'first ignition makes the same number of calls');
    // id 是各 fixture 现 mint 的 UUID → 用标题序列比对载荷（同一库内容 = 同序）。
    const titles = f => f.calls.map(c => [...c.messages[1].content[0].text.matchAll(/title=([^\s|]+)/g)].map(m => m[1]).join(','));
    assert.deepEqual(titles(on), titles(off), 'first ignition payloads match the baseline call by call');
  } finally { on.store.close(); off.store.close(); }
});
