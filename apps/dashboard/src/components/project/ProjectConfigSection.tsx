'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectUpdate } from '@hivemind/shared';
import { AlertTriangle, Info, RefreshCw, RotateCcw } from 'lucide-react';
import { projectsApi, type ProjectWithMembers, type BotWithRuntime } from '@/lib/api';
import { Button, Spinner, useConfirm, useToast } from '@/components/ui';
import {
  diffProjectUpdate,
  isRestartExemptField,
  projectToFormState,
  type ProjectFormState,
} from '@/lib/project-form';
import { ProjectConfigForm } from './ProjectConfigForm';

// 需重启成员的字段标签（用于「哪些改动等待重启生效」提醒条）。
const FIELD_LABELS: Partial<Record<keyof ProjectUpdate, string>> = {
  name: '项目名称',
  workspaceDirs: '工作目录',
  memberBotIds: '成员',
};

// 规范化 exempt 子集的快照 key（自动保存去重 / 失败值比对都用它）。
const exemptKey = (s: ProjectFormState): string =>
  JSON.stringify({ description: s.description, maxTurnsPerTask: s.maxTurnsPerTask, maxCostUsd: s.maxCostUsd });

/**
 * 项目配置页「设置」区：自动保存 + 重启提醒 + 还原（对标 BotConfigSection）。
 *
 * - **免重启字段（描述 / 预算）**：改了就防抖（800ms）自动 PATCH 仅这几项，即时生效、不重启成员。
 * - **需重启字段（名称 / 工作目录 / 成员）**：改了弹「需重启相关成员」提醒条，点【保存并重启】显式应用。
 * - **还原**：本次打开后往服务端写过东西就显示【还原到本次打开前】，把配置拨回 baseline（刷新页面后重置）。
 *
 * 写串行化：自动保存 / applyRestart / revert 三条写路径共享 busy/savingAuto 闸——同一时刻至多一条 PATCH 在途，
 * 且 lastSaved.current 只被「当前在途请求」按其发送值更新（自动保存只并三个 exempt 字段，applyRestart 写整快照），杜绝乱序回写。
 */
export function ProjectConfigSection({
  project,
  bots,
  projects,
  onSaved,
}: {
  project: ProjectWithMembers;
  bots: BotWithRuntime[];
  projects: ProjectWithMembers[];
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<ProjectFormState>(() => projectToFormState(project));
  const baseline = useRef<ProjectFormState>(state); // 本次打开时的服务端配置（还原目标）
  const lastSaved = useRef<ProjectFormState>(state); // 服务端当前已持有的配置
  const seededId = useRef(project.id);
  const [busy, setBusy] = useState(false); // 应用并重启 / 还原 进行中
  const [autoSaving, setAutoSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [autoErr, setAutoErr] = useState<string | null>(null);

  // 供异步回调读取最新值的镜像 ref
  const stateRef = useRef(state);
  stateRef.current = state;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const savingAuto = useRef(false); // 自动保存 PATCH 在途中（串行闸，比 autoSaving state 更早置位）
  const failedAuto = useRef<string | null>(null); // 上次保存失败的 exempt 快照——同值不自动重试
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // 切到别的项目：重新播种所有快照与标记
  useEffect(() => {
    if (seededId.current !== project.id) {
      const fresh = projectToFormState(project);
      setState(fresh);
      baseline.current = fresh;
      lastSaved.current = fresh;
      failedAuto.current = null;
      setSaveErr(null);
      setAutoErr(null);
      seededId.current = project.id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project]);

  // 自动保存的单次执行体：串行、让位给重启/还原、读最新值。只发变化了的 exempt 子集。
  const saveExemptNow = useCallback(async () => {
    if (savingAuto.current || busyRef.current) return;
    const diff = diffProjectUpdate(stateRef.current, lastSaved.current);
    const exemptPatch: ProjectUpdate = {};
    for (const k of diff.changedKeys) {
      if (isRestartExemptField(k)) (exemptPatch as Record<string, unknown>)[k] = (diff.patch as Record<string, unknown>)[k];
    }
    if (Object.keys(exemptPatch).length === 0) {
      // 无差异（可能已被 applyRestart/revert 一并写好）：清掉残留失败态，让「重试」不再是空操作
      failedAuto.current = null;
      setAutoErr(null);
      return;
    }
    const snapshot = exemptKey(stateRef.current);
    savingAuto.current = true;
    setAutoSaving(true);
    setAutoErr(null);
    try {
      await projectsApi.update(project.id, exemptPatch);
      // 只把这三个 exempt 字段并进 lastSaved，不覆盖待处理的 restart 字段编辑
      lastSaved.current = {
        ...lastSaved.current,
        description: stateRef.current.description,
        maxTurnsPerTask: stateRef.current.maxTurnsPerTask,
        maxCostUsd: stateRef.current.maxCostUsd,
      };
      failedAuto.current = null;
      onSavedRef.current?.();
    } catch (e) {
      failedAuto.current = snapshot;
      setAutoErr(`自动保存失败：${(e as Error).message}`);
    } finally {
      savingAuto.current = false;
      setAutoSaving(false);
    }
  }, [project.id]);

  // —— 免重启字段防抖自动保存（800ms；描述是自由文本、预算是数字，比 bots 的 300ms 长）——
  // 只依赖三个 exempt 字段：编辑 name/工作目录/成员 不应重置本次防抖。
  useEffect(() => {
    const changed =
      state.description !== lastSaved.current.description ||
      state.maxTurnsPerTask !== lastSaved.current.maxTurnsPerTask ||
      state.maxCostUsd !== lastSaved.current.maxCostUsd;
    if (!changed) return; // 无 exempt 差异
    if (busy || autoSaving) return; // 让位；已有自动保存在途 → 其完成(autoSaving→false)后本 effect 重跑
    if (autoErr && exemptKey(state) === failedAuto.current) return; // 同一失败值不自动重试
    const t = setTimeout(() => void saveExemptNow(), 800);
    return () => clearTimeout(t);
  }, [state.description, state.maxTurnsPerTask, state.maxCostUsd, busy, autoSaving, autoErr, saveExemptNow]);

  // 应用所有 pending 改动（含需重启字段）——触发相关成员重启
  const applyRestart = async () => {
    if (busyRef.current || savingAuto.current) return;
    const diff = diffProjectUpdate(state, lastSaved.current);
    if (Object.keys(diff.patch).length === 0) return;
    setBusy(true);
    setSaveErr(null);
    try {
      await projectsApi.update(project.id, diff.patch);
      lastSaved.current = { ...state };
      failedAuto.current = null; // 整快照写入可能一并修好了 exempt 字段
      setAutoErr(null);
      toast(diff.restartChanged ? '已保存，正在重启相关成员…' : '已保存', { tone: 'success' });
      onSavedRef.current?.();
    } catch (e) {
      setSaveErr(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 放弃未应用的改动：拨回 lastSaved（服务端当前值），不发请求
  const discardPending = () => {
    setState({ ...lastSaved.current });
    setSaveErr(null);
    failedAuto.current = null;
    setAutoErr(null);
  };

  // 还原到本次打开前：把服务端拨回 baseline（可能重启成员以撤销已应用的改动）
  const revert = async () => {
    if (busyRef.current || savingAuto.current) return;
    const diff = diffProjectUpdate(baseline.current, lastSaved.current);
    const willRestart = diff.restartChanged;
    const hasPendingDraft = diffProjectUpdate(state, lastSaved.current).changedKeys.length > 0;
    const notes = [
      willRestart ? '会重启相关成员' : '',
      hasPendingDraft ? '你正在编辑但尚未保存的改动也会一并丢弃' : '',
    ].filter(Boolean);
    const ok = await confirm({
      title: '还原本次所有改动？',
      description: `将把配置恢复到本次打开页面时的状态${notes.length ? '（' + notes.join('；') + '）' : ''}。`,
      confirmText: '还原',
    });
    if (!ok) return;

    const prevSaved = lastSaved.current;
    const prevState = state;
    // 乐观：表单与 lastSaved 一起拨回基线，使自动保存 effect 看到「无差异」而不重复 PATCH
    lastSaved.current = { ...baseline.current };
    setState({ ...baseline.current });
    failedAuto.current = null;
    setAutoErr(null);

    if (diff.changedKeys.length === 0) {
      toast('已放弃未应用的改动', { tone: 'success' }); // 服务端本就 == 基线，只丢弃 pending
      return;
    }
    setBusy(true);
    setSaveErr(null);
    try {
      await projectsApi.update(project.id, diff.patch);
      toast(willRestart ? '已还原到本次打开前，正在重启相关成员…' : '已还原到本次打开前', { tone: 'success' });
      onSavedRef.current?.();
    } catch (e) {
      lastSaved.current = prevSaved; // 回滚乐观更新
      setState(prevState);
      setSaveErr(`还原失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // —— 派生：哪些 pending 需重启 / 服务端是否已偏离打开前 ——
  const pendingDiff = diffProjectUpdate(state, lastSaved.current);
  const restartPending = pendingDiff.restartChanged;
  const pendingLabels = pendingDiff.changedKeys
    .filter((k) => !isRestartExemptField(k))
    .map((k) => FIELD_LABELS[k] ?? k);
  const serverChangedFromOpen = diffProjectUpdate(lastSaved.current, baseline.current).changedKeys.length > 0;
  const writeBusy = busy || autoSaving;

  return (
    <div className="max-w-2xl">
      {/* —— 自动保存 / 重启提醒 / 还原 控制条 —— */}
      <div className="mb-4 space-y-2">
        {restartPending && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft/60 px-3 py-2">
            <RefreshCw className="size-4 shrink-0 text-warning-fg" />
            <span className="min-w-0 text-xs text-warning-fg">
              以下改动需重启相关成员才能生效：<strong className="font-medium">{pendingLabels.join('、')}</strong>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={discardPending} disabled={writeBusy}>
                放弃
              </Button>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<RefreshCw className="size-3.5" />}
                loading={busy}
                disabled={autoSaving}
                onClick={applyRestart}
              >
                保存并重启
              </Button>
            </div>
          </div>
        )}

        {autoErr ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-danger-fg">
            <AlertTriangle className="size-3.5 shrink-0" /> {autoErr}
            <Button size="sm" variant="ghost" disabled={writeBusy} onClick={() => void saveExemptNow()}>
              重试
            </Button>
          </div>
        ) : autoSaving ? (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <Spinner className="size-3" /> 保存中…
          </div>
        ) : !restartPending ? (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <Info className="size-3.5" /> 描述、预算等不触发重启的改动会自动保存生效；改名 / 工作目录 / 成员改完点上方「保存并重启」。
          </div>
        ) : null}

        {serverChangedFromOpen && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <span className="min-w-0 text-[11px] text-fg-muted">本次打开页面后已修改并写入配置（自动生效部分已落库）。</span>
            <Button size="sm" variant="secondary" leftIcon={<RotateCcw className="size-3.5" />} loading={busy} disabled={autoSaving} onClick={revert}>
              还原到本次打开前
            </Button>
          </div>
        )}
      </div>

      <ProjectConfigForm state={state} setState={setState} bots={bots} projects={projects} currentProjectId={project.id} />
      {saveErr && <div className="mt-3 rounded bg-danger-soft p-2 text-xs text-danger-fg">{saveErr}</div>}
    </div>
  );
}
