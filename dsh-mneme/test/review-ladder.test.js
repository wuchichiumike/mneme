// WP1：严格哈希 + 阶梯纯函数 + side 表存储/迁移（设计文档 §3.1 §3.2 §4.1，测试清单 §10.1/2/3/12）。
// 全部用注入的 now，不 sleep。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { contentHashOf, strictHashOf } from '../src/content-hash.js';
import { LADDERS, jitterOf, isDue, nextState } from '../src/dream/review-ladder.js';

const H = 3600e3;
const NOW = Date.parse('2026-11-04T00:00:00Z');
const row = (id, content = '正文', title = '标题') => ({ id, title, content, type: 'history', importance: 3 });

// —— §10.1 整理线阶梯推进到沉底 ——————————————————————————————
test('consolidation ladder advances 1/4/12/24h then sinks at the 24h expiry', () => {
  const r = row('m1');
  assert.deepEqual(LADDERS.consolidation, [1, 4, 12, 24]);
  assert.equal(isDue(r, null, 'consolidation', NOW), true, '新条目立即到期');
  let st = null;
  let t = NOW;
  for (let i = 0; i < LADDERS.consolidation.length; i++) {
    assert.equal(isDue(r, st, 'consolidation', t), true, `第 ${i + 1} 阶到点送审`);
    st = nextState(st, r, 'consolidation', 'advance', t, `run-${i + 1}`);
    assert.equal(st.streak, i + 1);
    // 名义间隔 = 阶梯值 × (1 + jitter)，jitter ∈ [0, 0.1)：只会推后，绝不提前
    const nominal = LADDERS.consolidation[i] * H;
    const gap = Date.parse(st.next_due_at) - t;
    assert.ok(gap >= nominal && gap < nominal * 1.1, `第 ${i + 1} 阶名义 ${nominal / H}h，实际 ${gap / H}h`);
    t = Date.parse(st.next_due_at);
    if (i < LADDERS.consolidation.length - 1) assert.equal(isDue(r, st, 'consolidation', t - 1), false, '未到点不送审');
  }
  assert.equal(isDue(r, st, 'consolidation', t), 'sink', '第 4 阶期满未变 → sink，不送审');
  const sunk = nextState(st, r, 'consolidation', 'sink', t, 'run-4');
  assert.equal(sunk.sunk, 1);
  assert.equal(isDue(r, sunk, 'consolidation', t + 100 * H), false, '沉底后不再送审');
});

test('advance records run id, reviewed time and deterministic jitter in [0,0.1)', () => {
  const r = row('m9');
  const st = nextState(null, r, 'consolidation', 'advance', NOW, 'run-x');
  assert.equal(st.last_run_id, 'run-x');
  assert.equal(st.last_reviewed_at, new Date(NOW).toISOString());
  assert.equal(st.strict_hash, strictHashOf(r));
  for (const id of ['m9', '', 'x'.repeat(100)]) {
    const j = jitterOf(id);
    assert.ok(j >= 0 && j < 0.1, `jitter(${id}) = ${j}`);
    assert.equal(j, jitterOf(id), '确定性');
  }
  assert.equal(jitterOf('a') !== jitterOf('b'), true);
});

// —— §10.2 扫描线 7 阶 ——————————————————————————————
test('sweep ladder runs 1/4/8/12/12/12/12h and sinks after the last 12h', () => {
  const r = row('s1');
  assert.deepEqual(LADDERS.sweep, [1, 4, 8, 12, 12, 12, 12]);
  let st = nextState(null, r, 'sweep', 'advance', NOW, 'r0');
  for (let i = 1; i < 7; i++) {
    const due = Date.parse(st.next_due_at);
    assert.equal(isDue(r, st, 'sweep', due), true);
    st = nextState(st, r, 'sweep', 'advance', due, `r${i}`);
    assert.equal(st.streak, i + 1);
  }
  const due7 = Date.parse(st.next_due_at);
  assert.equal(isDue(r, st, 'sweep', due7 - 1), false);
  assert.equal(isDue(r, st, 'sweep', due7), 'sink');
  const sunk = nextState(st, r, 'sweep', 'sink', due7, 'r7');
  assert.equal(sunk.sunk, 1);
  assert.equal(isDue(r, sunk, 'sweep', due7 + 1000 * H), false);
});

// —— §10.3 严格哈希 3.5 vs 35：回窗并重置 streak ——————————————————————————————
test('strict hash separates 版本 3.5 from 版本 35 where contentHashOf collides', () => {
  const a = row('h1', '系统版本 3.5 已发布');
  const b = { ...a, content: '系统版本 35 已发布' };
  assert.equal(contentHashOf(a), contentHashOf(b), '归一化哈希相同（已知折叠）');
  assert.notEqual(strictHashOf(a), strictHashOf(b), '严格哈希不同');
  assert.equal(strictHashOf({}), strictHashOf({ title: '', content: '' }), '空串照常哈希，不返回 null');
  assert.equal(typeof strictHashOf(null), 'string');
});

test('sunk entry with changed content is due again and streak resets', () => {
  const a = row('h2', '系统版本 3.5 已发布');
  let st = nextState(null, a, 'consolidation', 'advance', NOW, 'r1');
  st = nextState(st, a, 'consolidation', 'sink', Date.parse(st.next_due_at), 'r2');
  assert.equal(st.sunk, 1);
  const b = { ...a, content: '系统版本 35 已发布' };
  assert.equal(isDue(b, st, 'consolidation', Date.parse(st.next_due_at) + H), true, '哈希变化优先于沉底 → 回窗');
  const next = nextState(st, b, 'consolidation', 'advance', NOW + 100 * H, 'r3');
  assert.equal(next.streak, 1, 'streak 重置后从第 1 阶重新走');
  assert.equal(next.sunk, 0, '沉底解除');
  assert.equal(next.strict_hash, strictHashOf(b));
});

test('hold keeps the entry due next ignition without advancing the streak', () => {
  const r = row('h3');
  const st = nextState(null, r, 'consolidation', 'hold', NOW, 'r1');
  assert.equal(st.next_due_at, null);
  assert.equal(st.streak, 0);
  assert.equal(st.strict_hash, strictHashOf(r));
  assert.equal(isDue(r, st, 'consolidation', NOW + H), true, '下次点火仍到期');
});

// —— §10.12 迁移幂等 ——————————————————————————————
test('createStore is idempotent on the same file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp1-migrate-'));
  const file = join(dir, 'mneme.sqlite');
  try {
    const s1 = createStore(file);
    s1.upsertConflictResolution({ pair_key: 'a:b', id_a: 'a', id_b: 'b', reason: 'keep 1' });
    s1.close();
    const s2 = createStore(file);
    const got = s2.getConflictResolution('a:b');
    assert.equal(got.reason, 'keep 1');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy conflict_resolutions gains the four-state columns, old rows stay readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp1-legacy-'));
  const file = join(dir, 'legacy.sqlite');
  try {
    // 旧版表：只有落地时的列，没有 strict_hash_*/guard/cooldown/fail/needs_human
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE conflict_resolutions (
      pair_key TEXT PRIMARY KEY, id_a TEXT NOT NULL, id_b TEXT NOT NULL,
      hash_a TEXT, hash_b TEXT, verdict TEXT NOT NULL DEFAULT 'keep',
      relation TEXT, reason TEXT, model TEXT, run_id TEXT,
      decided_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    raw.prepare(
      `INSERT INTO conflict_resolutions (pair_key,id_a,id_b,hash_a,hash_b,verdict,reason,decided_at,updated_at)
       VALUES ('x:y','x','y','ha','hb','keep','legacy row','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`
    ).run();
    raw.close();
    const store = createStore(file);
    store.close();
    const check = new DatabaseSync(file);
    const cols = check.prepare('PRAGMA table_info(conflict_resolutions)').all().map(c => c.name);
    for (const col of ['strict_hash_a', 'strict_hash_b', 'guard', 'cooldown_until', 'fail_count', 'fail_reason', 'needs_human'])
      assert.ok(cols.includes(col), `缺列 ${col}`);
    check.close();
    const store2 = createStore(file);
    const legacy = store2.getConflictResolution('x:y');
    assert.equal(legacy.reason, 'legacy row');
    assert.equal(legacy.strict_hash_a, null);
    assert.equal(legacy.fail_count, 0);
    assert.equal(legacy.needs_human, 0);
    // 新列可写读，且缺省保持现行行为
    const fresh = store2.upsertConflictResolution({
      pair_key: 'p:q', id_a: 'p', id_b: 'q', verdict: 'guard_rejected',
      strict_hash_a: 'sa', strict_hash_b: 'sb', guard: 'permanent:cross_type',
      cooldown_until: '2026-11-05T00:00:00Z', fail_count: 3, fail_reason: 'too_young', needs_human: 1
    });
    assert.deepEqual(
      [fresh.strict_hash_a, fresh.guard, fresh.cooldown_until, fresh.fail_count, fresh.fail_reason, fresh.needs_human],
      ['sa', 'permanent:cross_type', '2026-11-05T00:00:00Z', 3, 'too_young', 1]
    );
    const minimal = store2.upsertConflictResolution({ pair_key: 'k:l', id_a: 'k', id_b: 'l' });
    assert.equal(minimal.verdict, 'keep');
    assert.equal(minimal.strict_hash_a, null);
    assert.equal(minimal.cooldown_until, null);
    assert.equal(minimal.fail_count, 0);
    assert.equal(minimal.needs_human, 0);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— review_state / review_meta 存储往返（含 service 透传） ——————————————————————————————
test('upsertReviewStates/getReviewStates round-trip through service', () => {
  const store = createStore(':memory:');
  const service = createService({ store, config: {}, logger: { warn() {} } });
  try {
    const a = nextState(null, row('m1'), 'consolidation', 'advance', NOW, 'r1');
    const b = nextState(null, row('m2'), 'consolidation', 'hold', NOW, 'r1');
    assert.equal(service.upsertReviewStates('consolidation', [a, b]), 2);
    const all = service.getReviewStates('consolidation');
    assert.ok(all instanceof Map);
    assert.equal(all.size, 2);
    assert.equal(all.get('m1').streak, 1);
    assert.equal(all.get('m2').next_due_at, null);
    assert.equal(all.get('m2').strict_hash, strictHashOf(row('m2')));
    // 按 ids 过滤；空数组 = 空 Map；另一条 lane 互不可见
    assert.deepEqual([...service.getReviewStates('consolidation', ['m2']).keys()], ['m2']);
    assert.equal(service.getReviewStates('consolidation', []).size, 0);
    assert.equal(service.getReviewStates('sweep').size, 0);
    // 覆盖式 upsert：同 (memory_id, lane) 更新而非插新行
    const a2 = nextState(all.get('m1'), row('m1'), 'consolidation', 'advance', NOW + 2 * H, 'r2');
    service.upsertReviewStates('consolidation', [a2]);
    assert.equal(service.getReviewStates('consolidation').get('m1').streak, 2);
    assert.equal(service.getReviewStates('consolidation').size, 2);
    // 坏输入
    assert.throws(() => service.upsertReviewStates('consolidation', [{ streak: 1 }]), /memory_id/);
    assert.throws(() => service.upsertReviewStates(null, []), /lane/);
  } finally {
    store.close();
  }
});

test('getReviewMeta/setReviewMeta round-trip; unset key reads undefined', () => {
  const store = createStore(':memory:');
  const service = createService({ store, config: {}, logger: { warn() {} } });
  try {
    assert.equal(service.getReviewMeta('last_full_review_at'), undefined);
    assert.equal(service.setReviewMeta('last_full_review_at', '2026-11-04T00:00:00Z'), '2026-11-04T00:00:00Z');
    assert.equal(service.getReviewMeta('last_full_review_at'), '2026-11-04T00:00:00Z');
    assert.equal(service.setReviewMeta('last_full_review_at', '2026-11-05T00:00:00Z'), '2026-11-05T00:00:00Z');
    assert.equal(service.getReviewMeta('last_full_review_at'), '2026-11-05T00:00:00Z');
    assert.throws(() => service.setReviewMeta('', 'v'), /key/);
  } finally {
    store.close();
  }
});
