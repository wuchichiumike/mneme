// 本地补丁：只读工作区——消费点（蒸馏、续接提案）。与 continuity.test.js 同一环境
// 前提（宿主提供 @deepseek-ai/dsh-llm）；闸门只在 lib/，所以从 lib/ 导入。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionGate } from "../lib/session-gate.js";
import { createContinuityRescue, CONTINUITY_NOTICE_PREFIX } from "../lib/continuity.js";
import { createSummarizer } from "../lib/summarize.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mneme-ro-cons-")));
const RO = join(root, "Incognito");
mkdirSync(RO, { recursive: true });
mkdirSync(join(root, "normal"), { recursive: true });

function mockCtx() {
  const handlers = new Map();
  return {
    logger: { warn() {}, info() {} },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    fire(name, ...args) { return handlers.get(name)?.(...args); }
  };
}
const userEvent = (seq, text) => ({ type: "user/message", seq, data: { content: [{ type: "text", text }], source: { kind: "user" } } });
const mkSession = (id, cwd) => ({ id, header: { cwd }, snapshotEvents: () => [userEvent(1, "在只读区里干活")], append() {} });

test("续接：只读工作区不落提案，但会话内续接提示照常注入", async () => {
  const saved = [];
  const store = { saveContinuityProposal: (p) => { saved.push(p); return { id: "x", created: true, dropped: false }; } };
  const ctx = mockCtx();
  const gate = createSessionGate({ sessionGateReadOnlyWorkspaces: [RO] });
  const rescue = createContinuityRescue(ctx, store, gate);
  const step = (s) => ctx.fire("agent/pre-step", { agent: { session: s } }, async () => ({ kind: "enter", messages: [] }));

  const ro = mkSession("ro-1", RO);
  ctx.fire("session/event", ro, { type: "compaction/end", seq: 3 });
  const d1 = await step(ro);
  assert.equal(saved.length, 0, "只读工作区：提案不落库");
  assert.equal(d1.messages.length, 1, "续接提示照常注入");
  assert.ok(d1.messages[0].content[0].text.startsWith(CONTINUITY_NOTICE_PREFIX));

  const normal = mkSession("n-1", join(root, "normal"));
  ctx.fire("session/event", normal, { type: "compaction/end", seq: 4 });
  await step(normal);
  assert.equal(saved.length, 1, "普通会话照旧落提案");
  assert.equal(saved[0].sessionId, "n-1");
  rescue.dispose();
});

test("蒸馏：只读工作区的 turn/end 不触发蒸馏（连路由头都不读）", async () => {
  const ctx = mockCtx();
  const gate = createSessionGate({ sessionGateReadOnlyWorkspaces: [RO] });
  const summarizer = createSummarizer(ctx, {}, { autoSummarize: true }, {}, gate);
  let touched = 0;
  const probe = (id, cwd) => ({
    id,
    header: { cwd },
    requestHeader() { touched += 1; throw new Error("probe: summarize proceeded past the gate"); },
    snapshotEvents() { touched += 1; return []; }
  });
  await ctx.fire("session/event", probe("ro-2", join(RO, "x")), { type: "turn/end", seq: 9 });
  assert.equal(touched, 0, "只读工作区会话在闸门处就返回");
  await ctx.fire("session/event", probe("n-2", join(root, "normal")), { type: "turn/end", seq: 9 });
  assert.ok(touched > 0, "对照：普通会话越过闸门（探针被触碰）");
  summarizer.dispose();
});
