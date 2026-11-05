// 本地补丁：只读工作区——工具包装层。lib/tools.js 依赖宿主提供的
// @deepseek-ai/dsh-tools，与 test/tools*.test.js 同一环境前提。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionGate } from "../lib/session-gate.js";
import { Config } from "../lib/config.js";
import { isWriteToolCall, createTools } from "../lib/tools.js";
import { createStore } from "../lib/store.js";
import { createService } from "../lib/service.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mneme-ro-tools-")));
const RO = join(root, "Incognito");
mkdirSync(RO, { recursive: true });
mkdirSync(join(root, "normal"), { recursive: true });
const session = (id, cwd) => ({ id, header: { cwd } });

test("写类工具判定：save/update/delete/forget/archive/register 与 organize apply 算写", () => {
  for (const n of ["memory_save", "memory_update", "memory_delete", "memory_forget", "memory_archive", "memory_register_document"]) {
    assert.equal(isWriteToolCall(n, {}), true, n);
  }
  assert.equal(isWriteToolCall("memory_organize", { mode: "apply" }), true);
  assert.equal(isWriteToolCall("memory_organize", { mode: " apply " }), true);
  assert.equal(isWriteToolCall("memory_organize", {}), false);
  assert.equal(isWriteToolCall("memory_organize", { mode: "dryRun" }), false);
  for (const n of ["memory_search", "memory_list", "memory_get", "memory_runtime"]) {
    assert.equal(isWriteToolCall(n, {}), false, n);
  }
});

test("工具包装：只读工作区里 memory_save 被拒、memory_search 照常；普通会话可写", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = new Map();
  const ctx = { tools: { register(def) { registered.set(def.name, def); return () => {}; } } };
  const config = Config({ sessionGateReadOnlyWorkspaces: [RO] });
  createTools(ctx, service, config, null, createSessionGate(config));
  const exec = (cwd, id) => ({ agent: { session: session(id, cwd) } });
  const save = registered.get("memory_save");
  const search = registered.get("memory_search");
  const args = { type: "decision", title: "ro probe", content: "should not land in read-only workspace" };

  await assert.rejects(save.execute(args, exec(RO, "t-ro")), /read-only workspace/);

  await save.execute({ ...args, title: "normal probe" }, exec(join(root, "normal"), "t-n"));
  const res = await search.execute({ query: "normal probe" }, exec(RO, "t-ro"));
  assert.match(JSON.stringify(res), /normal probe/);
  // 被拒的那条确实没落库
  const miss = await search.execute({ query: "should not land in read-only workspace" }, exec(join(root, "normal"), "t-n"));
  assert.doesNotMatch(JSON.stringify(miss), /ro probe/);
  // organize dryRun 不算写，不被闸门拦（organizeEnabled 关时工具不存在则跳过）
});
