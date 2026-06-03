// pI = Phase 3 Inter-Agent bug 修复冒烟：纯逻辑（无 Discord/无 DB）。
// 覆盖：
//  · 正文内联 @ 解析 inline-mention.ts —— prefixAlias / computePeerHandles（别名唯一性/冲突）/
//    scanPeerMentions（精确全名 + 前缀别名 + 句中 @ + email 排除 + 长名优先 + 非同伴不命中）/ rewriteHandles。
//  · 等待接力回报登记 router.replyAwait —— register/match/owner 作用域/非一次性(多同伴回报)/TTL 过期。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pI-smoke.ts

import {
  prefixAlias,
  computePeerHandles,
  computePromotedHandles,
  scanPeerMentions,
  rewriteHandles,
  resolveMentionsReadable,
  resolvePeerByHandle,
} from './src/inter-agent/inline-mention.ts';
import { interAgentRouter, REPLY_AWAIT_TTL_MS_VALUE, MAX_HOPS_PER_TARGET_VALUE } from './src/inter-agent/router.ts';

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

// 把 scanPeerMentions 的结果转成「同伴名 → 命中句柄(排序后)」便于断言。
function flat(m: Map<string, Set<string>>): Record<string, string[]> {
  const o: Record<string, string[]> = {};
  for (const [k, v] of m) o[k] = [...v].sort();
  return o;
}

// ============================================================
console.log('— prefixAlias —');
check('程序-Juanda → 程序', prefixAlias('程序-Juanda') === '程序');
check('PM-Louie → PM', prefixAlias('PM-Louie') === 'PM');
check('无短横线 → undefined', prefixAlias('美术') === undefined);
check('以短横线开头（前缀空）→ undefined', prefixAlias('-x') === undefined);
check('多段取首段：a-b-c → a', prefixAlias('a-b-c') === 'a');

// ============================================================
console.log('— computePeerHandles（别名唯一性）—');
{
  const h = computePeerHandles([{ name: '程序-Juanda' }, { name: '策划-Dannis' }, { name: 'PM-Louie' }]);
  const byName = Object.fromEntries(h.map((p) => [p.name, p.aliases]));
  check('程序-Juanda 别名=[程序]', JSON.stringify(byName['程序-Juanda']) === JSON.stringify(['程序']), byName);
  check('策划-Dannis 别名=[策划]', JSON.stringify(byName['策划-Dannis']) === JSON.stringify(['策划']), byName);
  check('PM-Louie 别名=[PM]', JSON.stringify(byName['PM-Louie']) === JSON.stringify(['PM']), byName);
}
{
  // 前缀被多个同伴共享 → 别名作废（歧义）
  const h = computePeerHandles([{ name: '程序-A' }, { name: '程序-B' }]);
  check('共享前缀「程序」→ 两者都无别名', h.every((p) => p.aliases.length === 0), h);
}
{
  // 前缀与某同伴全名冲突 → 别名作废
  const h = computePeerHandles([{ name: '程序' }, { name: '程序-Juanda' }]);
  const j = h.find((p) => p.name === '程序-Juanda')!;
  check('前缀「程序」与同伴全名冲突 → 程序-Juanda 无别名', j.aliases.length === 0, h);
}

// ============================================================
// 「没@成功」根因回归：bot 被改成短名（Dannis/Juanda，无 '-' 前缀），模型仍按岗位写 @策划/@程序/@策划-Dannis。
// 句柄必须由 role 派生出「岗位」「岗位-代号」别名，否则全部 @ 失败。
console.log('— computePeerHandles（岗位别名：改短名场景）—');
{
  const h = computePeerHandles([
    { name: 'Dannis', role: '策划' },
    { name: 'Juanda', role: '程序' },
  ]);
  const byName = Object.fromEntries(h.map((p) => [p.name, [...p.aliases].sort()]));
  check('Dannis（策划）别名含 策划 + 策划-Dannis', JSON.stringify(byName['Dannis']) === JSON.stringify(['策划', '策划-Dannis'].sort()), byName);
  check('Juanda（程序）别名含 程序 + 程序-Juanda', JSON.stringify(byName['Juanda']) === JSON.stringify(['程序', '程序-Juanda'].sort()), byName);
}
{
  // 岗位重名 → 岗位别名歧义作废（两个「程序」），但「岗位-代号」组合仍唯一可用
  const h = computePeerHandles([
    { name: 'A', role: '程序' },
    { name: 'B', role: '程序' },
  ]);
  const byName = Object.fromEntries(h.map((p) => [p.name, [...p.aliases].sort()]));
  check('重名岗位「程序」作废、保留唯一的 程序-A / 程序-B', JSON.stringify(byName['A']) === JSON.stringify(['程序-A']) && JSON.stringify(byName['B']) === JSON.stringify(['程序-B']), byName);
}
{
  // 无 role 时退化为旧行为（不破坏既有用例）
  const h = computePeerHandles([{ name: '程序-Juanda' }]);
  check('无 role → 仅前缀别名（向后兼容）', JSON.stringify(h[0]!.aliases) === JSON.stringify(['程序']), h);
}

console.log('— scanPeerMentions（岗位 @ 命中：根因回归）—');
{
  const peers = computePeerHandles([
    { name: 'Dannis', role: '策划' },
    { name: 'Juanda', role: '程序' },
  ]);
  // 真实失败样本（取自聊天记录）：改短名后，模型写的这些 @ 此前全部 ∅ 不命中
  check('@策划-Dannis（岗位-代号）→ 命中 Dannis', JSON.stringify(flat(scanPeerMentions('@策划-Dannis，刚看到你回话了', peers))) === JSON.stringify({ Dannis: ['策划-Dannis'] }));
  check('owner:@程序（PM 派活格式）→ 命中 Juanda', JSON.stringify(flat(scanPeerMentions('[任务] X | owner:@程序 | P0', peers))) === JSON.stringify({ Juanda: ['程序'] }));
  check('@策划 与 @程序 同句各自命中', JSON.stringify(flat(scanPeerMentions('先 @策划 定方案，再 @程序 评估', peers))) === JSON.stringify({ Dannis: ['策划'], Juanda: ['程序'] }));
  check('@Dannis（短全名）仍命中', JSON.stringify(flat(scanPeerMentions('@Dannis 你来定方案', peers))) === JSON.stringify({ Dannis: ['Dannis'] }));
  // 长名优先：@程序-Juanda 命中「岗位-代号」整体而非别名「程序」+残字
  check('@程序-Juanda 命中整体（长句柄优先）', JSON.stringify(flat(scanPeerMentions('@程序-Juanda 评估', peers))) === JSON.stringify({ Juanda: ['程序-Juanda'] }));
}

console.log('— resolvePeerByHandle（mention_bot 工具 bot_name 按名字/岗位解析）—');
{
  const peers = computePeerHandles([
    { name: 'Dannis', role: '策划' },
    { name: 'Juanda', role: '程序' },
  ]);
  check('bot_name=策划 → Dannis', resolvePeerByHandle('策划', peers) === 'Dannis');
  check('bot_name=程序 → Juanda', resolvePeerByHandle('程序', peers) === 'Juanda');
  check('bot_name=策划-Dannis → Dannis', resolvePeerByHandle('策划-Dannis', peers) === 'Dannis');
  check('bot_name=Dannis（全名，大小写不敏感）→ Dannis', resolvePeerByHandle('dannis', peers) === 'Dannis');
  check('bot_name=美术（不存在）→ undefined', resolvePeerByHandle('美术', peers) === undefined);
  check('空串 → undefined', resolvePeerByHandle('  ', peers) === undefined);
  {
    // 岗位歧义（两个程序）→ 解析失败（不乱指），但唯一全名仍可解析
    const amb = computePeerHandles([{ name: 'A', role: '程序' }, { name: 'B', role: '程序' }]);
    check('岗位歧义 → undefined（不乱指）', resolvePeerByHandle('程序', amb) === undefined);
    check('歧义下全名仍可解析', resolvePeerByHandle('A', amb) === 'A');
  }
}

// ============================================================
console.log('— scanPeerMentions —');
{
  const peers = computePeerHandles([{ name: '程序-Juanda' }, { name: '策划-Dannis' }, { name: 'PM-Louie' }]);

  // 句中 @ 全名（PM 派活的典型写法）
  check(
    'owner:@程序-Juanda（句中、全名）命中',
    JSON.stringify(flat(scanPeerMentions('[任务] X | owner:@程序-Juanda | P0', peers))) ===
      JSON.stringify({ '程序-Juanda': ['程序-Juanda'] })
  );
  // 前缀别名
  check(
    '@程序（别名）命中 程序-Juanda',
    JSON.stringify(flat(scanPeerMentions('麻烦 @程序 看下', peers))) === JSON.stringify({ '程序-Juanda': ['程序'] })
  );
  // 中文紧邻 @（无空格）也命中
  check('完成@策划（中文紧邻）命中', JSON.stringify(flat(scanPeerMentions('完成@策划', peers))) === JSON.stringify({ '策划-Dannis': ['策划'] }));
  // 多个同伴
  check(
    '同条消息 @多个同伴 全部命中',
    JSON.stringify(flat(scanPeerMentions('@程序-Juanda 做后端，@策划-Dannis 出文案', peers))) ===
      JSON.stringify({ '程序-Juanda': ['程序-Juanda'], '策划-Dannis': ['策划-Dannis'] })
  );
  // 长名优先：@程序-Juanda 应命中全名而非别名「程序」
  {
    const r = flat(scanPeerMentions('@程序-Juanda', peers));
    check('长名优先：命中全名而非别名', JSON.stringify(r) === JSON.stringify({ '程序-Juanda': ['程序-Juanda'] }), r);
  }
  // email / 代码：@ 前紧跟 ASCII 字母 → 不命中（排除 user@程序 这类）
  check('user@程序（疑似 email）不命中', scanPeerMentions('联系 user@程序 的同学', peers).size === 0);
  // 非同伴名不命中
  check('@美术（非项目同伴）不命中', scanPeerMentions('@美术 来一下', peers).size === 0);
  // 同伴在同条消息里被全名 + 别名各 @ 一次 → 两个句柄都记录（供改写时都替换）
  {
    const r = flat(scanPeerMentions('@程序-Juanda 然后再 @程序 跟进', peers));
    check('全名+别名都命中（去重到同一同伴的两句柄）', JSON.stringify(r) === JSON.stringify({ '程序-Juanda': ['程序', '程序-Juanda'] }), r);
  }
}

// ============================================================
console.log('— rewriteHandles —');
{
  const out = rewriteHandles('@程序-Juanda 做后端，回头 @程序 再确认', ['程序-Juanda', '程序'], '<@123>');
  check('全名+别名都替换为 <@id>（长名优先不残留）', out === '<@123> 做后端，回头 <@123> 再确认', out);
  const out2 = rewriteHandles('owner:@策划-Dannis', ['策划-Dannis'], '<@999>');
  check('句中全名替换', out2 === 'owner:<@999>', out2);
}

// ============================================================
console.log('— router.replyAwait（接力回报登记）—');
{
  interAgentRouter._resetForTest();
  const CH = 'chan-1';
  const PM = 'bot-PM';
  const DEV = 'bot-DEV';
  const M1 = 'msg-1';

  const DEV_UID = 'u-dev'; // 被 @ 的合法回报方（程序）
  interAgentRouter.registerReplyAwait({ taskId: 'T1', ownerBotId: PM, channelId: CH, messageId: M1, expectedSenderUserIds: [DEV_UID], now: 1000 });

  // 命中：owner=PM 且引用回复 M1 且回报方是被 @ 的同伴
  const m = interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: M1, ownerBotId: PM, senderUserId: DEV_UID, now: 1001 });
  check('被 @ 的同伴引用回复 → 命中（taskId=T1）', m?.taskId === 'T1', m);

  // 非一次性：同一条消息可被多个同伴的回报多次命中（不消费删除）
  const m2 = interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: M1, ownerBotId: PM, senderUserId: DEV_UID, now: 1002 });
  check('非一次性：可再次命中（支持多同伴各自回报）', m2?.taskId === 'T1', m2);

  // B4：回报方不在 expectedSenderUserIds 白名单 → 不命中（其它 bot 引用回复转交消息不被误当回报）
  check('非被@同伴引用回复 → 不命中（身份校验）', interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: M1, ownerBotId: PM, senderUserId: 'u-other', now: 1002 }) === undefined);

  // owner 作用域：非 owner 不命中（别的 bot 看到这条回复不会误接）
  check('非 owner 不命中', interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: M1, ownerBotId: DEV, senderUserId: DEV_UID, now: 1003 }) === undefined);

  // 引用的不是我登记过的消息 → 不命中
  check('引用未登记消息 → 不命中', interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: 'msg-x', ownerBotId: PM, senderUserId: DEV_UID, now: 1004 }) === undefined);

  // 跨频道 key 隔离
  check('跨频道不命中', interAgentRouter.matchReplyAwait({ channelId: 'chan-2', refMessageId: M1, ownerBotId: PM, senderUserId: DEV_UID, now: 1005 }) === undefined);

  // 空 expectedSenderUserIds = 不校验回报方（向后兼容）
  interAgentRouter.registerReplyAwait({ taskId: 'T9', ownerBotId: PM, channelId: CH, messageId: 'M9', expectedSenderUserIds: [], now: 1000 });
  check('空白名单 → 不校验回报方（任意 sender 命中）', interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: 'M9', ownerBotId: PM, senderUserId: 'anyone', now: 1001 })?.taskId === 'T9');

  // TTL 过期：超 REPLY_AWAIT_TTL_MS 后被清，不再命中
  const after = 1000 + REPLY_AWAIT_TTL_MS_VALUE + 1;
  check('超 TTL 后被清、不再命中', interAgentRouter.matchReplyAwait({ channelId: CH, refMessageId: M1, ownerBotId: PM, senderUserId: DEV_UID, now: after }) === undefined);
}

// ============================================================
console.log('— B6 同一目标累计跳数上限（扇出/多角风暴兜底）—');
{
  interAgentRouter._resetForTest();
  const CH = 'chan-1';
  const PM = 'bot-PM';
  const DEV = 'bot-DEV';
  const cap = MAX_HOPS_PER_TARGET_VALUE;
  check('MAX_HOPS_PER_TARGET 默认 5', cap === 5);
  const task = interAgentRouter.createTask({ rootRequesterId: 'h', rootBotId: PM, channelId: CH, maxTurns: 999, maxCostUsd: 0, now: 0 });
  // 反复 @ DEV，每次中间穿插一个**不同**的 bot（避开严格乒乓 isShortLoop），看 per-target 兜底是否触发
  let blocked = false;
  for (let i = 0; i < cap + 2; i++) {
    const r = interAgentRouter.checkHop(task, DEV, { resumed: false, now: 0 });
    if (!r.ok) { blocked = true; check(`第 ${i + 1} 次 @ 同一目标被挡 → paused_loop（已累计 ${i} 次 ≥ ${cap}）`, r.state === 'paused_loop' && i >= cap, r); break; }
    interAgentRouter.commitHop(task, DEV, 0);
    interAgentRouter.commitHop(task, `bot-X${i}`, 0); // 每轮换一个不同中间 bot，避开 isShortLoop 的严格乒乓判定
  }
  check('达到同一目标跳数上限确实触发了暂停', blocked);
  check('resumed=true 可越过 per-target 上限（人工放行一跳）', interAgentRouter.checkHop(task, DEV, { resumed: true, now: 0 }).ok);
}

// ============================================================
console.log('— B1 resolveMentionsReadable（接收方可读化）—');
{
  const SELF = '111'; // 接收方自己
  const names: Record<string, string> = { '222': '策划-Dannis', '333': '程序-Juanda' };
  const nameOf = (id: string) => names[id];
  // 自己的提及删掉，其余同伴换可读名，未知 id 删掉
  check(
    '内联多@：自己删除、同伴换可读名（修复残句）',
    resolveMentionsReadable('先 <@222>：任务A 再 <@333>：任务B（cc <@111>）', SELF, nameOf) === '先 @策划-Dannis：任务A 再 @程序-Juanda：任务B（cc ）'
  );
  // 工具路径：<@self> 开头转交，strip 自己后正文完整（回归保证）
  check('开头 @自己 → 删除后正文完整', resolveMentionsReadable('<@111> 请实现登录', SELF, nameOf) === '请实现登录');
  // 未知用户 id（非同伴）删除
  check('未知 id（普通用户）删除', resolveMentionsReadable('你好 <@999> 看下', SELF, nameOf) === '你好 看下');
  // 人类回合「@bot 文本」→「文本」（保留历史行为）
  check('人类 @bot 文本 → 文本', resolveMentionsReadable('<@111> 在吗', SELF, nameOf) === '在吗');
  // 接力/回报回合 selfId=undefined：保留自己的可读名（帮多@消息里定位"点名我"的段落）
  check(
    '接力回合（selfId=undefined）保留自己的可读名',
    resolveMentionsReadable('先 <@222>：任务A 再 <@333>：任务B', undefined, (id) => ({ '111': 'PM', '222': '策划-Dannis', '333': '程序-Juanda' })[id]) === '先 @策划-Dannis：任务A 再 @程序-Juanda：任务B'
  );
  check(
    '接力回合保留自己 <@self> → @自己名',
    resolveMentionsReadable('<@333> 请实现登录', undefined, (id) => ({ '333': '程序-Juanda' })[id]) === '@程序-Juanda 请实现登录'
  );
}

// ============================================================
// computePromotedHandles：面向模型展示、要求其照抄的「@名字 / @岗位-代号」二选一句柄。
// 核心保证：展示的每个 handle 都必须能被 scanPeerMentions/resolvePeerByHandle 命中（展示=可解析，不漂移）。
console.log('— computePromotedHandles（展示句柄=可解析句柄）—');
{
  // 现网三 bot（站在 Dannis 视角看同伴 = Louie + Juanda）
  const peersInput = [
    { name: 'Louie', role: '项目经理' },
    { name: 'Juanda', role: '程序' },
  ];
  const promoted = computePromotedHandles(peersInput);
  const byName = Object.fromEntries(promoted.map((p) => [p.name, p.handles]));
  check('Louie 句柄=[Louie, 项目经理-Louie]', JSON.stringify(byName['Louie']) === JSON.stringify(['Louie', '项目经理-Louie']), byName);
  check('Juanda 句柄=[Juanda, 程序-Juanda]', JSON.stringify(byName['Juanda']) === JSON.stringify(['Juanda', '程序-Juanda']), byName);
  check('名字恒在前（首项=name）', promoted.every((p) => p.handles[0] === p.name), promoted);

  // 防漂移钉死：展示的每个 handle 一定能被两条路命中、且都解析回该同伴
  const handlesPeers = computePeerHandles(peersInput);
  for (const p of promoted) {
    for (const h of p.handles) {
      check(`@${h} 可被 resolvePeerByHandle 解析回 ${p.name}`, resolvePeerByHandle(h, handlesPeers) === p.name);
      check(`@${h} 可被 scanPeerMentions 命中 ${p.name}`, scanPeerMentions(`@${h}`, handlesPeers).has(p.name));
    }
  }
}
{
  // 无岗位 → 只剩名字（无「岗位-代号」形式）
  const promoted = computePromotedHandles([{ name: 'Solo' }]);
  check('无岗位 → 仅 [Solo]', JSON.stringify(promoted[0]!.handles) === JSON.stringify(['Solo']), promoted);
}
{
  // role 为空白字符串 → 同样退化为仅名字
  const promoted = computePromotedHandles([{ name: 'X', role: '   ' }]);
  check('role 空白 → 仅 [X]', JSON.stringify(promoted[0]!.handles) === JSON.stringify(['X']), promoted);
}
{
  // 「岗位-代号」被唯一性过滤丢弃 → 回退到仅名字。构造：combo「程序-Juanda」恰等于另一同伴的全名 → 被 fullNames 过滤。
  const promoted = computePromotedHandles([
    { name: 'Juanda', role: '程序' }, // combo = 程序-Juanda
    { name: '程序-Juanda' }, // 全名恰好撞 combo → combo 在 computePeerHandles 里被丢
  ]);
  const byName = Object.fromEntries(promoted.map((p) => [p.name, p.handles]));
  check('combo 撞同伴全名 → Juanda 回退到仅 [Juanda]', JSON.stringify(byName['Juanda']) === JSON.stringify(['Juanda']), byName);
}

console.log(`\npI Inter-Agent bug 修复冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
