'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, BotUpdate, Provider, SkillSummary } from '@hivemind/shared';
import { AlertTriangle, Info, RefreshCw, RotateCcw } from 'lucide-react';
import { botsApi, type ProjectWithMembers } from '@/lib/api';
import { Button, Spinner, useConfirm, useToast } from '@/components/ui';
import { botToFormState, diffBotUpdate, isRestartExemptField, type BotFormState } from '@/lib/bot-form';
import { BotConfigForm } from './BotConfigForm';

// 需重启字段的中文标签（用于提醒条列出「哪些改动等待重启生效」）。avatar 不在此列——它免重启、即时自动保存。
const FIELD_LABELS: Partial<Record<keyof BotUpdate, string>> = {
  name: '名称',
  providerId: 'Provider',
  systemPrompt: '系统提示词',
  role: '岗位',
  temperature: 'Temperature',
  tools: '工具配置',
  allowedRequesters: 'Allowlist',
  projectId: '所属项目',
  skills: '技能',
  schedule: '调度',
};

/**
 * 详情页「设置」区：自动保存 + 重启提醒 + 还原。
 *
 * 设计（按用户要求「不触发重启的立即生效；触发重启的提醒需要重启」）：
 * - **免重启字段（仅 avatar）**：改了就自动 PATCH、即时生效，无需任何按钮。
 * - **需重启字段（其余全部 + discordToken）**：改了不静默重启，而是弹「需重启生效」提醒条，
 *   由用户点【保存并重启】显式应用（触发本 bot 实例重启），或点【放弃】丢弃未应用改动。
 * - **还原**：只要本次打开后往服务端写过东西（avatar 自动保存 / 应用过重启改动），就显示
 *   【还原到本次打开前】，把配置拨回 baseline（= 本次打开页面时的服务端配置；刷新页面后重置）。
 *
 * baseline / lastSaved 两个快照：
 * - baseline：本次打开时的服务端配置，还原目标，seededId 不变期间恒定（父级用 CSS 隐藏而非卸载本组件，
 *   故切「监控」tab 再切回也不重置，基线只随「刷新页面 / 切到别的 bot」而重置）。
 * - lastSaved：服务端当前持有的配置，随 avatar 自动保存 / 应用 / 还原同步更新。
 *
 * 写串行化（避免竞态）：avatar 自动保存、applyRestart、revert 三条写路径共享 busy/avatarSaving 闸门——
 * 同一时刻至多一条 PATCH 在途，且 lastSaved.current 只被「当前在途请求」按其发送值更新，杜绝乱序回写。
 */
export function BotConfigSection({
  bot,
  providers,
  projects,
  availableSkills,
  onSaved,
}: {
  bot: Bot;
  providers: Provider[];
  projects: ProjectWithMembers[];
  availableSkills: SkillSummary[];
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<BotFormState>(() => botToFormState(bot, providers[0]?.id));
  const baseline = useRef<BotFormState>(state); // 本次打开时的服务端配置（还原目标）
  const lastSaved = useRef<BotFormState>(state); // 服务端当前已持有的配置
  const seededId = useRef(bot.id); // 初值即首个 bot.id，故首渲不重播种
  const tokenApplied = useRef(false); // 本次会话是否应用过 token（还原时提示无法恢复旧 token）
  const [busy, setBusy] = useState(false); // 应用并重启 / 还原 进行中
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null); // 应用并重启 / 还原 的错误
  const [avatarErr, setAvatarErr] = useState<string | null>(null); // 头像自动保存的错误（与 saveErr 分开，互不抹除）

  // 供异步回调读取最新值的镜像 ref（避免闭包陈旧），每渲染同步
  const stateRef = useRef(state);
  stateRef.current = state;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const savingAvatar = useRef(false); // 头像 PATCH 在途中（串行闸门，比 avatarSaving state 更早置位）
  const failedAvatar = useRef<string | null>(null); // 上次保存失败的头像值——同值不自动重试，避免失败死循环
  const onSavedRef = useRef(onSaved); // 父级 onSaved 是内联箭头、每渲染换引用；用 ref 固定，避免拖累 effect 依赖
  onSavedRef.current = onSaved;

  // 切到别的 bot：重新播种所有快照与会话级标记
  useEffect(() => {
    if (seededId.current !== bot.id) {
      const fresh = botToFormState(bot, providers[0]?.id);
      setState(fresh);
      baseline.current = fresh;
      lastSaved.current = fresh;
      tokenApplied.current = false;
      failedAvatar.current = null;
      setSaveErr(null);
      setAvatarErr(null);
      seededId.current = bot.id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, providers]);

  // 头像保存的单次执行体：串行（savingAvatar 闸门）、让位给重启/还原（busyRef）、读最新 avatar（stateRef）。
  // 由防抖 effect 与「重试」按钮共用。
  const saveAvatarNow = useCallback(async () => {
    if (savingAvatar.current || busyRef.current) return; // 已有写在途 → 待其完成后由 effect 重触
    const target = stateRef.current.avatar;
    if (target === lastSaved.current.avatar) {
      // 无差异（可能已被 applyRestart/revert 一并写好）：顺带清掉残留的失败态，让「重试」不再是空操作
      failedAvatar.current = null;
      setAvatarErr(null);
      return;
    }
    savingAvatar.current = true;
    setAvatarSaving(true);
    setAvatarErr(null);
    try {
      await botsApi.update(bot.id, { avatar: target });
      lastSaved.current = { ...lastSaved.current, avatar: target };
      failedAvatar.current = null;
      onSavedRef.current?.();
    } catch (e) {
      failedAvatar.current = target;
      setAvatarErr(`头像保存失败：${(e as Error).message}`);
    } finally {
      savingAvatar.current = false;
      setAvatarSaving(false);
    }
  }, [bot.id]);

  // —— avatar 免重启自动保存（300ms 防抖；头像来自 picker，是离散事件而非逐字输入）——
  useEffect(() => {
    if (state.avatar === lastSaved.current.avatar) return; // 无差异
    if (busy || avatarSaving) return; // 让位给重启/还原；已有头像保存在途 → 其完成(avatarSaving→false)后本 effect 重跑
    if (avatarErr && state.avatar === failedAvatar.current) return; // 同一失败值不自动重试，等「重试」或换图
    const t = setTimeout(() => void saveAvatarNow(), 300);
    return () => clearTimeout(t);
  }, [state.avatar, busy, avatarSaving, avatarErr, saveAvatarNow]);

  // 应用所有「需重启」的 pending 改动（含 token）——触发本 bot 实例重启
  const applyRestart = async () => {
    if (busyRef.current || savingAvatar.current) return;
    const diff = diffBotUpdate(state, lastSaved.current);
    const patch: BotUpdate = { ...diff.patch };
    if (state.discordToken) patch.discordToken = state.discordToken;
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setSaveErr(null);
    try {
      await botsApi.update(bot.id, patch);
      lastSaved.current = { ...state, discordToken: '' };
      // 本次 patch 可能一并把 avatar 写成了好值 → 清掉残留的头像失败态，避免红条卡死
      failedAvatar.current = null;
      setAvatarErr(null);
      if (state.discordToken) {
        tokenApplied.current = true;
        setState((s) => ({ ...s, discordToken: '' })); // 清掉刚填的 token（已存入凭证库，避免回显/再次提交）
      }
      // 提醒条按新 lastSaved 收起：依赖 finally 的 setBusy(false) 触发的重渲重算 pendingDiff
      toast('已保存，正在重启本 bot…', { tone: 'success' });
      onSavedRef.current?.();
    } catch (e) {
      setSaveErr(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 放弃未应用的改动：把表单拨回 lastSaved（服务端当前值），不发请求、不重启
  const discardPending = () => {
    setState({ ...lastSaved.current, discordToken: '' });
    setSaveErr(null);
    failedAvatar.current = null; // avatar 已拨回服务端当前值 → 清头像失败态
    setAvatarErr(null);
  };

  // 还原到本次打开前：把服务端拨回 baseline（可能重启以撤销已应用的改动）
  const revert = async () => {
    if (busyRef.current || savingAvatar.current) return;
    const diff = diffBotUpdate(baseline.current, lastSaved.current);
    const willRestart = diff.restartChanged;
    // 有未保存的表单草稿（pending）也会被一并丢弃——明确告知
    const hasPendingDraft = diffBotUpdate(state, lastSaved.current).changedKeys.length > 0 || !!state.discordToken;
    const notes = [
      willRestart ? '会重启本 bot' : '',
      tokenApplied.current ? 'Discord Token 无法还原、仍为最后一次设定的值' : '',
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
    // 乐观：表单与 lastSaved 一起拨回基线，使 avatar 自动保存 effect 看到「无差异」而不重复 PATCH
    lastSaved.current = { ...baseline.current };
    setState({ ...baseline.current });
    failedAvatar.current = null; // 还原后 avatar 与基线一致 → 清头像失败态
    setAvatarErr(null);

    if (diff.changedKeys.length === 0) {
      toast('已放弃未应用的改动', { tone: 'success' }); // 服务端本就 == 基线，只丢弃 pending
      return;
    }
    setBusy(true);
    setSaveErr(null);
    try {
      await botsApi.update(bot.id, diff.patch);
      // 注意：不清 tokenApplied——token 物理上不可还原（diff 不含 token），服务端仍是本次新设的值
      toast(tokenApplied.current ? '其余已还原；Discord Token 仍为最后一次设定的值' : '已还原到本次打开前', {
        tone: 'success',
      });
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
  const pendingDiff = diffBotUpdate(state, lastSaved.current);
  const restartPending = pendingDiff.restartChanged || !!state.discordToken;
  const pendingLabels = pendingDiff.changedKeys
    .filter((k) => !isRestartExemptField(k))
    .map((k) => FIELD_LABELS[k] ?? k);
  if (state.discordToken) pendingLabels.push('Discord Token');
  // 本次打开后是否真往服务端写过东西（avatar 自动保存 / 应用过重启改动）→ 决定「还原」是否可用
  const serverChangedFromOpen = diffBotUpdate(lastSaved.current, baseline.current).changedKeys.length > 0;
  const writeBusy = busy || avatarSaving; // 任意写在途 → 禁用手动按钮

  return (
    <div className="max-w-2xl">
      {/* —— 自动保存 / 重启提醒 / 还原 控制条 —— */}
      <div className="mb-4 space-y-2">
        {restartPending && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft/60 px-3 py-2">
            <RefreshCw className="size-4 shrink-0 text-warning-fg" />
            <span className="min-w-0 text-xs text-warning-fg">
              以下改动需重启本 bot 才能生效：<strong className="font-medium">{pendingLabels.join('、')}</strong>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={discardPending} disabled={writeBusy}>
                放弃
              </Button>
              <Button size="sm" variant="primary" leftIcon={<RefreshCw className="size-3.5" />} loading={busy} disabled={avatarSaving} onClick={applyRestart}>
                保存并重启
              </Button>
            </div>
          </div>
        )}

        {/* 头像自动保存状态（与重启提醒并存）：失败可重试 / 进行中 / 闲时给中性说明（不假报成功） */}
        {avatarErr ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-danger-fg">
            <AlertTriangle className="size-3.5 shrink-0" /> {avatarErr}
            <Button size="sm" variant="ghost" disabled={writeBusy} onClick={() => void saveAvatarNow()}>
              重试
            </Button>
          </div>
        ) : avatarSaving ? (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <Spinner className="size-3" /> 头像保存中…
          </div>
        ) : !restartPending ? (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <Info className="size-3.5" /> 头像等不触发重启的改动会自动保存生效；其它改动改完点上方「保存并重启」。
          </div>
        ) : null}

        {serverChangedFromOpen && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <span className="min-w-0 text-[11px] text-fg-muted">本次打开页面后已修改并写入配置（自动生效部分已落库）。</span>
            <Button size="sm" variant="secondary" leftIcon={<RotateCcw className="size-3.5" />} loading={busy} disabled={avatarSaving} onClick={revert}>
              还原到本次打开前
            </Button>
          </div>
        )}
      </div>

      <BotConfigForm
        state={state}
        setState={setState}
        providers={providers}
        projects={projects}
        availableSkills={availableSkills}
        botId={bot.id}
      />
      {saveErr && <div className="mt-3 rounded bg-danger-soft p-2 text-xs text-danger-fg">{saveErr}</div>}
    </div>
  );
}
