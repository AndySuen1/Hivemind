'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, ArrowUpRight, Coins } from 'lucide-react';
import { projectsApi, botsApi, type ProjectWithMembers, type BotWithRuntime } from '@/lib/api';
import { buildProjectCreate, emptyProjectFormState } from '@/lib/project-form';
import { AvatarStack, type AvatarStackMember } from '@/components/bot/AvatarStack';
import { MemberPicker } from '@/components/project/MemberPicker';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormModal,
  Input,
  PageContainer,
  PageHeader,
  Skeleton,
} from '@/components/ui';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithMembers[]>([]);
  const [bots, setBots] = useState<BotWithRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

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
          <Button variant="primary" size="lg" leftIcon={<Plus className="size-[18px]" />} onClick={() => setShowNew(true)} disabled={loading}>
            新建项目
          </Button>
        }
      />

      {err && <div className="mb-4 rounded bg-danger-soft p-3 text-sm text-danger-fg">{err}</div>}

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[150px] rounded-2xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="还没有项目"
          description="新建一个项目，把要协作的几个 bot 加进来——它们就能在频道里互相 @ 转交任务了。"
          action={
            <Button variant="primary" leftIcon={<Plus className="size-4" />} onClick={() => setShowNew(true)}>
              新建项目
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} bots={bots} />
          ))}
        </div>
      )}

      <NewProjectModal
        open={showNew}
        bots={bots}
        projects={projects}
        onClose={() => setShowNew(false)}
      />
    </PageContainer>
  );
}

function ProjectCard({ project, bots }: { project: ProjectWithMembers; bots: BotWithRuntime[] }) {
  const members: AvatarStackMember[] = project.memberBotIds.map((id) => {
    const b = bots.find((x) => x.id === id);
    return { id, name: b?.name ?? id.slice(0, 8), avatar: b?.avatar };
  });
  const maxCost = project.maxCostUsd ?? 0;
  const maxTurns = project.maxTurnsPerTask ?? 6;

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group relative flex flex-col gap-3 overflow-hidden rounded-2xl bg-bg-hover p-5 shadow-sm transition duration-fast ease-notion hover:-translate-y-0.5 hover:shadow-md hover:ring-1 hover:ring-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {/* 头部行：项目名（放大当主角）/ 描述 + 进入箭头（hover 浮现） */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold tracking-tight text-fg transition-colors duration-fast group-hover:text-primary-strong">
            {project.name}
          </div>
          {project.description ? (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-fg-muted">{project.description}</p>
          ) : (
            <p className="mt-1 text-sm text-fg-subtle">未填写描述</p>
          )}
        </div>
        <ArrowUpRight
          aria-hidden
          className="mt-1 size-4 shrink-0 text-fg-subtle opacity-0 transition duration-fast group-hover:translate-x-0.5 group-hover:text-primary group-hover:opacity-100"
        />
      </div>

      {/* 底部行：成员头像组（左）+ 协作预算徽标（右） */}
      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <div className="min-w-0 flex-1">
          <AvatarStack members={members} size={28} />
        </div>
        <Badge tone="neutral" className="shrink-0 gap-1 tabular-nums">
          <Coins className="size-3" aria-hidden />
          {maxCost > 0 ? `≤$${maxCost} · ${maxTurns}跳` : `≤${maxTurns}跳`}
        </Badge>
      </div>
    </Link>
  );
}

function NewProjectModal({
  open,
  bots,
  projects,
  onClose,
}: {
  open: boolean;
  bots: BotWithRuntime[];
  projects: ProjectWithMembers[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setMembers([]);
    setErr(null);
    setSubmitting(false);
  }, [open]);

  // 每个 bot 当前所属项目名（提示「勾选会把它从原项目移过来」）
  const projectNameOf = (botId: string): string | null => {
    const b = bots.find((x) => x.id === botId);
    if (!b?.projectId) return null;
    return projects.find((p) => p.id === b.projectId)?.name ?? '其他项目';
  };

  const onSubmit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const created = await projectsApi.create(buildProjectCreate({ ...emptyProjectFormState(), name, description, members }));
      // 弹窗刻意省略预算/工作目录——建完直接进配置页接着配
      router.push(`/projects/${created.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title="新建项目"
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
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个项目是干什么的" maxLength={500} />
      </Field>
      <Field label="成员 bot（勾选加入本项目；同项目成员可互相 @。预算、工作目录建完进配置页配）">
        <MemberPicker
          bots={bots}
          selected={members}
          onToggle={(id, checked) =>
            setMembers((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)))
          }
          otherProjectOf={projectNameOf}
          maxHeightClass="max-h-52"
        />
      </Field>
    </FormModal>
  );
}
