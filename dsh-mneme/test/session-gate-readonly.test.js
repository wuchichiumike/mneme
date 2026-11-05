// 本地补丁：只读工作区（sessionGateReadOnlyWorkspaces）。会话闸门只在 lib/ 里
// （#539 本地补丁同口径），所以这里直接从 lib/ 导入。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { createSessionGate, isWithin, normalizeWorkspacePath } from "../lib/session-gate.js";
import { Config } from "../lib/config.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mneme-ro-")));
const RO = join(root, "Incognito");
mkdirSync(join(RO, "sub", "deep"), { recursive: true });
mkdirSync(join(root, "Incognito-other"), { recursive: true });
mkdirSync(join(root, "normal"), { recursive: true });

const session = (id, cwd, extra = {}) => ({ id, header: { cwd, ...extra } });

test("config：默认空名单、接受字符串数组", () => {
  assert.deepEqual(Config({}).sessionGateReadOnlyWorkspaces, []);
  assert.deepEqual(Config({ sessionGateReadOnlyWorkspaces: [RO] }).sessionGateReadOnlyWorkspaces, [RO]);
});

test("名单为空：isWriteOff 与旧 isOff 完全一致（零行为变化）", () => {
  const gate = createSessionGate({ sessionGateEnabled: true });
  const s = session("s1", RO);
  assert.equal(gate.isWriteOff(s), false);
  assert.equal(gate.isOff(s), false);
  assert.equal(gate.needsFiltering(), true); // 总开关开着，原本就过滤
  const child = session("c1", "/tmp", { origin: "subagent" });
  assert.equal(gate.isWriteOff(child), true);
  assert.equal(createSessionGate({}).needsFiltering(), false);
});

test("工作区本身与子目录命中；同前缀兄弟目录、无关目录不命中", () => {
  const gate = createSessionGate({ sessionGateReadOnlyWorkspaces: [RO] });
  assert.equal(gate.isWriteOff(session("a", RO)), true);
  assert.equal(gate.isWriteOff(session("b", join(RO, "sub", "deep"))), true);
  assert.equal(gate.isWriteOff(session("c", RO + "/")), true);
  assert.equal(gate.isWriteOff(session("d", join(root, "Incognito-other"))), false);
  assert.equal(gate.isWriteOff(session("e", join(root, "normal"))), false);
  assert.equal(gate.isWriteOff(session("f", undefined)), false);
});

test("只禁写不禁注入：只读工作区会话 isOff=false（注入/检索照常）", () => {
  const gate = createSessionGate({ sessionGateEnabled: true, sessionGateReadOnlyWorkspaces: [RO] });
  const s = session("r1", RO);
  assert.equal(gate.isOff(s), false);
  assert.equal(gate.isWriteOff(s), true);
});

test("不受 sessionGateEnabled 约束（名单即生效）", () => {
  const gate = createSessionGate({ sessionGateEnabled: false, sessionGateReadOnlyWorkspaces: [RO] });
  assert.equal(gate.isWriteOff(session("r2", RO)), true);
  assert.equal(gate.needsFiltering(), true);
});

test("只有 id 时：observe 过的只读会话仍判 writeOff（文件扫描路径）", () => {
  const gate = createSessionGate({ sessionGateReadOnlyWorkspaces: [RO] });
  assert.equal(gate.isWriteOff("r3"), false);
  gate.observe(session("r3", join(RO, "sub")));
  gate.observe(session("n3", join(root, "normal")));
  assert.equal(gate.isWriteOff("r3"), true);
  assert.equal(gate.isWriteOff("n3"), false);
});

test("路径归一：~ 展开、符号链接 realpath、尾斜杠", () => {
  const link = join(root, "link-to-ro");
  symlinkSync(RO, link);
  const gate = createSessionGate({ sessionGateReadOnlyWorkspaces: [link + "/"] });
  assert.equal(gate.isWriteOff(session("l1", join(RO, "sub"))), true);
  const gate2 = createSessionGate({ sessionGateReadOnlyWorkspaces: [RO] });
  assert.equal(gate2.isWriteOff(session("l2", join(link, "sub"))), true);
  assert.equal(normalizeWorkspacePath("~"), realpathSync(homedir()));
  assert.equal(isWithin("/a/bc", "/a/b"), false);
  assert.equal(isWithin("/a/b/c", "/a/b"), true);
});

test("配置热更新：下一次判定即按新名单", () => {
  const cfg = { sessionGateReadOnlyWorkspaces: [] };
  const gate = createSessionGate(cfg);
  const s = session("h1", RO);
  assert.equal(gate.isWriteOff(s), false);
  cfg.sessionGateReadOnlyWorkspaces = [RO];
  assert.equal(gate.isWriteOff(s), true);
});
