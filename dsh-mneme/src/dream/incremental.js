// 增量送审（consolidation 设计文档 §3.2/§3.3/§5/§8）。纯函数模块：不碰 store、
// 不读时钟，now 一律由调用方注入（毫秒）。状态机本体在 review-ladder.js，这里
// 只做三件事：选窗（到期/沉底/冷却分池）、BM25 邻居陪绑、把本轮结果算成提交行。
// 提交时机在 grouped.js:finish（ok 才落库，§3.3），本模块只算不写。
import { createBM25Index } from "../search/bm25.js";
import { strictHashOf } from "../content-hash.js";
import { isDue, nextState } from "./review-ladder.js";

export const HOUR_MS = 3600e3;
export const DAY_MS = 24 * HOUR_MS;
// 陪绑规模上限（§5.1）：整理线每组 60 条、扫描线全局 150 条。硬编码，与
// SWEEP_BAND_CAP 同一惯例（用户 2026-11-04 决定：护栏常量不进配置）。
export const CONSOLIDATION_NEIGHBOR_CAP = 60;
export const SWEEP_NEIGHBOR_CAP = 150;

/**
 * 全量兜底判定（§5.2）：last_full_review_at 缺失/不可解析 → 本轮就是兜底轮；
 * 距今 ≥ days 天 → 兜底。兜底轮忽略阶梯，但沉底条目仍不送审（沉底只认哈希）。
 */
export function isFullReview(metaValue, nowMs, days) {
  if (!Number.isFinite(days) || days <= 0) return true;
  const t = Date.parse(String(metaValue ?? ""));
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= days * DAY_MS;
}

/**
 * 选窗（§3.2 + §5.2）。逐条把全量 eligible 行分成三池：
 *  - due：入窗送审。seed=无 state 或严格哈希已变（邻居陪绑的种子，§5.1）。
 *  - sunk：不送审。阶梯期满未变（isDue='sink'）或兜底轮里的已沉底条目。
 *  - notDue：冷却中，原状态不动。
 * fullReview=true 时忽略阶梯与到期时间（哈希未变的已沉底条目仍不送审）。
 * @returns {{due:Array<{row:object,st:object|null,seed:boolean}>,sunk:Array<{row:object,st:object}>,notDue:Array<{row:object,st:object}>}}
 */
export function selectDue(lane, rows, states, nowMs, fullReview) {
  const due = [], sunk = [], notDue = [];
  for (const row of rows) {
    const st = states?.get?.(row.id) ?? null;
    if (fullReview) {
      const unchanged = Boolean(st && st.strict_hash === strictHashOf(row));
      if (st?.sunk && unchanged) sunk.push({ row, st });
      else due.push({ row, st, seed: !st || !unchanged });
      continue;
    }
    const verdict = isDue(row, st, lane, nowMs);
    if (verdict === "sink") sunk.push({ row, st });
    else if (verdict === true) due.push({ row, st, seed: !st || st.strict_hash !== strictHashOf(row) });
    else notDue.push({ row, st });
  }
  return { due, sunk, notDue };
}

/**
 * 邻居陪绑（§5.1）。种子=本轮到期中的新条目/哈希变化条目；对全量 eligible 现建
 * BM25 内存索引（不走 service.bm25Recall 的 500 上限），以 `title + content` 为
 * 查询，只从非到期池（冷却中 + 沉底）取 top-k，跨种子去重，总量不超过 cap。
 * @param {object} o
 * @param {Array<object>} o.seeds 种子行（memories 行）
 * @param {Array<object>} o.pool 非到期池行
 * @param {Array<object>} o.corpus 全量 eligible 行（索引语料）
 * @param {number} o.k 每个种子最多取几条
 * @param {number} o.cap 本次陪绑总条数上限
 * @param {(seed:object)=>string[]|null} [o.typesOf] 限定邻居类型（整理线=同组类型）
 * @returns {Array<object>} 陪绑行（corpus 的原对象）
 */
export function pickNeighbors({ seeds, pool, corpus, k, cap, typesOf }) {
  const out = [];
  if (!seeds?.length || !pool?.length || !(k > 0) || !(cap > 0)) return out;
  const index = createBM25Index(corpus);
  const poolIds = new Set(pool.map(m => m.id));
  const seen = new Set();
  for (const seed of seeds) {
    if (out.length >= cap) break;
    const allowed = typesOf ? new Set(typesOf(seed) ?? []) : null;
    const hits = index.search(`${seed.title ?? ""} ${seed.content ?? ""}`, { limit: poolIds.size + 1 });
    let taken = 0;
    for (const hit of hits) {
      if (taken >= k || out.length >= cap) break;
      if (!poolIds.has(hit.id) || seen.has(hit.id)) continue;
      if (allowed && !allowed.has(hit.type)) continue;
      seen.add(hit.id);
      taken++;
      out.push(corpus.find(m => m.id === hit.id) ?? hit);
    }
  }
  return out;
}

/**
 * 提交行构建（§3.3）：把每条入窗/沉底行的本轮结果（advance|hold|sink）过一遍
 * nextState，得到 review_state 新行。陪绑行不在 entries 里 = 状态原样不动；
 * 被提出决定的陪绑行由调用方以 outcome='hold' 放进来（next_due_at 拉回 NULL）。
 * 注意 sink 也要写 strict_hash（WP1 nextState 已保证），沉底只认哈希。
 */
export function buildCommitRows(lane, entries, nowMs, runId) {
  const out = [];
  for (const { row, prev, outcome } of entries ?? []) {
    if (!row?.id || !outcome) continue;
    out.push(nextState(prev, row, lane, outcome, nowMs, runId));
  }
  return out;
}
