// pH = Project（Inter-Agent 协作分组）repo 冒烟：CRUD + 单 bot 单项目成员语义 +
//      加入即从原项目移出 + 删项目把成员 project_id 置 NULL + listByProject + 预算更新。
// 直接 SQL 种 provider/bots（避开 keytar），projectRepo/botRepo 走真实库。临时 DB，不碰线上。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pH-smoke.ts
import { rmSync, existsSync } from 'node:fs';
import { initDb, getDb } from './src/db.ts';
import { projectRepo, botRepo } from './src/repos.ts';
import { exportConfig, importConfig } from './src/config-io.ts';

const DB = 'd:/tmp/pH-smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) if (existsSync(f)) rmSync(f);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

initDb(DB);
const db = getDb();
const now = Date.now();

// 种一个 provider（bots.provider_id NOT NULL REFERENCES providers）
db.prepare(
  `INSERT INTO providers (id, name, kind, base_url, default_model, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
).run('prov-1', 'P', 'openai-compatible', null, 'm', now, now);

// 种 bots（raw SQL，project_id 默认 NULL；name UNIQUE）
const insBot = db.prepare(
  `INSERT INTO bots (id, name, provider_id, system_prompt, temperature, tools, allowed_requesters, enabled, created_at, updated_at)
   VALUES (?, ?, 'prov-1', '', 1.3, '{}', '[]', 1, ?, ?)`
);
for (const [id, name] of [['b1', 'PM'], ['b2', '后端'], ['b3', '前端']] as const) insBot.run(id, name, now, now);

const pidOf = (botId: string) => botRepo.get(botId)?.projectId ?? null;

// ============================================================
console.log('— 创建 / 默认预算 —');
const p1 = projectRepo.create({ name: '研发组', memberBotIds: ['b1', 'b2'] });
check('create 返回项目，默认 maxTurnsPerTask=6', p1.maxTurnsPerTask === 6);
check('默认 maxCostUsd=2', p1.maxCostUsd === 2);
check('get 能取回', projectRepo.get(p1.id)?.name === '研发组');
check('list 含该项目', projectRepo.list().some((p) => p.id === p1.id));

console.log('— 成员落到 bots.project_id —');
check('b1.project_id = p1', pidOf('b1') === p1.id);
check('b2.project_id = p1', pidOf('b2') === p1.id);
check('b3 仍无项目', pidOf('b3') === null);
check('listByProject(p1) = [b1,b2]', botRepo.listByProject(p1.id).map((b) => b.id).sort().join() === 'b1,b2');
check('listMembers 同 listByProject', projectRepo.listMembers(p1.id).length === 2);

console.log('— 同项目判定（可互相 @ 的基础）—');
check('b1 与 b2 同项目', pidOf('b1') === pidOf('b2') && pidOf('b1') !== null);
check('b1 与 b3 不同项目', pidOf('b1') !== pidOf('b3'));

console.log('— setMembers：移出 b2 —');
const aff1 = projectRepo.setMembers(p1.id, ['b1']);
check('b2 被移出（project_id=NULL）', pidOf('b2') === null);
check('b1 仍在', pidOf('b1') === p1.id);
check('affected 含 b2', aff1.includes('b2'));

console.log('— 单 bot 单项目：加入新项目自动移出原项目 —');
const p2 = projectRepo.create({ name: '运营组' });
const aff2 = projectRepo.setMembers(p2.id, ['b1']); // b1 原在 p1
check('b1 改属 p2', pidOf('b1') === p2.id);
check('p1 现在无成员', botRepo.listByProject(p1.id).length === 0);
check('affected 含 b1', aff2.includes('b1'));

console.log('— 预算更新（不动成员）—');
projectRepo.update(p2.id, { maxTurnsPerTask: 10, maxCostUsd: 0 });
check('maxTurnsPerTask 改为 10', projectRepo.get(p2.id)?.maxTurnsPerTask === 10);
check('maxCostUsd 改为 0（不限）', projectRepo.get(p2.id)?.maxCostUsd === 0);
check('成员不受预算更新影响', pidOf('b1') === p2.id);

console.log('— move 的 affected 契约：不含被拉入 bot 的原项目剩余同伴 —');
const p3 = projectRepo.create({ name: '设计组', memberBotIds: ['b2', 'b3'] }); // b2,b3 入 p3
const affMove = projectRepo.setMembers(p2.id, ['b1', 'b2']); // 从 p3 拉 b2 进 p2（b1 已在 p2）
check('b2 被移入 p2', pidOf('b2') === p2.id);
check('b3 仍留在 p3', pidOf('b3') === p3.id);
check('affected 含被移入的 b2', affMove.includes('b2'));
check('affected 不含 p3 剩余同伴 b3（契约：调用方自行补刷原项目同伴）', !affMove.includes('b3'));
projectRepo.delete(p3.id); // 清理，避免影响下面 p2 删除断言

console.log('— 删项目把成员 project_id 置 NULL —');
const okDel = projectRepo.delete(p2.id);
check('delete 返回 true', okDel === true);
check('项目已不存在', projectRepo.get(p2.id) === null);
check('原成员 b1.project_id 置 NULL', pidOf('b1') === null);
check('删不存在的项目返回 false', projectRepo.delete('nope') === false);

console.log('— config-io 往返保留项目与 bot.projectId（不含密钥，避开 keytar）—');
const pX = projectRepo.create({ name: '导出组', memberBotIds: ['b1'], maxTurnsPerTask: 9, maxCostUsd: 0 });
const bundle = await exportConfig(false);
check('导出 bundle 含 projects', Array.isArray(bundle.projects) && bundle.projects!.some((p) => p.id === pX.id));
check('导出的 bot 带 projectId', bundle.bots.find((b) => b.id === 'b1')?.projectId === pX.id);
projectRepo.delete(pX.id); // 模拟新机器：项目没了，b1.project_id 置 NULL
check('清理后 b1 无项目', pidOf('b1') === null);
const res = await importConfig(bundle);
check('导入计数 projects ≥ 1', res.projects >= 1);
check('导入后项目预算恢复（maxTurns=9）', projectRepo.get(pX.id)?.maxTurnsPerTask === 9);
check('导入后 b1.projectId 恢复', pidOf('b1') === pX.id);
// 悬挂防护：projectId 指向不存在项目 → 导入置 NULL
const dangling = { ...bundle, projects: [], bots: bundle.bots.map((b) => ({ ...b })) };
projectRepo.delete(pX.id);
db.prepare('UPDATE bots SET project_id = NULL WHERE id = ?').run('b1');
await importConfig(dangling); // projects 空，b1.projectId 指向已删项目 → 应置 NULL
check('悬挂 projectId 导入后置 NULL（不搬悬挂引用）', pidOf('b1') === null);

console.log(`\npH Project repo 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
