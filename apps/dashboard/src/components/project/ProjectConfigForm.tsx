'use client';

import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ProjectWithMembers, BotWithRuntime } from '@/lib/api';
import type { ProjectFormState } from '@/lib/project-form';
import { Field, Input, Textarea } from '@/components/ui';
import { MemberPicker } from '@/components/project/MemberPicker';

export interface ProjectConfigFormProps {
  state: ProjectFormState;
  setState: Dispatch<SetStateAction<ProjectFormState>>;
  bots: BotWithRuntime[];
  projects: ProjectWithMembers[];
  /** 本项目 id（创建态传空串）：解析成员「在其他项目」提示时排除自己。 */
  currentProjectId: string;
  nameRef?: RefObject<HTMLInputElement>;
}

/**
 * 项目配置表单主体（单段式，无 Tabs）：名称 / 描述 / 协作预算 / 工作目录 / 成员。
 * 不含保存按钮与提醒条——那些在 ProjectConfigSection（自动保存状态机）里。
 */
export function ProjectConfigForm({ state: s, setState, bots, projects, currentProjectId, nameRef }: ProjectConfigFormProps) {
  const set = <K extends keyof ProjectFormState>(k: K, v: ProjectFormState[K]) => setState((p) => ({ ...p, [k]: v }));

  // 每个 bot 当前所属项目名（用于提示「勾选会把它从原项目移过来」——一个 bot 只属一个项目）
  const projectNameOf = (botId: string): string | null => {
    const b = bots.find((x) => x.id === botId);
    if (!b?.projectId || b.projectId === currentProjectId) return null;
    return projects.find((p) => p.id === b.projectId)?.name ?? '其他项目';
  };

  return (
    <div className="space-y-3">
      <Field label="项目名称">
        <Input ref={nameRef} value={s.name} onChange={(e) => set('name', e.target.value)} placeholder="如：产品研发组" required />
      </Field>
      <Field label="描述（可选）">
        <Input value={s.description} onChange={(e) => set('description', e.target.value)} placeholder="这个项目是干什么的" maxLength={500} />
      </Field>
      <div className="flex gap-3">
        <Field label="单任务最大转交跳数" className="w-40">
          <Input
            type="number"
            min={1}
            max={20}
            value={s.maxTurnsPerTask}
            onChange={(e) => set('maxTurnsPerTask', Math.min(20, Math.max(1, Number(e.target.value) || 6)))}
          />
        </Field>
        <Field label="单任务成本上限（$，0=不限）" className="w-48">
          <Input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={s.maxCostUsd}
            onChange={(e) => {
              const v = Number(e.target.value);
              set('maxCostUsd', Math.min(100, Math.max(0, Number.isFinite(v) ? v : 2)));
            }}
          />
        </Field>
      </div>
      <Field label="项目工作目录（每行一个；本项目全体成员可见。成员实际可访问 = 这份 + 它自己在「Bots」里配的）">
        <Textarea
          value={s.wsDirs}
          onChange={(e) => set('wsDirs', e.target.value)}
          rows={3}
          className="font-mono"
          placeholder={'E:\\UEProjects\\ProjectA\nD:\\notes\\ProjectA'}
        />
      </Field>
      <Field label="成员 bot（勾选加入本项目；同项目成员可互相 @）">
        <MemberPicker
          bots={bots}
          selected={s.members}
          onToggle={(id, checked) =>
            setState((prev) => ({
              ...prev,
              members: checked
                ? [...new Set([...prev.members, id])]
                : prev.members.filter((x) => x !== id),
            }))
          }
          otherProjectOf={projectNameOf}
          maxHeightClass="max-h-72"
        />
      </Field>
    </div>
  );
}
