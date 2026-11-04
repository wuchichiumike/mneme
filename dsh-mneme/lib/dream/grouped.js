// Opt-in grouped consolidation. Legacy dream and sleep retain their contracts.
import { randomUUID } from "node:crypto";
import { validateDecisions, applyDecisions } from "./decisions.js";
import { isImportedRow } from "../memory-source.js";
import { scopeKeyOf } from "../scope.js";
import { adjudicateCandidates } from "./adjudication.js";
import { contentHashOf, strictHashOf } from "../content-hash.js";
import { STR, langOf } from "../lang.js";
import { isFullReview, selectDue, pickNeighbors, buildCommitRows, DAY_MS, CONSOLIDATION_NEIGHBOR_CAP, SWEEP_NEIGHBOR_CAP } from "./incremental.js";

// 出口1（resolved_keep 台账）读取端 TTL：超过 30 天的 keep 结论重新送审
// （语义可能随库演化漂移，长期结论要定期复损）。upsert 会刷新 decided_at，
// 所以重审后若仍是 keep，下一轮继续跳过。
export const RESOLVED_KEEP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const GROUPS = [["project", "history"], ["decision", "constraint"], ["pitfall", "preference", "rejected_solution"]];
export const newestFirst = (a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function eligible(service) {
  const rows = service.all().filter(m => !isImportedRow(m) && !m.archived && !m.forgotten && m.type !== "summary" && m.type !== "document");
  return (typeof service.filterPaused === "function" ? service.filterPaused(rows) : rows).sort(newestFirst);
}
// Capacity guards, single source each (user decision 2026-11-04: hardcoded, no config keys yet).
// Sweep: three time bands x SWEEP_BAND_CAP => zero drops while eligible rows <= 3*500 = 1500;
// beyond that each band truncates at the cap and the existing dropped/degraded audit path records the gap.
export const SWEEP_BAND_CAP = 500;
// Consolidation: per-group slice cap; exceeding it keeps truncating as before but now emits a structured degradation marker.
export const CONSOLIDATION_GROUP_CAP = 500;
export function consolidationGroups(rows, limit = CONSOLIDATION_GROUP_CAP) {
  const cap = Math.max(1, limit);
  return GROUPS.map(types => {
    const sorted = rows.filter(m => types.includes(m.type)).sort(newestFirst);
    const truncation = sorted.length > cap ? { total: sorted.length, kept: cap, dropped: sorted.length - cap } : null;
    return { types, rows: sorted.slice(0, cap), truncation };
  });
}
export function sweepWindows(rows) {
  const sorted = [...rows].sort(newestFirst);
  if (sorted.length <= 700) return { total: sorted.length, covered: sorted.length, dropped: 0, segments: [], windows: sorted.length ? [{ label: "all", rows: sorted }] : [] };
  let offset = 0;
  const segments = ["A", "B", "C"].map((label, i) => {
    const size = Math.floor(sorted.length / 3) + (i < sorted.length % 3 ? 1 : 0);
    const source = sorted.slice(offset, offset += size);
    const selected = source.slice(0, SWEEP_BAND_CAP);
    return { label, source_count: size, selected_count: selected.length, dropped: size - selected.length, selected_ids: selected.map(m => m.id), dropped_ids: source.slice(SWEEP_BAND_CAP).map(m => m.id), rows: selected };
  });
  const windows = [[0, 2], [0, 1], [2, 1]].map(([a, b]) => ({ label: segments[a].label + segments[b].label, rows: [...segments[a].rows, ...segments[b].rows].sort(newestFirst) }));
  const covered = segments.reduce((n, s) => n + s.selected_count, 0);
  return { total: sorted.length, covered, dropped: sorted.length - covered, segments, windows };
}
const parseArray = text => {
  const stripped = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(stripped);
  if (!Array.isArray(value)) throw new Error("expected JSON array");
  return value;
};
const sameScope = (a, b) => scopeKeyOf(a.agent_scope) === scopeKeyOf(b.agent_scope) && scopeKeyOf(a.workspace_scope) === scopeKeyOf(b.workspace_scope);
const evidence = m => Object.fromEntries(["id", "type", "title", "content", "importance", "created_at", "updated_at", "agent_scope", "workspace_scope"].map(k => [k, m[k] ?? null]));

export async function runGroupedDream(ctx, service, config, helpers) {
  const { semantic, resolveRoute, resolveDreamEffort, runAuditedLlm, streamText, withMaxTokensFallback, describeStreamFailure, fenceListBody, hashSnapshot, buildReceipt, buildOutcome, buildRecordReceipts, maintainIndexAfterDream, reEmbedMemory } = helpers;
  const language = langOf(config), logger = ctx.logger;
  // 统一注入时刻（毫秒）：调度器可注入 helpers.now；台账冷却/TTL 判定都以此为准。
  const nowMs = typeof helpers.now === "function" ? helpers.now() : Date.now();
  const ledgerOn = config.dreamLedgerExtended === true;
  const started = new Date().toISOString(), runId = randomUUID(), route = resolveRoute(ctx, config, logger);
  const initialEligible = eligible(service);
  // ── 增量送审选窗（§3.2/§5，dreamIncrementalReview，默认关 = 逐字节现状）──
  // 两条 lane 各自读 review_state 算到期性；全量兜底（§5.2）由 review_meta
  // last_full_review_at 距今 ≥ FullReviewDays 触发，兜底轮忽略阶梯但沉底条目
  // 仍不送审（沉底只认哈希）。邻居陪绑的种子 = 到期行中「无 state 或严格哈希
  // 已变」者，从非到期池（冷却中+沉底）按 BM25 词面相似度捞回窗。
  const incrementalOn = config.dreamIncrementalReview === true;
  const neighborK = Number.isInteger(config.dreamIncrementalNeighborK) ? Math.max(1, Math.min(20, config.dreamIncrementalNeighborK)) : 3;
  const fullReviewDays = Number.isInteger(config.dreamIncrementalFullReviewDays) ? Math.max(1, Math.min(90, config.dreamIncrementalFullReviewDays)) : 7;
  const groupCap = Number.isInteger(config.dreamGroupedWindow) ? Math.max(1, Math.min(CONSOLIDATION_GROUP_CAP, config.dreamGroupedWindow)) : CONSOLIDATION_GROUP_CAP;
  const inc = {
    enabled: incrementalOn, fullReview: false,
    consolidation: { due: new Map(), sunk: new Map(), notDue: new Map(), neighbors: new Map(), states: new Map(), hold: new Set() },
    sweep: { due: new Map(), sunk: new Map(), notDue: new Map(), neighbors: new Map(), states: new Map(), hold: new Set() }
  };
  if (incrementalOn) {
    inc.fullReview = isFullReview(service.getReviewMeta?.("last_full_review_at"), nowMs, fullReviewDays);
    const consStates = service.getReviewStates("consolidation");
    inc.consolidation.states = consStates;
    const consSel = selectDue("consolidation", initialEligible, consStates, nowMs, inc.fullReview);
    for (const e of consSel.due) inc.consolidation.due.set(e.row.id, e);
    for (const e of consSel.sunk) inc.consolidation.sunk.set(e.row.id, e);
    for (const e of consSel.notDue) inc.consolidation.notDue.set(e.row.id, e);
    // 整理线陪绑：逐组（同组类型内），k=NeighborK，每组上限 60（§5.1）。
    const consPool = [...consSel.notDue, ...consSel.sunk].map(e => e.row);
    for (const types of GROUPS) {
      const seeds = consSel.due.filter(e => e.seed && types.includes(e.row.type)).map(e => e.row);
      for (const m of pickNeighbors({ seeds, pool: consPool, corpus: initialEligible, k: neighborK, cap: CONSOLIDATION_NEIGHBOR_CAP, typesOf: () => types }))
        inc.consolidation.neighbors.set(m.id, m);
    }
  }
  const consWindowRows = incrementalOn ? [...initialEligible.filter(m => inc.consolidation.due.has(m.id)), ...inc.consolidation.neighbors.values()] : initialEligible;
  const groups = consolidationGroups(consWindowRows, groupCap);
  const unsupported = initialEligible.filter(m => !GROUPS.flat().includes(m.type));
  const snapshot = new Map(groups.flatMap(g => g.rows).map(m => [m.id, m]));
  const snapshotHash = hashSnapshot([...snapshot.values()]);
  const outcome = { byId: {}, mode: "grouped", groups: [], degradations: [], sweep: null, conflicts: [], failures: [], cross_type_candidates: [], skippedUnsupportedTypes: unsupported.map(evidence) };
  const decisions = [], committed = [], usage = [], adjudicationSkipped = [];
  const claims = new Set(), budget = new Map();
  const limits = {update: config.reflectionUpdateMaxPerRun ?? 2, archive: config.dreamMaxArchivePerRun ?? 8, merge: config.dreamMaxMergePerRun ?? 40};
  const spent = type => { if(!budget.has(type)) budget.set(type,{update:0,archive:0,merge:0}); return budget.get(type); };
  const remaining = type => Object.fromEntries(Object.entries(limits).map(([a,n]) => [`max${a[0].toUpperCase()+a.slice(1)}PerRun`,Math.max(0,n-spent(type)[a])]));
  const account = (items,snap) => { for(const d of items) if(d.action !== "keep") { const ids=d.action === "conflict"||d.action === "supersede" ? [d.winner,d.loser] : d.ids; ids.forEach(id=>claims.add(id)); for(const type of new Set(ids.map(id=>snap.get(id)?.type))) if(d.action in limits) spent(type)[d.action]++; if(d.action === "conflict"||d.action === "supersede") spent(snap.get(d.loser)?.type).archive++; } };
  let applied = 0, summaryStored = false, failedStages = 0, degraded = unsupported.length > 0, frozen = 0, ledgerFilteredDecisions = 0;
  // Truncation still drops rows exactly as before; this only removes the silence (degraded, never a failed stage).
  for (const g of groups) if (g.truncation) { degraded = true; outcome.degradations.push({ kind: "consolidation_truncated", group: g.types.join("+"), ...g.truncation }); }
  // §8：被截断丢弃的行阶梯记 hold（下次点火重新到期），只对入过窗的到期行生效。
  const consTruncatedDropped = new Set();
  if (incrementalOn) for (const g of groups) if (g.truncation) {
    const sorted = consWindowRows.filter(m => g.types.includes(m.type)).sort(newestFirst);
    for (const m of sorted.slice(groupCap)) if (inc.consolidation.due.has(m.id)) consTruncatedDropped.add(m.id);
  }
  const finish = () => {
    const status = outcome.conflicts.length || outcome.failures.length ? "reconcile" : failedStages ? (applied || summaryStored ? "degraded" : "failed") : degraded ? "degraded" : applied || summaryStored || frozen ? "ok" : "noop";
    const ok = status === "ok" || status === "degraded" && failedStages === 0;
    // §9 验收指标 / §10-4 断言口径：增量轮的实际送审行数（整理线快照 = 到期+陪绑
    // 入窗；台账静默过滤数与增量开关无关，只在 dreamLedgerExtended 开时写）。
    if (incrementalOn) outcome.input_count = snapshot.size;
    if (ledgerOn) outcome.ledger_filtered_decisions = ledgerFilteredDecisions;
    // 增量轮观测（WP3 §5 形状）：两线到期/冷却/沉底计数 + 陪绑 id 集合。
    if (incrementalOn) outcome.incremental = {
      enabled: true, fullReview: inc.fullReview,
      due: { consolidation: inc.consolidation.due.size, sweep: inc.sweep.due.size },
      not_due: { consolidation: inc.consolidation.notDue.size, sweep: inc.sweep.notDue.size },
      sunk_now: { consolidation: inc.consolidation.sunk.size, sweep: inc.sweep.sunk.size },
      neighbors: { consolidation: [...inc.consolidation.neighbors.keys()], sweep: [...inc.sweep.neighbors.keys()] }
    };
    const receipt = buildReceipt({ runId, status, snapshotHash, inputCount: snapshot.size, applied, summaryStored });
    let baseline;
    if (ok) { const rows = eligible(service); baseline = { count: rows.length, chars: rows.reduce((n, m) => n + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0) }; }
    // §3.3 提交时机：阶梯提交 ⊂ 基线推进——只有 ok 轮才写 review_state（含沉底），
    // 失败轮什么都不写，同一批条目下次点火仍然到期（隐式重试语义）。
    // 兜底轮成功后刷新 last_full_review_at。写入失败只记日志，不影响本轮结果。
    if (ok && incrementalOn) {
      const rowById = new Map(initialEligible.map(m => [m.id, m]));
      for (const [lane, agg] of [["consolidation", inc.consolidation], ["sweep", inc.sweep]]) {
        const entries = [];
        for (const [id, e] of agg.due) entries.push({ row: rowById.get(id) ?? e.row, prev: e.st, outcome: agg.hold.has(id) ? "hold" : "advance" });
        for (const [id, e] of agg.sunk) entries.push({ row: rowById.get(id) ?? e.row, prev: e.st, outcome: "sink" });
        // 陪绑行不计阶；本轮被提出过决定的陪绑行拉回「到期」（next_due_at=NULL）。
        for (const [id, row] of agg.neighbors) if (agg.hold.has(id)) entries.push({ row: rowById.get(id) ?? row, prev: agg.states.get(id) ?? null, outcome: "hold" });
        try { service.upsertReviewStates(lane, buildCommitRows(lane, entries, nowMs, runId)); } catch (error) { logger?.warn?.(`grouped dream review_state commit failed (${lane}): ${String(error)}`); }
      }
      if (inc.fullReview) { try { service.setReviewMeta("last_full_review_at", new Date(nowMs).toISOString()); } catch (error) { logger?.warn?.(`grouped dream review_meta failed: ${String(error)}`); } }
    }
    try { service.saveDreamRun({ id: runId, created_at: started, status, error: failedStages ? `${failedStages} stage(s) failed` : undefined, provider: route?.provider, model: route?.model, input_count: snapshot.size, snapshot_hash: snapshotHash, input: [...snapshot.values()].map(evidence), decisions, outcome, skipped: [...outcome.groups.flatMap(g => g.skipped.map(s => ({ ...s, stage: g.types.join("+") }))), ...adjudicationSkipped], applied, summary_stored: summaryStored, receipt, policy_epoch: config.policyEpoch ?? 0, store_count: baseline?.count, store_chars: baseline?.chars }); } catch (error) { logger?.warn?.(`grouped dream audit failed: ${String(error)}`); }
    return { ok, status, runId, snapshotHash, receipt, applied, summary: summaryStored, narratives: 0, frozen, outcome, usage, baseline };
  };
  if (!route) { failedStages++; outcome.error = "no llm route"; return finish(); }
  // Unlike legacy fallback, an explicitly selected effort is never silently removed.
  const effort = config.dreamReasoningEffort && config.dreamReasoningEffort !== "none"
    ? config.dreamReasoningEffort
    : await resolveDreamEffort(ctx, route, config.dreamReasoningEffort, logger);
  const call = async (operationType, label, rows, prompt, body, summary = false, effortOverride = undefined) => {
    let streamFailure = "";
    const selectedRoute = summary && config.dreamSummaryProvider && config.dreamSummaryModel ? { provider: config.dreamSummaryProvider, model: config.dreamSummaryModel } : route;
    const run = tokens => runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream", operationType, modelId: `${selectedRoute.provider}:${selectedRoute.model}`,
      relatedMemoryIds: rows.map(m => m.id), streamError: () => streamFailure,
      auditError: text => { if (summary) return null; try { parseArray(text); return null; } catch { return "no JSON array"; } },
      metadataFrom: () => ({ mode: "grouped", stage: label, input_count: rows.length, reasoning_effort: operationType === "dream_adjudicate" ? effortOverride ?? "low" : effort, provider: selectedRoute.provider, model: selectedRoute.model })
    }, reportUsage => streamText(ctx, { ...selectedRoute, purpose: "compaction", maxTokens: tokens, ...(operationType === "dream_adjudicate" ? {reasoningEffort:effortOverride ?? "low"} : effort ? { reasoningEffort: effort } : {}), messages: [
      { role: "system", content: [{ type: "text", text: prompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: fenceListBody(language, body, summary ? "text" : "json") }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ] }, u => { usage.push({ stage: label, ...u }); reportUsage(u); }, reason => { streamFailure = describeStreamFailure(reason); }));
    const text = operationType === "dream_adjudicate" ? await run(config.dreamMaxTokens ?? 131072) : await withMaxTokensFallback(ctx, config.dreamMaxTokens ?? 131072, run, () => streamFailure);
    if (text === undefined) throw new Error(streamFailure || "stream failed");
    return summary ? text : parseArray(text);
  };
  const rowKeepHash = m => m?.content_hash ?? contentHashOf(m) ?? null;
  // §4.3 ledgerSkip（开关开）：哈希匹配优先用严格哈希（无 strict_hash 的存量行
  // 回退现行 content_hash 比较）。keep/applied（含永久护栏 keep）TTL 内 → 'resolved'
  // 跳过送审；guard_rejected/invalid 冷却未到期 → 'cooling' 跳过送审。哈希失配 =
  // 正文变了 → 重审；TTL 到期 → 重审；台账查询异常退化为「全量送审」（可用性优先）。
  const ledgerSkip = (rec, ra, rb) => {
    if (!rec) return null;
    if (!(ra && rb && !ra.archived && !ra.forgotten && !rb.archived && !rb.forgotten)) return null;
    const hashOk = rec.strict_hash_a
      ? strictHashOf(ra) === rec.strict_hash_a && strictHashOf(rb) === rec.strict_hash_b
      : Boolean(rec.hash_a && rec.hash_b && rowKeepHash(ra) === rec.hash_a && rowKeepHash(rb) === rec.hash_b);
    if (!hashOk) return null;
    if (rec.verdict === "keep" || rec.verdict === "applied") {
      const decidedAt = Date.parse(rec.decided_at ?? "");
      return Number.isFinite(decidedAt) && nowMs - decidedAt <= RESOLVED_KEEP_TTL_MS ? "resolved" : null;
    }
    const cooling = Date.parse(rec.cooldown_until ?? "");
    return Number.isFinite(cooling) && cooling > nowMs ? "cooling" : null;
  };
  for (const group of groups) {
    const audit = { types: group.types, input_ids: group.rows.map(m => m.id), input_count: group.rows.length, input_digest: hashSnapshot(group.rows), status: "skipped", skipped: [] };
    outcome.groups.push(audit);
    if (!group.rows.length) { if (incrementalOn) audit.status = "skipped_not_due"; continue; }
    try {
      const raw = await call("dream_consolidate", group.types.join("+"), group.rows,
        STR.prompts.consolidation[language] + "\n" + STR.prompts.groupedGuard[language] + `\nnow=${new Date().toISOString()}; update <= ${config.reflectionUpdateMaxPerRun ?? 2}, archive <= ${config.dreamMaxArchivePerRun ?? 8}, merge <= ${config.dreamMaxMergePerRun ?? 40} decisions PER TYPE. Minimum update age ${config.reflectionUpdateMinAgeHours ?? 24} hours.`,
        group.rows.map(m => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | created=${m.created_at} | scope=${JSON.stringify([m.agent_scope, m.workspace_scope])} | title=${m.title} | content=${m.content}`).join("\n"));
      const partitions = new Map(group.types.map(t => [t, []]));
      const localSnapshot = new Map(group.rows.map(m => [m.id, m]));
      // 决定被台账静默过滤后，本组「显式覆盖」的只有被过滤的 id——隐式 keep 闸
      // （dreamImplicitKeep）必须看见这些 id，否则会把合法过滤误判为残缺输出。
      const ledgerFilteredIds = new Set();
      let reviewedCrossType = 0, ledgerFilteredThisGroup = 0;
      for (const [index, d] of raw.entries()) {
        const ids = d?.action === "conflict" ? [d.winner, d.loser] : d?.ids;
        const rows = Array.isArray(ids) ? ids.map(id => localSnapshot.get(id)) : [];
        const types = new Set(rows.map(m => m?.type));
        if (d?.action === "conflict" && rows.length === 2 && rows.every(Boolean) && ids[0] !== ids[1] && types.size === 2) {
          outcome.cross_type_candidates.push({ status: "pending_body_review", stage: group.types.join("+"), reason: d.reason, evidence: rows.map(evidence) });
          degraded = true; reviewedCrossType++;
          continue;
        }
        // §4.3 末条（dreamLedgerExtended，与增量开关无关）：整理线决定进入护栏
        // 校验（partitions/validateDecisions）之前先按 pair_key（ids 排序拼 ':'，
        // conflict 用 winner/loser；仅 ids.length≥2）查台账。命中 'resolved'
        // （含永久护栏 keep）或 'cooling' → 静默丢弃：不进 audit.skipped、不置
        // degraded，只计 outcome.ledger_filtered_decisions。n>2 的决定只在台账行
        // 的 id_a/id_b 都在本组快照时判定；无法判定 = 不过滤。
        if (ledgerOn && Array.isArray(ids) && ids.length >= 2 && rows.length === ids.length && rows.every(Boolean)) {
          const unique = [...new Set(ids)].sort();
          let rec;
          try { rec = service.getConflictResolution?.(unique.join(":")); } catch { rec = undefined; }
          if (rec) {
            const skip = unique.length === 2
              ? ledgerSkip(rec, localSnapshot.get(unique[0]), localSnapshot.get(unique[1]))
              : ledgerSkip(rec, localSnapshot.get(rec.id_a), localSnapshot.get(rec.id_b));
            if (skip === "resolved" || skip === "cooling") { ledgerFilteredDecisions++; ledgerFilteredThisGroup++; for (const id of unique) ledgerFilteredIds.add(id); continue; }
          }
        }
        if (!["keep", "merge", "archive", "update", "conflict"].includes(d?.action) || !rows.length || rows.some(m => !m) || types.size !== 1 || (d.action === "merge" && (new Set(ids).size < 2 || rows.some(m => !sameScope(rows[0], m)) || d.importance !== Math.max(...rows.map(m => m.importance))))) {
          audit.skipped.push({ index, action: d?.action, ids: Array.isArray(ids) ? ids : [], error: "invalid grouped schema, type, scope, or lossless merge importance" }); continue;
        }
        partitions.get(rows[0].type).push(d);
      }
      if (audit.skipped.length && config.dreamSkipInvalid === false) throw new Error("invalid grouped decisions in strict mode");
      // 全部决定被台账静默过滤 ≠ 「全决定无效」：本组有过滤记录时不抛（§4.3 末条）。
      if (raw.length && !reviewedCrossType && ![...partitions.values()].some(p => p.length) && ledgerFilteredThisGroup === 0) throw new Error("all grouped decisions invalid");
      if (audit.skipped.length) degraded = true;
      for (const [type, list] of partitions) {
        const typeSnapshot = new Map(group.rows.filter(m => m.type === type).map(m => [m.id, m]));
        // 台账过滤掉的 id 注入隐式 keep（视同已审）：否则全部决定被过滤时覆盖率
        // 闸会判「显式覆盖 0%」而置 degraded，违背「静默丢弃」语义（§4.3 末条）。
        for (const id of ledgerFilteredIds) if (typeSnapshot.has(id) && !list.some(d => (d.action === "conflict" ? [d.winner, d.loser] : d.ids ?? []).includes(id))) list.push({ action: "keep", ids: [id], reason: "ledger_filtered" });
        const result = validateDecisions(list, typeSnapshot, { ...remaining(type), minAgeHours: config.reflectionUpdateMinAgeHours, dreamImplicitKeep: config.dreamImplicitKeep, dreamMinExplicitCoverage: config.dreamMinExplicitCoverage, skipInvalid: config.dreamSkipInvalid !== false, allowCrossTypeMerge: false, mergeGuard: config.dreamMergeGuard === true, allowedActions: ["keep", "merge", "archive", "update", "conflict"] });
        audit.skipped.push(...result.skipped);
        if (!result.ok) { failedStages++; audit.status = "failed"; audit.errors = [...(audit.errors ?? []), ...result.errors]; continue; }
        if (result.coverageShortfall || result.skipped.length || audit.skipped.length) degraded = true;
         if(result.coverageShortfall) audit.coverage_degraded_reason="explicit coverage below configured minimum";
        const apply = [];
        let archiveReserved = 0;
        for (const d of list) {
          if (["archive", "conflict"].includes(d.action) && ++archiveReserved > remaining(type).maxArchivePerRun) { degraded=true; audit.skipped.push({ids:d.action === "conflict" ? [d.winner,d.loser] : d.ids,action:d.action,error:"cumulative pertype archive budget includes conflict loser"}); continue; }
          if (d.action === "conflict" && (config.conflictFreezeEnabled === true || !sameScope(typeSnapshot.get(d.winner), typeSnapshot.get(d.loser)))) {
            try {
              if (service.countConflictPending() < (config.conflictFreezeMaxPending ?? 100)) { const parked = service.saveConflictPending({ run_id: runId, memory_a: d.winner, memory_b: d.loser, reason: d.reason }); if (parked) { frozen++; outcome.byId[d.winner] = outcome.byId[d.loser] = "conflict-pending"; } }
              else { degraded = true; audit.skipped.push({ index: decisions.length, action: "conflict", ids: [d.winner, d.loser], error: "conflict pending queue full; memories untouched" }); }
            } catch (error) { degraded = true; audit.skipped.push({ index: decisions.length, action: "conflict", ids: [d.winner, d.loser], error: `conflict pending queue failed: ${String(error)}` }); }
          } else apply.push(d);
        }
        const before = list.map(d => d.action === "update" ? { ...d, _before: evidence(typeSnapshot.get(d.ids[0])) } : d);
        const resultApply = applyDecisions(apply, service, logger, typeSnapshot, { ...config, mintSource: "dream" });
        decisions.push(...before); committed.push(...resultApply.committed); applied += resultApply.applied; account(resultApply.committed,typeSnapshot);
        Object.assign(outcome.byId, buildOutcome(resultApply.committed).byId);
        outcome.conflicts.push(...resultApply.conflicts); outcome.failures.push(...resultApply.failures);
      }
      if (audit.status !== "failed") audit.status = audit.skipped.length ? "degraded" : "ok";
    } catch (error) { failedStages++; audit.status = "failed"; audit.error = String(error); }
  }
  // 整理线阶梯结果归纳（§3.3）：stage 失败 / 截断丢弃 / 被提出非 keep 决定
  // （invalid、护栏拒、已应用都算；台账过滤掉的永久护栏决定到不了这里）→ hold；
  // 入窗且清白 → advance（默认）。陪绑行被提出决定 → 拉回到期（hold）。
  if (incrementalOn) {
    const mark = ids => { for (const id of ids ?? []) if (inc.consolidation.due.has(id) || inc.consolidation.neighbors.has(id)) inc.consolidation.hold.add(id); };
    for (const audit of outcome.groups) {
      if (audit.status === "failed") for (const id of audit.input_ids) if (inc.consolidation.due.has(id)) inc.consolidation.hold.add(id);
      for (const s of audit.skipped) mark(s?.ids);
    }
    for (const d of decisions) if (d?.action !== "keep") mark(d.action === "conflict" || d.action === "supersede" ? [d.winner, d.loser] : d.ids);
    for (const c of outcome.cross_type_candidates) mark(c.evidence?.map(m => m.id));
    for (const id of consTruncatedDropped) inc.consolidation.hold.add(id);
  }
  // Sweep takes a fresh eligible snapshot AFTER consolidation, never stale archived ids.
  const sweepRows = eligible(service);
  // 增量模式（§5.2/§8）：切带/cap 作用在「到期 + 陪绑」集合上；sweepSnapshot 与
  // 裁决台账仍用全量 eligible（裁决与台账要能查到所有行）。非增量 = 现状逐字节。
  let sweepWindowRows = sweepRows;
  if (incrementalOn) {
    const sweepStates = service.getReviewStates("sweep");
    inc.sweep.states = sweepStates;
    const swSel = selectDue("sweep", sweepRows, sweepStates, nowMs, inc.fullReview);
    for (const e of swSel.due) inc.sweep.due.set(e.row.id, e);
    for (const e of swSel.sunk) inc.sweep.sunk.set(e.row.id, e);
    for (const e of swSel.notDue) inc.sweep.notDue.set(e.row.id, e);
    // 扫描线陪绑：全类型、k=NeighborK+2、全局上限 150（§5.1）。
    const swPool = [...swSel.notDue, ...swSel.sunk].map(e => e.row);
    for (const m of pickNeighbors({ seeds: swSel.due.filter(e => e.seed).map(e => e.row), pool: swPool, corpus: sweepRows, k: neighborK + 2, cap: SWEEP_NEIGHBOR_CAP }))
      inc.sweep.neighbors.set(m.id, m);
    sweepWindowRows = [...sweepRows.filter(m => inc.sweep.due.has(m.id)), ...inc.sweep.neighbors.values()];
  }
  const sweep = sweepWindows(sweepWindowRows);
  const sweepSnapshot = new Map(sweepRows.map(m => [m.id, m]));
  outcome.sweep = { status: "ok", total: sweep.total, covered_unique: sweep.covered, dropped: sweep.dropped, input_digest: hashSnapshot(sweepWindowRows), truncated: sweep.dropped > 0, coverage_note: "Pair co-presence covers the selected subsets, not guaranteed semantic recall; omitted rows have no coverage.", segments: sweep.segments.map(({ rows, ...s }) => s), stages: [], candidates: [] };
  const candidates = new Map();
  for (const window of sweep.windows) {
    const stage = { label: window.label, input_ids: window.rows.map(m => m.id), input_count: window.rows.length, input_digest: hashSnapshot(window.rows), status: "ok", rejected: [] };
    outcome.sweep.stages.push(stage);
    try {
      const raw = await call("dream_sweep", window.label, window.rows, STR.prompts.groupedSweep[language], window.rows.map(m => `id=${m.id} | type=${m.type} | updated=${m.updated_at} | title=${m.title}`).join("\n"));
      const supplied = new Set(stage.input_ids);
      for (const [index,c] of raw.entries()) {
         if(index >= 5) { stage.rejected.push({ids:[c?.a,c?.b],reason:"stage_candidate_cap"}); degraded=true; continue; }
        if (!c || Object.keys(c).some(k => !["a", "b", "reason"].includes(k)) || !supplied.has(c.a) || !supplied.has(c.b) || c.a === c.b || sweepSnapshot.get(c.a).type === sweepSnapshot.get(c.b).type || typeof c.reason !== "string" || !/^(strict_conflict|state_replacement|partial_correction)\s*[:：]/.test(c.reason)) { stage.rejected.push({ ids: [c?.a,c?.b], reason: "invalid sweep candidate", stage: window.label }); degraded = true; continue; }
        const [a, b] = [c.a, c.b].sort(), key = `${a}:${b}`;
        if (!candidates.has(key)) candidates.set(key, { a, b, status: "pending", transitions:["pending"], evidence: { a: evidence(sweepSnapshot.get(a)), b: evidence(sweepSnapshot.get(b)) }, provenance: [] });
        candidates.get(key).provenance.push({ stage: window.label, reason: c.reason });
      }
    } catch (error) { failedStages++; outcome.sweep.status = "degraded"; stage.status = "failed"; stage.error = String(error); }
  }
  for(const c of outcome.cross_type_candidates) {
    const [a,b]=c.evidence.map(m=>m.id).sort(),key=`${a}:${b}`;
    if(!candidates.has(key)) candidates.set(key,{a,b,status:"pending",transitions:["pending"],provenance:[]});
    candidates.get(key).provenance.push({stage:c.stage,reason:c.reason}); c.candidate_key=key;
  }
  for(const stage of outcome.sweep.stages) for(const item of stage.rejected) adjudicationSkipped.push({ids:item.ids??[],stage:stage.label,error:item.reason});
  if(sweep.dropped) { degraded=true; outcome.sweep.coverage_degraded_reason="segment selection omitted eligible rows"; }
  // 出口1 读取端：候选生成后、送裁决前查 resolved_keep 台账。跳过送审要求
  // verdict=keep ∧ 双方仍在 sweep 新鲜快照（active 口径与 eligible 一致）∧ 双方
  // 当前内容哈希与台账一致（NULL 哈希视为不匹配——空内容不洗白）∧ decided_at 未
  // 过 TTL。命中对 status=resolved_keep：不进裁决、不进 adjudicationSkipped
  // （explicit_keep_not_resolution 降级噪音就此剔除）、不算 stage 失败；
  // failedStages/degraded/status/基线推进语义零改动。哈希失配或 TTL 到期照常
  // 送审，写端审后 upsert 覆盖旧行。台账查询异常退化为「全量送审」——可用性优先。
  // （rowKeepHash / ledgerSkip 已上移到整理线循环之前，供 §4.3 决定过滤复用。）
  const toAdjudicate = [];
  let resolvedKeepSkipped = 0, ledgerCoolingSkipped = 0;
  for (const [key, c] of candidates) {
    let rec;
    try { rec = service.getConflictResolution?.(key); } catch { rec = undefined; }
    const ra = sweepSnapshot.get(c.a), rb = sweepSnapshot.get(c.b);
    if (ledgerOn) {
      const skip = ledgerSkip(rec, ra, rb);
      if (skip === "resolved") { c.status = "resolved_keep"; c.transitions.push("resolved_keep"); resolvedKeepSkipped++; continue; }
      if (skip === "cooling") { c.status = "ledger_cooling"; c.transitions.push("ledger_cooling"); ledgerCoolingSkipped++; continue; }
      toAdjudicate.push(c);
      continue;
    }
    const active = Boolean(ra && rb && !ra.archived && !ra.forgotten && !rb.archived && !rb.forgotten);
    const hashOk = Boolean(active && rec && rec.hash_a && rec.hash_b && rowKeepHash(ra) === rec.hash_a && rowKeepHash(rb) === rec.hash_b);
    const decidedAt = rec ? Date.parse(rec.decided_at ?? "") : NaN;
    const withinTtl = Number.isFinite(decidedAt) && Date.now() - decidedAt <= RESOLVED_KEEP_TTL_MS;
    if (rec?.verdict === "keep" && hashOk && withinTtl) { c.status = "resolved_keep"; c.transitions.push("resolved_keep"); resolvedKeepSkipped++; continue; }
    toAdjudicate.push(c);
  }
  outcome.sweep.resolved_keep_skipped = resolvedKeepSkipped;
  // 冷却跳过是台账预期收益，不是降级噪音：不进裁决、不进 adjudicationSkipped、不置 degraded。
  if (ledgerOn) outcome.sweep.ledger_cooling_skipped = ledgerCoolingSkipped;
  outcome.sweep.candidates = [...candidates.values()];
  // 扫描线阶梯结果归纳（§3.3）：stage 失败 / 带 cap 丢弃 / 裁决对成员（除显式
  // keep 落账与台账 resolved_keep）→ hold；入窗且不在任何候选对 → advance（默认）。
  // 陪绑行不计阶，被提出过决定的陪绑行拉回到期（hold）。
  if (incrementalOn) {
    for (const stage of outcome.sweep.stages) {
      // stage 失败 → 窗内到期行全体 hold；被 stage 拒掉的候选对（cap/invalid）
      // 也是「被提出过」→ 两端 hold。
      if (stage.status === "failed") for (const id of stage.input_ids) if (inc.sweep.due.has(id)) inc.sweep.hold.add(id);
      for (const item of stage.rejected) for (const id of item.ids ?? []) {
        if (inc.sweep.due.has(id)) inc.sweep.hold.add(id);
        else if (inc.sweep.neighbors.has(id)) inc.sweep.hold.add(id);
      }
    }
    for (const seg of outcome.sweep.segments) for (const id of seg.dropped_ids ?? []) if (inc.sweep.due.has(id)) inc.sweep.hold.add(id);
    for (const c of candidates.values()) {
      if (c.status === "resolved_keep") continue;
      const explicitKeep = Boolean(c.decisions?.some(l => l.verdict?.action === "keep"));
      const proposed = Boolean(c.decisions?.length || c.rejections?.length);
      for (const id of [c.a, c.b]) {
        if (inc.sweep.due.has(id)) { if (!explicitKeep) inc.sweep.hold.add(id); }
        else if (inc.sweep.neighbors.has(id) && proposed) inc.sweep.hold.add(id);
      }
    }
  }
  const receiptSnapshot = new Map(snapshot);
  const adjudication = await adjudicateCandidates({ candidates:toAdjudicate, service, config, call, claims, remaining, account, runId, logger, evidence, sameScope, snapshot:receiptSnapshot, route, now: nowMs, wrapBody: body => fenceListBody(language, body, "json") });
  outcome.adjudication=adjudication.audit; adjudicationSkipped.push(...adjudication.skipped);
  decisions.push(...adjudication.decisions); committed.push(...adjudication.committed); applied+=adjudication.applied; frozen+=adjudication.frozen;
  Object.assign(outcome.byId,buildOutcome(adjudication.committed).byId);
  outcome.conflicts.push(...adjudication.conflicts); outcome.failures.push(...adjudication.failures);
  outcome.supersedes = committed.filter(c => c.action === "supersede").length;
  degraded ||= adjudication.degraded; failedStages+=adjudication.failed;
  outcome.budgets=Object.fromEntries(budget);
  try { for (const r of buildRecordReceipts({ runId, committed, snapshot:receiptSnapshot, policyEpoch: config.policyEpoch ?? 0 })) service.saveReceipt(r); } catch (error) { outcome.receipt_error = String(error); degraded = true; }
  if (semantic?.embedder && semantic?.vectorIndex) { try { await maintainIndexAfterDream(committed, service, semantic); } catch { degraded = true; } }

  try {
    const all = eligible(service), max = config.dreamSummaryMaxInputs ?? 0, rows = max > 0 ? all.slice(0, max) : all;
    const text = await call("dream_summarize", "summary", rows, STR.prompts.dreamSummary[language], rows.map(m => `- ${m.title}: ${m.content}`).join("\n"), true);
    if (text.trim()) { service.saveWithDedupe({ type: "summary", title: STR.summaryTitle[language], content: text.trim() + STR.summaryScope[language](rows.length, runId.slice(0, 8), started.slice(0, 10)), importance: 5, source: "dream", _overwrite: true }); summaryStored = true;
      if (semantic?.embedder && semantic?.vectorIndex) { try { const fresh = service.all().find(m => m.type === "summary" && m.source === "dream"); if (fresh) await reEmbedMemory(semantic, fresh, logger); } catch (error) { outcome.summary_embedding_error = String(error); degraded = true; } }
    }
    outcome.summary = { status: summaryStored ? "ok" : "empty", input_count: rows.length };
  } catch (error) { failedStages++; outcome.summary = { status: "failed", error: String(error) }; }
  return finish();
}
