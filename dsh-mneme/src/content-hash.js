// #254 写入准入的确定性计量锚：内容归一化哈希（exact duplicate 判定）。
//
// 为什么用哈希而不是相似度：计量阶段要的是一个零成本、可复算、不留争议的判据。
// 相似度阈值两边都是误判——同一件事换个说法就掉到线下，不同的事共享话题词又顶到
// 线上，阈值往哪边挪都只是换一种错法（#254 拍板：计量信号用内容哈希）。哈希只认
// 「归一化后逐字节相同」，算不出来就只有一种解释。
//
// 但它不等于「原文逐字节相同」：归一化会折掉格式，也会折掉标点，于是 `版本 3.5` 与
// `版本 35`、`a-b` 与 `ab` 落同一个键。折叠范围（大小写 / 空白 / 标点）是口径本身
// 定的，#254 已拍板——误报面在计量阶段可接受（只标记、不拦截），但「命中即精确重复」
// 这句话别升级成「命中即内容相同」。要更窄的判据就得改归一化口径，而那要带存量重算。
//
// 归一化口径一次定死（NFKC → 小写 → 去标点 → 空白折叠 → trim），动机是让「只差
// 格式」的两次写入落在同一个键上：全角/半角、大小写、行内换行与缩进、句末标点都
// 不该让同一件事变成两条。反过来它不折叠同义词、不排序词序——那些只能靠相似度，
// 而相似度已判定不可用于本信号。
//
// 改口径必须带存量重算策略：memories.content_hash 是派生列，口径一变，库里已有的
// 值全部按旧口径算——补 NULL 修不好，只能整列重算（UPDATE 全表 + 重建索引）。
// 所以口径只能在这里改，且改要单独成批，不要混进别的改动里。
//
// 空内容（标题与正文归一后都为空）返回 null：这类写入没有可比内容，落 NULL 让它们
// 不互相匹配成「全是重复」。
//
// 另有一处形状相近、口径不同的哈希：service.js 里镜像人工编辑的 digest 校验（两处）
// 用 sha256(title\0content)，那里**不**归一化（要逐字节保真）。两把哈希用途不同，别互换。
import { createHash } from "node:crypto";

/**
 * 归一化一段文本用于内容比对（口径见文件头）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeForHash(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{P}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 一行记忆的内容锚：标题与正文分别归一后用 NUL 拼接再取 sha256（十六进制全串）。
 * NUL 分隔是防拼接歧义——('ab','c') 与 ('a','bc') 不能落到同一个键上。
 * @param {{title?: string, content?: string}|null|undefined} memory
 * @returns {string|null} 归一后无内容时返回 null
 */
export function contentHashOf(memory) {
  const title = normalizeForHash(memory?.title);
  const content = normalizeForHash(memory?.content);
  if (!title && !content) return null;
  return createHash("sha256").update(`${title}\u0000${content}`).digest("hex");
}

/**
 * 送审阶梯的正文锚（设计文档 §3.1）：与 contentHashOf 同形状（title NUL content
 * 取 sha256），但**不做任何归一化**——`版本 3.5` 与 `版本 35` 在这里是两个键，
 * 这正是阶梯要的语义：格式/标点级的改动也算「正文变了 → 回窗重审」。
 * 空串照常哈希，永不返回 null：阶梯需要一个永不为 NULL 的比较锚，
 * 「没有内容」本身也是一种内容状态。与 service.js 镜像 digest 同口径。
 * @param {{title?: string, content?: string}|null|undefined} memory
 * @returns {string} 十六进制全串
 */
export function strictHashOf(memory) {
  const title = memory?.title ?? "";
  const content = memory?.content ?? "";
  return createHash("sha256").update(`${title}\u0000${content}`).digest("hex");
}
