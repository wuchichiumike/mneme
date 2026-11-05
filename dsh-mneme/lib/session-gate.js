import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

// #539 逐会话无痕闸门：总开关关闭时保留既有行为；每个消费点读取同一份配置，
// 因此配置对象更新后，下一次操作即按新值判定。
//
// 两档语义（本地补丁：只读工作区）：
//   · isOff(s)      —— 全无痕：注入、蒸馏、工具、观测全部静默（子代理 / 手动名单）。
//   · isWriteOff(s) —— 只禁写：isOff 的超集。另含 cwd 落在 sessionGateReadOnlyWorkspaces
//                      里的会话：不蒸馏、不出观测/续接提案、写类记忆工具拒绝，
//                      但记忆注入与只读检索照常。
// 只读工作区名单不受 sessionGateEnabled 约束：名单默认空 = 零行为变化；用户写了
// 名单就是明确要它生效，不该再被另一个开关静默架空（fail-closed 一侧）。
const MAX_TRACKED = 4096;

/** `~` 展开 + 绝对化 + realpath（取不到就用 resolve 结果），去尾分隔符。 */
export function normalizeWorkspacePath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  let s = p.trim();
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  s = resolve(s);
  try {
    s = realpathSync(s);
  } catch {
    // 目录不存在或不可读：按字面路径比较，仍然可以命中。
  }
  return s.length > 1 && s.endsWith(sep) ? s.slice(0, -1) : s;
}

/** child 是否等于 root 或位于其下（按路径段比较，/a/bc 不算 /a/b 的子目录）。 */
export function isWithin(child, root) {
  if (!child || !root) return false;
  if (child === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(base);
}

export function createSessionGate(config) {
  const childSessions = new Set();
  // 观测到的只读工作区会话 id：pipeline-nudge 的文件扫描只拿得到 id，要靠这里补齐。
  const readOnlySessions = new Set();
  const realpathCache = new Map();

  const read = (target, key) => {
    try {
      return target?.[key];
    } catch {
      return undefined;
    }
  };

  const headerOf = (session) => {
    const header = read(session, "header");
    if (header && typeof header === "object") return header;
    try {
      const requestHeader = read(session, "requestHeader");
      const request = typeof requestHeader === "function" ? requestHeader.call(session) : null;
      const fallback = read(request, "config");
      return fallback && typeof fallback === "object" ? fallback : null;
    } catch {
      return null;
    }
  };

  const isChild = (session) => {
    const header = headerOf(session);
    const parent = read(session, "parentSession")
      ?? read(session, "parentSessionId")
      ?? read(header, "parentSession")
      ?? read(header, "parentSessionId");
    if (typeof parent === "string" && parent.length > 0) return true;
    return read(header, "origin") === "subagent" || Number(read(header, "delegationDepth")) > 0;
  };

  const idOf = (sessionOrId) => {
    if (typeof sessionOrId === "string") return sessionOrId || null;
    const id = read(sessionOrId, "id");
    return typeof id === "string" && id.length > 0 ? id : null;
  };

  const cachedRealpath = (p) => {
    if (realpathCache.has(p)) return realpathCache.get(p);
    const n = normalizeWorkspacePath(p);
    if (realpathCache.size >= MAX_TRACKED) realpathCache.delete(realpathCache.keys().next().value);
    realpathCache.set(p, n);
    return n;
  };

  const readOnlyRoots = () => {
    const list = read(config, "sessionGateReadOnlyWorkspaces");
    if (!Array.isArray(list) || list.length === 0) return [];
    return list.map((p) => (typeof p === "string" ? cachedRealpath(p) : null)).filter(Boolean);
  };

  const cwdOf = (session) => {
    const cwd = read(headerOf(session), "cwd");
    return typeof cwd === "string" && cwd.trim() ? cwd : null;
  };

  /** 只看会话对象自身：cwd 是否落在只读工作区。 */
  const inReadOnlyWorkspace = (session) => {
    if (!session || typeof session !== "object") return false;
    const roots = readOnlyRoots();
    if (roots.length === 0) return false;
    const cwd = cwdOf(session);
    if (!cwd) return false;
    const n = cachedRealpath(cwd);
    return roots.some((root) => isWithin(n, root));
  };

  const observe = (session) => {
    const id = idOf(session);
    if (!id) return;
    if (isChild(session)) childSessions.add(id);
    if (inReadOnlyWorkspace(session)) readOnlySessions.add(id);
  };

  const isEnabled = () => read(config, "sessionGateEnabled") === true;

  const isOff = (sessionOrId) => {
    if (!isEnabled()) return false;
    const id = idOf(sessionOrId);
    if (!id) return false;
    const sessions = read(config, "sessionGateSessions");
    if (Array.isArray(sessions) && sessions.includes(id)) return true;
    if (read(config, "sessionGateSubagents") === false) return false;
    if (childSessions.has(id)) return true;
    return typeof sessionOrId === "object" && isChild(sessionOrId);
  };

  const isWriteOff = (sessionOrId) => {
    if (isOff(sessionOrId)) return true;
    if (readOnlyRoots().length === 0) return false;
    // 会话对象优先按自身 cwd 判（不依赖先 observe 过）；只有 id 时查观测记录。
    if (typeof sessionOrId === "object" && inReadOnlyWorkspace(sessionOrId)) return true;
    const id = idOf(sessionOrId);
    return id ? readOnlySessions.has(id) : false;
  };

  /** 文件扫描用：任一闸门有内容才需要逐会话过滤。 */
  const needsFiltering = () => isEnabled() || readOnlyRoots().length > 0;

  return { observe, isEnabled, isOff, isWriteOff, needsFiltering, inReadOnlyWorkspace };
}
