'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, FolderKanban } from 'lucide-react';
import type { ProjectCreate, ProjectUpdate } from '@hivemind/shared';
import { projectsApi, botsApi, type ProjectWithMembers, type BotWithRuntime } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormModal,
  Input,
  PageContainer,
  PageHeader,
  Skeleton,
  useConfirm,
  useToast,
} from '@/components/ui';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithMembers[]>([]);
  const [bots, setBots] = useState<BotWithRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProjectWithMembers | 'new' | null>(null);

  const refresh = async () => {
    try {
      const [ps, bs] = await Promise.all([projectsApi.list(), botsApi.list()]);
      setProjects(ps);
      setBots(bs);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <PageContainer size="default">
      <PageHeader
        title="项目"
        subtitle="把一组员工 bot 编进同一个项目，同项目的 bot 可互相 @ 协作（无需逐个配白名单）。转交预算挂在项目上。"
        actions={
          <Button variant="primary" leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')} disabled={loading}>
            新建项目
          </Button>
        }
      />

      {err && <div className="mb-4 rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}</div>}

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[96px] rounded-lg" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="还没有项目"
          description="新建一个项目，把要协作的几个 bot 加进来——它们就能在频道里互相 @ 转交任务了。"
          action={
            <Button variant="primary" leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              新建项目
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} bots={bots} onEdit={() => setEditing(p)} onChange={refresh} />
          ))}
        </div>
      )}

      <ProjectFormModal
        open={editing !== null}
        mode={editing === 'new' ? 'create' : 'edit'}
        existing={editing !== 'new' && editing !== null ? editing : undefined}
        bots={bots}
        projects={projects}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          refresh();
        }}
      />
    </PageContainer>
  );
}

function ProjectRow({
  project,
  bots,
  onEdit,
  onChange,
}: {
  project: ProjectWithMembers;
  bots: BotWithRuntime[];
  onEdit: () => void;
  onChange: () => void;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const memberNames = project.memberBotIds
    .map((id) => bots.find((b) => b.id === id)?.name ?? id.slice(0, 8))
    .filter(Boolean);

  const onDelete = async () => {
    const ok = await confirm({
      title: `删除项目「${project.name}」？`,
      description: '成员 bot 不会被删除，只是移出本项目（随之失去互相 @ 的能力）。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await projectsApi.delete(project.id);
      onChange();
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <Card padding="md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FolderKanban className="size-4 text-fg-subtle" />
            <span className="font-semibold text-fg">{project.name}</span>
            <Badge tone="info">{project.memberBotIds.length} 个成员</Badge>
          </div>
          {project.description && <div className="mt-1 text-xs text-fg-muted">{project.description}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-fg-muted">
            <span className="text-fg-subtle">成员：</span>
            {memberNames.length === 0 ? (
              <span className="text-fg-subtle">（暂无，至少加 2 个才能互相 @）</span>
            ) : (
              memberNames.map((n) => (
                <Badge key={n} tone="neutral">
                  {n}
                </Badge>
              ))
            )}
          </div>
          <div className="mt-1 text-xs text-fg-subtle">
            协作预算：最多 <code className="rounded bg-bg-subtle px-1">{project.maxTurnsPerTask}</code> 跳 · 成本上限{' '}
            <code className="rounded bg-bg-subtle px-1">{project.maxCostUsd === 0 ? '不限' : `$${project.maxCostUsd}`}</code>
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ProjectFormModal({
  open,
  mode,
  existing,
  bots,
  projects,
  onClose,
  onDone,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  existing?: ProjectWithMembers;
  bots: BotWithRuntime[];
  projects: ProjectWithMembers[];
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [maxTurns, setMaxTurns] = useState(6);
  const [maxCost, setMaxCost] = useState(2);
  const [members, setMembers] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setMaxTurns(existing?.maxTurnsPerTask ?? 6);
    setMaxCost(existing?.maxCostUsd ?? 2);
    setMembers(existing?.memberBotIds ?? []);
    setErr(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  // 每个 bot 当前所属项目名（用于提示「勾选会把它从原项目移过来」——一个 bot 只属一个项目）
  const projectNameOf = (botId: string): string | null => {
    const b = bots.find((x) => x.id === botId);
    if (!b?.projectId || b.projectId === existing?.id) return null;
    return projects.find((p) => p.id === b.projectId)?.name ?? '其他项目';
  };

  const onSubmit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      if (isEdit && existing) {
        const patch: ProjectUpdate = {
          name,
          description,
          maxTurnsPerTask: maxTurns,
          maxCostUsd: maxCost,
          memberBotIds: members,
        };
        await projectsApi.update(existing.id, patch);
      } else {
        const input: ProjectCreate = {
          name,
          description,
          maxTurnsPerTask: maxTurns,
          maxCostUsd: maxCost,
          memberBotIds: members,
        };
        await projectsApi.create(input);
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={isEdit && existing ? `编辑项目「${existing.name}」` : '新建项目'}
      size="md"
      onSubmit={onSubmit}
      submitting={submitting}
      error={err}
      initialFocusRef={nameRef}
    >
      <Field label="项目名称">
        <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：产品研发组" required />
      </Field>
      <Field label="描述（可选）">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个项目是干什么的" />
      </Field>
      <div className="flex gap-3">
        <Field label="单任务最大转交跳数" className="w-40">
          <Input type="number" min={1} max={20} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
        </Field>
        <Field label="单任务成本上限（$，0=不限）" className="w-48">
          <Input type="number" min={0} max={100} step={0.5} value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="成员 bot（勾选加入本项目；同项目成员可互相 @）">
        {bots.length === 0 ? (
          <div className="text-[11px] text-fg-subtle">还没有 bot——先去「Bots」创建几个再来编组。</div>
        ) : (
          <div className="max-h-52 space-y-1 overflow-y-auto rounded border border-border bg-bg p-2">
            {bots.map((b) => {
              const otherProject = projectNameOf(b.id);
              return (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary-strong"
                    checked={members.includes(b.id)}
                    onChange={(e) =>
                      setMembers((prev) => (e.target.checked ? [...new Set([...prev, b.id])] : prev.filter((x) => x !== b.id)))
                    }
                  />
                  <span className="text-fg">{b.name}</span>
                  <code className="text-[10px] text-fg-subtle">{b.id.slice(0, 8)}</code>
                  {otherProject && <span className="text-[10px] text-warning-fg">（在「{otherProject}」，勾选将移过来）</span>}
                </label>
              );
            })}
          </div>
        )}
      </Field>
    </FormModal>
  );
}
