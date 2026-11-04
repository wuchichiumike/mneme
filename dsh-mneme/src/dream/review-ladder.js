// 增量送审阶梯状态机（设计文档 §3.2）。纯函数模块：不碰 store、不读时钟，
// now 一律由调用方注入（毫秒），行对象带进来、新状态对象带出去。
// 提交时机在 grouped.js:finish（ok 才落库，见 §3.3），本模块只算不写。
import { createHash } from "node:crypto";
import { strictHashOf } from "../content-hash.js";

// 两条线的阶梯（小时）。consolidation：4 阶后第 4 阶期满未变 → 沉底；
// sweep：7 阶（1/4/8/12×4），最后一个 12h 期满未变 → 沉底。
export const LADDERS = { consolidation: [1, 4, 12, 24], sweep: [1, 4, 8, 12, 12, 12, 12] };

const HOUR_MS = 3600e3;

/**
 * 到期错峰抖动 ∈ [0, 0.1)：sha256(memory_id) 前 8 个 hex 归一化后乘 0.1。
 * 确定性——同一 id 在任何进程任何时刻得到同一个值，测试可复算。
 * 用途（§3.2/D3）：首次开启阶梯后全库同批推进，jitter 让到期最多**推后** 10%
 * 而绝不提前，所以不违反「到期才送审」的名义值（R7）。
 * @param {string} memoryId
 * @returns {number}
 */
export function jitterOf(memoryId) {
  const hex = createHash("sha256").update(String(memoryId ?? "")).digest("hex").slice(0, 8);
  return (parseInt(hex, 16) / 0xffffffff) * 0.1;
}

/**
 * 选窗阶段的到期判定（now = 本轮点火时刻，毫秒）。
 * @param {object} row memories 行（用 title/content 算严格哈希）
 * @param {{strict_hash?:string|null,streak?:number,sunk?:number,next_due_at?:string|null}|null|undefined} st review_state 行；null = 新条目
 * @param {'consolidation'|'sweep'} lane
 * @param {number} nowMs
 * @returns {true|false|'sink'} 'sink' = 最后一阶期满且正文未变 → 沉底，不送审
 */
export function isDue(row, st, lane, nowMs) {
  if (!st) return true; // 新条目，或者第一次开启
  if (st.strict_hash !== strictHashOf(row)) return true; // 正文变化 → 回窗（nextState 里重置）
  if (st.sunk) return false;
  if (st.next_due_at && Date.parse(st.next_due_at) > nowMs) return false;
  if (st.streak >= LADDERS[lane].length) return 'sink'; // 最后一阶期满且未变 → 沉底
  return true;
}

/**
 * 本轮结果 → 新状态（仅在 finish() 判定 ok 后统一提交，§3.3）。
 *  prev 为空或严格哈希与当前行不一致 → 视为阶梯重置（streak=0, sunk=0）。
 * @param {object|null} prev 上一 review_state 行（toReviewState 形状）
 * @param {object} row memories 行
 * @param {'consolidation'|'sweep'} lane
 * @param {'advance'|'hold'|'sink'} outcome
 * @param {number} nowMs 点火时刻（毫秒）
 * @param {string|null} runId
 * @returns {object} 新状态对象（review_state 行形状，updated_at 为 ISO）
 */
export function nextState(prev, row, lane, outcome, nowMs, runId) {
  const hash = strictHashOf(row);
  const base = (!prev || prev.strict_hash !== hash) ? { streak: 0, sunk: 0 } : prev;
  const nowIso = new Date(nowMs).toISOString();
  if (outcome === 'hold') {
    // 下次点火仍到期（next_due_at=NULL），但哈希记下：清白一轮的判定锚不变。
    return { memory_id: row.id, lane, strict_hash: hash, streak: base.streak, next_due_at: null, sunk: base.sunk ? 1 : 0, last_reviewed_at: prev?.last_reviewed_at ?? null, last_run_id: prev?.last_run_id ?? null, updated_at: nowIso };
  }
  if (outcome === 'sink') {
    return { memory_id: row.id, lane, strict_hash: hash, streak: base.streak, next_due_at: base.next_due_at ?? null, sunk: 1, last_reviewed_at: prev?.last_reviewed_at ?? null, last_run_id: prev?.last_run_id ?? null, updated_at: nowIso };
  }
  // outcome === 'advance'：streak 0 → 第 1 阶（h = LADDERS[lane][base.streak]）
  const ladder = LADDERS[lane];
  const h = ladder[base.streak];
  const jitter = jitterOf(row.id);
  return {
    memory_id: row.id,
    lane,
    strict_hash: hash,
    streak: base.streak + 1,
    sunk: 0,
    next_due_at: new Date(nowMs + h * HOUR_MS * (1 + jitter)).toISOString(),
    last_reviewed_at: nowIso,
    last_run_id: runId ?? null,
    updated_at: nowIso
  };
}
