// pK = 调度器冒烟（Phase 3.5）：register 只收合法且启用的 cron / 幂等 / unregister 清零 / invoke 防重入。
// 纯逻辑，不等真到点（node-cron 注册的 task 本测试期间不会触发）；防重入直接验内部 invoke 守护。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pK-smoke.ts
import { scheduler } from './src/scheduler.ts';

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

// register 只用 bot.id/name/schedule，故用最小 cast 即可。
const bot: any = {
  id: 'bot-k',
  name: 'K',
  schedule: [
    { cron: '*/5 * * * *', prompt: 'p1', enabled: true }, // 合法 + 启用 → 注册
    { cron: 'totally not a cron', prompt: 'p2', enabled: true }, // 非法 → 跳过
    { cron: '0 9 * * *', prompt: 'p3', enabled: false }, // 启用=false → 跳过
  ],
};

console.log('— register：只收合法且启用的项 —');
scheduler.register(bot, async () => {});
check('只注册 1 个（非法/停用被跳过）', scheduler.countJobs('bot-k') === 1, scheduler.countJobs('bot-k'));

console.log('— register 幂等（先注销旧再注册，不叠加）—');
scheduler.register(bot, async () => {});
scheduler.register(bot, async () => {});
check('重复 register 仍是 1', scheduler.countJobs('bot-k') === 1);

console.log('— unregister 清零（幂等）—');
scheduler.unregister('bot-k');
check('unregister 后 0', scheduler.countJobs('bot-k') === 0);
scheduler.unregister('bot-k'); // 再次幂等不抛
check('再次 unregister 不抛', scheduler.countJobs('bot-k') === 0);

console.log('— 全部 schedule 非法/停用 → 0 个 —');
scheduler.register({ id: 'b0', name: 'Z', schedule: [{ cron: 'xyz', prompt: 'p', enabled: true }] } as any, async () => {});
check('无合法项 → 0', scheduler.countJobs('b0') === 0);

console.log('— invoke 防重入：上次未跑完则跳过本次 —');
let r1 = 0,
  r2 = 0;
let release!: () => void;
const pending = new Promise<void>((res) => {
  release = res;
});
// 第一次 invoke：占用 key（run 内 await 一个未决 promise，模拟「还没跑完」）
(scheduler as any).invoke('k:0', 'L', async () => {
  r1++;
  await pending;
});
// 第二次 invoke：同 key 且第一次还没结束 → 应被跳过
(scheduler as any).invoke('k:0', 'L', async () => {
  r2++;
});
await Promise.resolve(); // 放行一轮 microtask，让第一次的 run 真正执行
check('第一次 run 执行（r1=1）', r1 === 1, r1);
check('第二次被跳过（r2=0）', r2 === 0, r2);

// 释放第一次 → key 腾出，再 invoke 应能执行
release();
await pending;
await new Promise((res) => setTimeout(res, 0)); // 等 finally 删 key
(scheduler as any).invoke('k:0', 'L', async () => {
  r2++;
});
await new Promise((res) => setTimeout(res, 0));
check('释放后可再触发（r2=1）', r2 === 1, r2);

scheduler.stopAll();
console.log(`\npK 调度器冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
