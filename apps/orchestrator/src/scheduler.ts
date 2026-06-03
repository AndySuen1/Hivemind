import cron, { type ScheduledTask } from 'node-cron';
import type { Bot, ScheduleItem } from '@hivemind/shared';

// 调度器（Phase 3.5）：node-cron 单例，按每 bot 的 schedule 注册定时任务，到点回调注入的 fire。
// 单向依赖：本模块不 import bot-manager（避免循环）；挂钩由 BotInstance 主动调 register/unregister。
// best-effort：非法 cron 跳过、防重入（上次没跑完就跳过本次）、fire 异常被吞，绝不影响其它任务/进程退出。

const SCHEDULER_TZ = process.env.SCHEDULER_TZ?.trim() || 'Asia/Shanghai';

/** 到点触发回调：跑 bot.schedule 里第 index 项。由 BotInstance 提供（闭包持有 this）。 */
export type ScheduleFireFn = (item: ScheduleItem, index: number) => Promise<void>;

interface RegisteredJob {
  task: ScheduledTask;
  index: number;
}

class Scheduler {
  private jobs = new Map<string, RegisteredJob[]>(); // botId → 其所有 cron job
  private running = new Set<string>(); // `${botId}:${index}` 正在跑的键（防重入）

  /** 注册某 bot 的 schedule（先注销旧的，幂等）。非法 cron / enabled=false 的项跳过。 */
  register(bot: Bot, fire: ScheduleFireFn): void {
    this.unregister(bot.id);
    const items: ScheduleItem[] = bot.schedule ?? [];
    const jobs: RegisteredJob[] = [];
    items.forEach((item, index) => {
      if (!item.enabled) return;
      if (!cron.validate(item.cron)) {
        console.warn(`[scheduler] bot「${bot.name}」schedule[${index}] cron 非法，跳过: ${item.cron}`);
        return;
      }
      const key = `${bot.id}:${index}`;
      const label = `「${bot.name}」[${index}]`;
      const task = cron.schedule(item.cron, () => this.invoke(key, label, () => fire(item, index)), {
        timezone: SCHEDULER_TZ,
        noOverlap: true, // node-cron v4 原生防叠加；下方 running 守护再兜一层
        name: key,
      });
      jobs.push({ task, index });
    });
    if (jobs.length) {
      this.jobs.set(bot.id, jobs);
      console.log(`[scheduler] bot「${bot.name}」注册 ${jobs.length} 个定时任务（tz=${SCHEDULER_TZ}）`);
    }
  }

  /**
   * 防重入执行守护：同一 key 上一次还没跑完就再次触发 → 跳过本次（宁可漏一次也不堆叠）。
   * 抽成方法便于冒烟直接验证（cron 回调与测试共用同一守护逻辑）。fire 异常被吞，绝不冒泡进 cron。
   */
  private invoke(key: string, label: string, run: () => Promise<void>): void {
    if (this.running.has(key)) {
      console.warn(`[scheduler]${label} 上次未跑完，跳过本次触发`);
      return;
    }
    this.running.add(key);
    void Promise.resolve()
      .then(run)
      .catch((e) => console.error(`[scheduler]${label} 触发失败（已忽略）`, e))
      .finally(() => this.running.delete(key));
  }

  /** 注销某 bot 的全部 cron job（幂等）。bot 停机/重启时调。 */
  unregister(botId: string): void {
    const jobs = this.jobs.get(botId);
    if (!jobs) return;
    for (const j of jobs) {
      try {
        j.task.stop();
      } catch {
        // 忽略 stop 异常
      }
    }
    this.jobs.delete(botId);
  }

  /** 进程退出时全清（防 cron 定时器阻止进程退出）。 */
  stopAll(): void {
    for (const botId of [...this.jobs.keys()]) this.unregister(botId);
    this.running.clear();
  }

  /** 某 bot 当前注册的有效（已启用且 cron 合法）任务数。供冒烟/自检。 */
  countJobs(botId: string): number {
    return this.jobs.get(botId)?.length ?? 0;
  }
}

export const scheduler = new Scheduler();
