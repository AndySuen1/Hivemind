// 项目配置表单的「无 JSX 状态模块」：表单状态类型 + 默认值 + 由 Project 反序列化 + 序列化成 create/update 入参。
// 对标 bot-form.ts，由新建弹窗（projects/page.tsx）与配置页（ProjectConfigForm/ProjectConfigSection）共用，保证 create/update 契约一致。

import type { ProjectCreate, ProjectUpdate } from '@hivemind/shared';
import { linesToArr } from '@/lib/bot-form';
import type { ProjectWithMembers } from '@/lib/api';

export interface ProjectFormState {
  name: string;
  description: string;
  maxTurnsPerTask: number;
  maxCostUsd: number;
  wsDirs: string; // 换行串 ↔ workspaceDirs string[]
  members: string[]; // ↔ memberBotIds
}

/** 新建用的空白默认值（与 projectSchema 的 default 对齐：6 / 2 / []）。 */
export function emptyProjectFormState(): ProjectFormState {
  return { name: '', description: '', maxTurnsPerTask: 6, maxCostUsd: 2, wsDirs: '', members: [] };
}

/** 由已存在的项目反序列化成表单状态（编辑用）。参数须是 ProjectWithMembers——要读 memberBotIds。 */
export function projectToFormState(p: ProjectWithMembers): ProjectFormState {
  return {
    name: p.name ?? '',
    description: p.description ?? '',
    maxTurnsPerTask: p.maxTurnsPerTask ?? 6,
    maxCostUsd: p.maxCostUsd ?? 2,
    wsDirs: (p.workspaceDirs ?? []).join('\n'),
    members: p.memberBotIds ?? [],
  };
}

/**
 * 序列化成创建入参：只发 name/description/memberBotIds，预算/工作目录留给后端用 schema 默认（6/2/[]）。
 * 使创建契约与「新建弹窗只有 名/描述/成员」一致——其余去配置页配。
 */
export function buildProjectCreate(s: ProjectFormState): ProjectCreate {
  return {
    name: s.name,
    description: s.description,
    memberBotIds: s.members,
  };
}

/**
 * 序列化成「完整更新补丁」——含所有可编辑字段。
 * 字段构造顺序固定 → 可直接用 JSON.stringify 做相等/差异比较（见 diffProjectUpdate）。
 */
export function buildProjectUpdateFull(s: ProjectFormState): ProjectUpdate {
  return {
    name: s.name,
    description: s.description,
    maxTurnsPerTask: s.maxTurnsPerTask,
    maxCostUsd: s.maxCostUsd,
    workspaceDirs: linesToArr(s.wsDirs),
    memberBotIds: s.members,
  };
}

// —— 自动保存 / 重启分类 ——————————————————————————————————————————————
//
// ⚠️ 与 orchestrator api.ts 的 PATCH /api/projects/:id 同步：
//   - 需重启成员 bot：name / workspaceDirs / memberBotIds（成员可见目录/花名册项目名/成员构成变了）
//   - 免重启（即时生效）：description / maxTurnsPerTask / maxCostUsd（转交时实时读项目预算）
// 改了 orchestrator 那段的分类，这里要同步。
const RESTART_EXEMPT_FIELDS = new Set<keyof ProjectUpdate>(['description', 'maxTurnsPerTask', 'maxCostUsd']);

/** keyof ProjectUpdate 是否改了「无需重启成员」即可生效。 */
export const isRestartExemptField = (k: keyof ProjectUpdate): boolean => RESTART_EXEMPT_FIELDS.has(k);

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface ProjectUpdateDiff {
  /** 仅含发生变化的字段；可直接当 PATCH body。 */
  patch: ProjectUpdate;
  /** 变化字段的 keys。 */
  changedKeys: (keyof ProjectUpdate)[];
  /** 有「免重启」字段变化（description / maxTurnsPerTask / maxCostUsd）。 */
  exemptChanged: boolean;
  /** 有「需重启成员」字段变化（name / workspaceDirs / memberBotIds）。 */
  restartChanged: boolean;
}

/**
 * 算出把 `base` 改成 `curr` 需要的最小补丁，并按是否需重启成员分类。
 * 对每个字段用 JSON 相等比较：数组按顺序逐项比较。
 */
export function diffProjectUpdate(curr: ProjectFormState, base: ProjectFormState): ProjectUpdateDiff {
  const a = buildProjectUpdateFull(curr);
  const b = buildProjectUpdateFull(base);
  const patch: ProjectUpdate = {};
  const changedKeys: (keyof ProjectUpdate)[] = [];
  let exemptChanged = false;
  let restartChanged = false;
  for (const k of Object.keys(a) as (keyof ProjectUpdate)[]) {
    if (jsonEq(a[k], b[k])) continue;
    (patch as Record<string, unknown>)[k] = a[k];
    changedKeys.push(k);
    if (RESTART_EXEMPT_FIELDS.has(k)) exemptChanged = true;
    else restartChanged = true;
  }
  return { patch, changedKeys, exemptChanged, restartChanged };
}
