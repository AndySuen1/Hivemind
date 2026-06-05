'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { projectsApi, botsApi, type ProjectWithMembers, type BotWithRuntime } from '@/lib/api';
import {
  Button,
  EmptyState,
  PageContainer,
  PageHeader,
  Skeleton,
  useConfirm,
  useToast,
} from '@/components/ui';
import { ProjectConfigSection } from '@/components/project/ProjectConfigSection';

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const router = useRouter();
  const [project, setProject] = useState<ProjectWithMembers | null>(null);
  const [bots, setBots] = useState<BotWithRuntime[]>([]);
  const [projects, setProjects] = useState<ProjectWithMembers[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const { toast } = useToast();

  // 重新拉取本项目（保存后刷新；seededId 守卫保证不会重置正在编辑的草稿）
  const reload = useCallback(() => {
    void projectsApi.get(projectId).then(setProject).catch(() => setNotFound(true));
  }, [projectId]);

  // 挂载取一次：本项目 + 全部 bot（成员选择/头像）+ 全部项目（「在其他项目」提示）。不轮询。
  useEffect(() => {
    void projectsApi.get(projectId).then(setProject).catch(() => setNotFound(true));
    void botsApi.list().then(setBots).catch(() => {});
    void projectsApi.list().then(setProjects).catch(() => {});
  }, [projectId]);

  const onDelete = async () => {
    const ok = await confirm({
      title: `删除项目「${project?.name ?? projectId}」？`,
      description: '成员 bot 不会被删除，只是移出本项目（随之失去互相 @ 的能力）。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setActionErr(null);
    try {
      await projectsApi.delete(projectId);
      toast('已删除', { tone: 'success' });
      router.push('/projects');
    } catch (e) {
      setActionErr((e as Error).message);
    }
  };

  return (
    <PageContainer size="default">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/projects" className="hover:underline">
              项目
            </Link>{' '}
            / {project?.name ?? projectId}
          </>
        }
        title={project ? project.name : <Skeleton className="h-8 w-48" />}
        actions={
          project && (
            <Button variant="danger" size="sm" leftIcon={<Trash2 className="size-4" />} onClick={onDelete} title="删除该项目">
              删除项目
            </Button>
          )
        }
      />
      {actionErr && <div className="mb-3 rounded bg-danger-soft p-2 text-xs text-danger-fg">操作失败：{actionErr}</div>}

      {notFound ? (
        <EmptyState
          title="项目不存在或已删除"
          description="它可能已被删除。回到项目列表看看。"
          action={
            <Button variant="primary" onClick={() => router.push('/projects')}>
              返回项目列表
            </Button>
          }
        />
      ) : project ? (
        <ProjectConfigSection project={project} bots={bots} projects={projects} onSaved={reload} />
      ) : (
        <Skeleton className="h-64 w-full max-w-2xl rounded-lg" />
      )}
    </PageContainer>
  );
}
