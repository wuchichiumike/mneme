// Opt-in grouped consolidation. Legacy dream and sleep retain their contracts.
import { randomUUID } from "node:crypto";
import { validateDecisions, applyDecisions } from "./decisions.js";
import { isImportedRow } from "../memory-source.js";
import { scopeKeyOf } from "../scope.js";
import { adjudicateCandidates } from "./adjudication.js";
import { contentHashOf } from "../content-hash.js";
import { STR, langOf } from "../lang.js";

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
  const started = new Date().toISOString(), runId = randomUUID(), route = resolveRoute(ctx, config, logger);
  const initialEligible = eligible(service);
  const groups = consolidationGroups(initialEligible, Number.isInteger(config.dreamGroupedWindow) ? Math.max(1, Math.min(CONSOLIDATION_GROUP_CAP, config.dreamGroupedWindow)) : CONSOLIDATION_GROUP_CAP);
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
  let applied = 0, summaryStored = false, failedStages = 0, degraded = unsupported.length > 0, frozen = 0;
  // Truncation still drops rows exactly as before; this only removes the silence (degraded, never a failed stage).
  for (const g of groups) if (g.truncation) { degraded = true; outcome.degradations.push({ kind: "consolidation_truncated", group: g.types.join("+"), ...g.truncation }); }
  const finish = () => {
    const status = outcome.conflicts.length || outcome.failures.length ? "reconcile" : failedStages ? (applied || summaryStored ? "degraded" : "failed") : degraded ? "degraded" : applied || summaryStored || frozen ? "ok" : "noop";
    const ok = status === "ok" || status === "degraded" && failedStages === 0;
    const receipt = buildReceipt({ runId, status, snapshotHash, inputCount: snapshot.size, applied, summaryStored });
    let baseline;
    if (ok) { const rows = eligible(service); baseline = { count: rows.length, chars: rows.reduce((n, m) => n + (m.title?.length ?? 0) + (m.content?.length ?? 0), 0) }; }
    try { service.saveDreamRun({ id: runId, created_at: started, status, error: failedStages ? `${failedStages} stage(s) failed` : undefined, provider: route?.provider, model: route?.model, input_count: snapshot.size, snapshot_hash: snapshotHash, input: [...snapshot.values()].map(evidence), decisions, outcome, skipped: [...outcome.groups.flatMap(g => g.skipped.map(s => ({ ...s, stage: g.types.join("+") }))), ...adjudicationSkipped], applied, summary_stored: summaryStored, receipt, policy_epoch: config.policyEpoch ?? 0, store_count: baseline?.count, store_chars: baseline?.chars }); } catch (error) { logger?.warn?.(`grouped dream audit failed: ${String(error)}`); }
    return { ok, status, runId, snapshotHash, receipt, applied, summary: summaryStored, narratives: 0, frozen, outcome, usage, baseline };
  };
  if (!route) { failedStages++; outcome.error = "no llm route"; return finish(); }
  // Unlike legacy fallback, an explicitly selected effort is never silently removed.
  const effort = config.dreamReasoningEffort && config.dreamReasoningEffort !== "none"
    ? config.dreamReasoningEffort
    : await resolveDreamEffort(ctx, route, config.dreamReasoningEffort, logger);
  const call = async (operationType, label, rows, prompt, body, summary = false) => {
    let streamFailure = "";
    const selectedRoute = summary && config.dreamSummaryProvider && config.dreamSummaryModel ? { provider: config.dreamSummaryProvider, model: config.dreamSummaryModel } : route;
    const run = tokens => runAuditedLlm(ctx, service, config, {
      triggerSource: "autoDream", operationType, modelId: `${selectedRoute.provider}:${selectedRoute.model}`,
      relatedMemoryIds: rows.map(m => m.id), streamError: () => streamFailure,
      auditError: text => { if (summary) return null; try { parseArray(text); return null; } catch { return "no JSON array"; } },
      metadataFrom: () => ({ mode: "grouped", stage: label, input_count: rows.length, reasoning_effort: operationType === "dream_adjudicate" ? "low" : effort, provider: selectedRoute.provider, model: selectedRoute.model })
    }, reportUsage => streamText(ctx, { ...selectedRoute, purpose: "compaction", maxTokens: tokens, ...(operationType === "dream_adjudicate" ? {reasoningEffort:"low"} : effort ? { reasoningEffort: effort } : {}), messages: [
      { role: "system", content: [{ type: "text", text: prompt }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } },
      { role: "user", content: [{ type: "text", text: fenceListBody(language, body, summary ? "text" : "json") }], source: { kind: "plugin:dsh-mneme", plugin: "dsh-mneme" } }
    ] }, u => { usage.push({ stage: label, ...u }); reportUsage(u); }, reason => { streamFailure = describeStreamFailure(reason); }));
    const text = operationType === "dream_adjudicate" ? await run(config.dreamMaxTokens ?? 131072) : await withMaxTokensFallback(ctx, config.dreamMaxTokens ?? 131072, run, () => streamFailure);
    if (text === undefined) throw new Error(streamFailure || "stream failed");
    return summary ? text : parseArray(text);
  };
  for (const group of groups) {
    const audit = { types: group.types, input_ids: group.rows.map(m => m.id), input_count: group.rows.length, input_digest: hashSnapshot(group.rows), status: "skipped", skipped: [] };
    outcome.groups.push(audit);
    if (!group.rows.length) continue;
    try {
      const raw = await call("dream_consolidate", group.types.join("+"), group.rows,
        STR.prompts.consolidation[language] + "\n" + STR.prompts.groupedGuard[language] + `\nnow=${new Date().toISOString()}; update <= ${config.reflectionUpdateMaxPerRun ?? 2}, archive <= ${config.dreamMaxArchivePerRun ?? 8}, merge <= ${config.dreamMaxMergePerRun ?? 40} decisions PER TYPE. Minimum update age ${config.reflectionUpdateMinAgeHours ?? 24} hours.`,
        group.rows.map(m => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | created=${m.created_at} | scope=${JSON.stringify([m.agent_scope, m.workspace_scope])} | title=${m.title} | content=${m.content}`).join("\n"));
      const partitions = new Map(group.types.map(t => [t, []]));
      const localSnapshot = new Map(group.rows.map(m => [m.id, m]));
      let reviewedCrossType = 0;
      for (const [index, d] of raw.entries()) {
        const ids = d?.action === "conflict" ? [d.winner, d.loser] : d?.ids;
        const rows = Array.isArray(ids) ? ids.map(id => localSnapshot.get(id)) : [];
        const types = new Set(rows.map(m => m?.type));
        if (d?.action === "conflict" && rows.length === 2 && rows.every(Boolean) && ids[0] !== ids[1] && types.size === 2) {
          outcome.cross_type_candidates.push({ status: "pending_body_review", stage: group.types.join("+"), reason: d.reason, evidence: rows.map(evidence) });
          degraded = true; reviewedCrossType++;
          continue;
        }
        if (!["keep", "merge", "archive", "update", "conflict"].includes(d?.action) || !rows.length || rows.some(m => !m) || types.size !== 1 || (d.action === "merge" && (new Set(ids).size < 2 || rows.some(m => !sameScope(rows[0], m)) || d.importance !== Math.max(...rows.map(m => m.importance))))) {
          audit.skipped.push({ index, action: d?.action, ids: Array.isArray(ids) ? ids : [], error: "invalid grouped schema, type, scope, or lossless merge importance" }); continue;
        }
        partitions.get(rows[0].type).push(d);
      }
      if (audit.skipped.length && config.dreamSkipInvalid === false) throw new Error("invalid grouped decisions in strict mode");
      if (raw.length && !reviewedCrossType && ![...partitions.values()].some(p => p.length)) throw new Error("all grouped decisions invalid");
      if (audit.skipped.length) degraded = true;
      for (const [type, list] of partitions) {
        const typeSnapshot = new Map(group.rows.filter(m => m.type === type).map(m => [m.id, m]));
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
  // Sweep takes a fresh eligible snapshot AFTER consolidation, never stale archived ids.
  const sweepRows = eligible(service), sweep = sweepWindows(sweepRows);
  const sweepSnapshot = new Map(sweepRows.map(m => [m.id, m]));
  outcome.sweep = { status: "ok", total: sweep.total, covered_unique: sweep.covered, dropped: sweep.dropped, input_digest: hashSnapshot(sweepRows), truncated: sweep.dropped > 0, coverage_note: "Pair co-presence covers the selected subsets, not guaranteed semantic recall; omitted rows have no coverage.", segments: sweep.segments.map(({ rows, ...s }) => s), stages: [], candidates: [] };
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
  const rowKeepHash = m => m?.content_hash ?? contentHashOf(m) ?? null;
  const toAdjudicate = [];
  let resolvedKeepSkipped = 0;
  for (const [key, c] of candidates) {
    let rec;
    try { rec = service.getConflictResolution?.(key); } catch { rec = undefined; }
    const ra = sweepSnapshot.get(c.a), rb = sweepSnapshot.get(c.b);
    const active = Boolean(ra && rb && !ra.archived && !ra.forgotten && !rb.archived && !rb.forgotten);
    const hashOk = Boolean(active && rec && rec.hash_a && rec.hash_b && rowKeepHash(ra) === rec.hash_a && rowKeepHash(rb) === rec.hash_b);
    const decidedAt = rec ? Date.parse(rec.decided_at ?? "") : NaN;
    const withinTtl = Number.isFinite(decidedAt) && Date.now() - decidedAt <= RESOLVED_KEEP_TTL_MS;
    if (rec?.verdict === "keep" && hashOk && withinTtl) { c.status = "resolved_keep"; c.transitions.push("resolved_keep"); resolvedKeepSkipped++; continue; }
    toAdjudicate.push(c);
  }
  outcome.sweep.resolved_keep_skipped = resolvedKeepSkipped;
  outcome.sweep.candidates = [...candidates.values()];
  const receiptSnapshot = new Map(snapshot);
  const adjudication = await adjudicateCandidates({ candidates:toAdjudicate, service, config, call, claims, remaining, account, runId, logger, evidence, sameScope, snapshot:receiptSnapshot, route, wrapBody: body => fenceListBody(language, body, "json") });
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
