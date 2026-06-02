// 正文内联 @ 解析（Phase 3 bug 修复，纯逻辑、无 discord.js / 无 DB，便于 pI-smoke 单测）。
//
// 背景：bot（尤其 PM）常按其系统提示在「回复正文里内联写 @对方名字」来派活（如 `owner:@程序-Juanda`、
// `@程序-Juanda 请实现X`），而非显式调用 mention_bot 工具。这些只是**纯文本**，不是真实 Discord 提及，
// 对方收不到（表现为「@ 失败，尤其当 @ 出现在消息中间时」）。本模块负责从正文里识别出「@同项目同伴名」，
// 由 bot-manager 把它们转成真实 `<@id>` 提及 + 登记转交 relay，让对方接力处理。
//
// 名字匹配口径（用户选定）：**精确全名 + 短横线前缀别名**。即同伴「程序-Juanda」既能被 `@程序-Juanda`
// 命中，也能被 `@程序`（'-' 前的前缀别名）命中——但别名仅在「全局唯一且不与任何同伴全名冲突」时才启用，
// 避免歧义误判。

/** 一个同伴可被内联 @ 命中的句柄集合：完整名 + （可选、唯一时）短横线前缀别名。 */
export interface PeerHandle {
  /** 同伴的规范名（= bot 名），作为 scanPeerMentions 输出的键、后续按名解析目标。 */
  name: string;
  /** 额外可命中的别名（当前仅「'-' 前缀」，且全局唯一时才有）。 */
  aliases: string[];
}

/** 取「'-' 前的前缀」作为候选别名（如 程序-Juanda → 程序、PM-Louie → PM）。无 '-' 或前缀为空则无别名。 */
export function prefixAlias(name: string): string | undefined {
  const trimmed = name.trim();
  const idx = trimmed.indexOf('-');
  if (idx <= 0) return undefined; // 无 '-' 或以 '-' 开头（前缀为空）
  const alias = trimmed.slice(0, idx).trim();
  return alias.length > 0 ? alias : undefined;
}

/**
 * 由同伴名单计算每个同伴的内联 @ 句柄 = 完整名 + 可选别名。别名候选来自三处：
 *  ① name 的 '-' 前缀（如 程序-Juanda → 程序）；
 *  ② bot 的岗位 role（如 策划 / 程序）—— 让模型按岗位 @ 也能命中（PM 派活提示里常写 `owner:@程序`、`@策划`）；
 *  ③ 「岗位-代号」组合（如 策划-Dannis）—— 兼容「岗位-名字」这种历史/口语写法（bot 改短名后旧习惯仍可用）。
 * 别名仅在满足全部条件时启用，避免歧义误判：
 *  · 非空且 ≠ 自身全名；· 不与任何同伴的全名相同；· 在所有同伴的候选别名里全局唯一（不被多个同伴共享）。
 * 任一不满足 → 丢弃该别名；同伴至少保留全名句柄。
 *
 * 背景：bot 的 Discord 名常被改成短名（如「策划-Dannis」→「Dannis」），而系统提示/团队花名册按**岗位**
 * 称呼同伴，模型据此写出 `@策划` / `@策划-Dannis`——若只认全名「Dannis」则全部 @ 失败（实测「没@成功」根因）。
 */
export function computePeerHandles(peers: { name: string; role?: string }[]): PeerHandle[] {
  const fullNames = new Set(peers.map((p) => p.name.trim()));
  // 每个同伴的候选别名集合（同伴内部先去重，避免「岗位」与「前缀」恰好相同时被误判为跨同伴共享）。
  const candidates = peers.map((p) => {
    const name = p.name.trim();
    const role = (p.role ?? '').trim();
    const set = new Set<string>();
    const pre = prefixAlias(p.name);
    if (pre) set.add(pre);
    if (role) {
      set.add(role);
      set.add(`${role}-${name}`);
    }
    return set;
  });
  // 统计每个候选别名在所有同伴中出现的次数（唯一性判定：>1 即多个同伴共享 → 歧义，作废）。
  const aliasCount = new Map<string, number>();
  for (const set of candidates) for (const a of set) aliasCount.set(a, (aliasCount.get(a) ?? 0) + 1);
  return peers.map((p, i) => {
    const name = p.name.trim();
    const aliases: string[] = [];
    for (const a of candidates[i]!) {
      if (a && a !== name && !fullNames.has(a) && aliasCount.get(a) === 1) aliases.push(a);
    }
    return { name, aliases };
  });
}

/**
 * 工具路径（mention_bot(bot_name)）用：把调用方给的 bot_name（可能是全名 / 岗位 / 「岗位-代号」）解析成
 * 唯一同伴的**规范名**（= bot.name）。复用 computePeerHandles 的句柄口径，使「内联 @」与「mention_bot 工具」
 * 两条路命中逻辑一致、不漂移。大小写不敏感；全名精确匹配优先于别名。
 * 命中唯一同伴 → 返回其规范名；无命中 / 别名歧义（多个同伴）→ 返回 undefined（调用方据此回退到 not_found）。
 */
export function resolvePeerByHandle(wanted: string, peers: PeerHandle[]): string | undefined {
  const w = wanted.trim().toLowerCase();
  if (!w) return undefined;
  const byName = peers.filter((p) => p.name.trim().toLowerCase() === w);
  if (byName.length >= 1) return byName[0]!.name; // 同名取首个（调用方按创建时间排序 → 最早）
  const byAlias = peers.filter((p) => p.aliases.some((a) => a.trim().toLowerCase() === w));
  if (byAlias.length === 1) return byAlias[0]!.name;
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从正文里扫描「@同伴句柄」，返回 Map<同伴规范名, 命中的句柄集合>。
 * - 长句柄优先（全名先于别名），避免 `@程序` 抢先命中 `@程序-Juanda` 的子串。
 * - @ 前不得紧跟 ASCII 字母/数字/下划线 —— 排除 email / 代码（如 `user@程序`），但允许 @ 出现在句中、
 *   或紧跟中文/标点（如 `完成@程序`、`owner:@程序-Juanda`、行首 `@程序`），这正是「@ 在消息中间」的常态。
 * 返回的句柄用于后续把 `@句柄` 整体替换成真实 `<@id>`。
 */
export function scanPeerMentions(text: string, peers: PeerHandle[]): Map<string, Set<string>> {
  const handleToName = new Map<string, string>();
  for (const p of peers) {
    if (p.name.length > 0) handleToName.set(p.name, p.name);
    for (const a of p.aliases) if (a.length > 0 && !handleToName.has(a)) handleToName.set(a, p.name);
  }
  const handles = [...handleToName.keys()].sort((a, b) => b.length - a.length);
  if (handles.length === 0) return new Map();
  const alt = handles.map(escapeRegExp).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_])@(${alt})`, 'g');
  const result = new Map<string, Set<string>>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const handle = m[1]!;
    const name = handleToName.get(handle)!;
    if (!result.has(name)) result.set(name, new Set());
    result.get(name)!.add(handle);
  }
  return result;
}

/** 把正文里所有 `@句柄`（长句柄优先）替换成给定的真实提及串（如 `<@123>`）。 */
export function rewriteHandles(text: string, handles: Iterable<string>, replacement: string): string {
  let out = text;
  for (const h of [...handles].sort((a, b) => b.length - a.length)) {
    out = out.split(`@${h}`).join(replacement);
  }
  return out;
}

/**
 * 把正文里的 Discord 提及 `<@id>`/`<@!id>` 转成**喂给模型**的可读文本（接收方理解用）：
 *  - 自己的提及（id === selfId）：删除（去掉「点名我」的前缀噪声，沿用历史行为）。
 *  - 已知同伴（nameOf(id) 命中）：换成「@名字」。
 *  - 未知 id（非同伴/普通用户）：删除（沿用历史 strip 行为，避免裸 `<@数字>` 噪声）。
 * 修复：内联多 @ 转交消息此前被无差别 `replace(/<@!?\d+>/g,'')` 删成残句（@同伴名 变空白、主语丢失）。
 * 现在接收方至少能看到「@策划-Dannis …」这样的可读点名，理解消息结构。
 */
export function resolveMentionsReadable(
  content: string,
  selfId: string | undefined,
  nameOf: (id: string) => string | undefined
): string {
  return content
    .replace(/<@!?(\d+)>/g, (_full, id: string) => {
      if (selfId && id === selfId) return '';
      const name = nameOf(id);
      return name ? `@${name}` : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
