'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Play, Plus, Puzzle, Save, Trash2 } from 'lucide-react';
import type { SkillSummary, SkillDetail, BotScheduleEntry } from '@hivemind/shared';
import { SKILL_NAME_RE } from '@hivemind/shared';
import { skillsApi, schedulesApi, botsApi, type BotWithRuntime } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormModal,
  Input,
  ListPanel,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  TabPanel,
  Tabs,
  Textarea,
  useConfirm,
  useTabs,
  useToast,
} from '@/components/ui';
import { listEq } from '@/lib/shallow-eq';

export default function SkillsPage() {
  const tabs = useTabs(
    [
      { key: 'editor', label: '技能编辑', icon: Puzzle },
      { key: 'schedule', label: '调度面板' },
      { key: 'run', label: '测试运行', icon: Play },
    ],
    { queryKey: 'tab' },
  );

  return (
    <PageContainer size="wide">
      <PageHeader
        title="技能"
        subtitle="编辑共享 SKILL.md；调度面板手动触发；给 bot 分配技能 / 编排定时任务在「Bots」编辑页的「技能·调度」。"
      />
      <Tabs {...tabs.tabProps} />
      <div className="mt-4">
        <TabPanel tabKey="editor" activeKey={tabs.value}>
          <SkillEditorTab />
        </TabPanel>
        <TabPanel tabKey="schedule" activeKey={tabs.value}>
          <ScheduleTab />
        </TabPanel>
        <TabPanel tabKey="run" activeKey={tabs.value}>
          <RunTab />
        </TabPanel>
      </div>
    </PageContainer>
  );
}

// ============================================================
// 技能编辑（左列表 + 右 SKILL.md 编辑器）
// ============================================================
function SkillEditorTab() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const refreshList = async (selectName?: string) => {
    try {
      const items = await skillsApi.list();
      setList(items);
      if (selectName) void openSkill(selectName);
      else if (selected && !items.some((s) => s.name === selected)) {
        setSelected(null);
        setContent('');
      }
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSkill = async (name: string) => {
    if (dirty && name !== selected) {
      const ok = await confirm({ title: '放弃未保存的修改？', confirmText: '放弃', danger: true });
      if (!ok) return;
    }
    try {
      const detail = await skillsApi.get(name);
      setSelected(name);
      setContent(detail.content);
      setDirty(false);
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    }
  };

  const onSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await skillsApi.save(selected, content);
      setDirty(false);
      toast('已保存', { tone: 'success' });
      void refreshList();
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: `删除技能「${selected}」？`,
      description: '会删除整个 skill 目录。启用了它的 bot 在下次重启后会跳过该技能。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await skillsApi.delete(selected);
      setSelected(null);
      setContent('');
      setDirty(false);
      void refreshList();
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    }
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <ListPanel
        title="技能"
        count={list.length}
        className="w-full lg:w-64"
        subtitle={
          <button type="button" className="text-primary hover:underline" onClick={() => setShowNew(true)}>
            + 新建
          </button>
        }
      >
        {loading ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 rounded" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="p-3 text-[11px] text-fg-subtle">还没有技能。点上方「+ 新建」创建一个。</div>
        ) : (
          list.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => void openSkill(s.name)}
              className={`block w-full border-b border-border px-3 py-2 text-left text-sm transition-colors ${
                selected === s.name ? 'bg-primary-soft text-primary' : 'hover:bg-bg-hover'
              }`}
            >
              <div className="truncate font-medium text-fg">{s.name}</div>
              {s.description && <div className="truncate text-[11px] text-fg-subtle">{s.description}</div>}
            </button>
          ))
        )}
      </ListPanel>

      <div className="min-w-0 flex-1">
        {!selected ? (
          <EmptyState title="选择一个技能编辑" description="或在左侧「+ 新建」创建一个新技能。" />
        ) : (
          <Card padding="md">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Puzzle className="size-4 text-fg-subtle" />
                <span className="font-semibold text-fg">{selected}</span>
                {dirty && <Badge tone="warning">未保存</Badge>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" leftIcon={<Save className="size-3.5" />} loading={saving} onClick={onSave} disabled={!dirty}>
                  保存
                </Button>
                <Button size="sm" variant="danger" leftIcon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                  删除
                </Button>
              </div>
            </div>
            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              className="h-[58vh] w-full font-mono text-xs"
              spellCheck={false}
            />
            <div className="mt-1 text-[10px] text-fg-subtle">
              顶部 YAML frontmatter 的 <code className="rounded bg-bg-subtle px-1">name</code> /{' '}
              <code className="rounded bg-bg-subtle px-1">description</code> 用于列表展示；正文是给 bot 读的说明书。
            </div>
          </Card>
        )}
      </div>

      <NewSkillModal
        open={showNew}
        existingNames={list.map((s) => s.name)}
        onClose={() => setShowNew(false)}
        onDone={(name) => {
          setShowNew(false);
          void refreshList(name);
        }}
      />
    </div>
  );
}

function NewSkillModal({
  open,
  existingNames,
  onClose,
  onDone,
}: {
  open: boolean;
  existingNames: string[];
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setErr(null);
      setSubmitting(false);
    }
  }, [open]);

  const valid = SKILL_NAME_RE.test(name);
  const taken = existingNames.includes(name);

  const onSubmit = async () => {
    if (!valid || taken) return;
    setSubmitting(true);
    setErr(null);
    try {
      await skillsApi.create({ name });
      onDone(name);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormModal open={open} onClose={onClose} title="新建技能" size="sm" onSubmit={onSubmit} submitting={submitting} error={err} initialFocusRef={nameRef}>
      <Field label="技能名（小写字母/数字/连字符，如 daily-status）">
        <Input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="daily-status"
          invalid={name.length > 0 && (!valid || taken)}
        />
        {name.length > 0 && !valid && <div className="mt-1 text-[10px] text-danger-fg">只能用小写字母、数字、连字符，且以字母/数字开头。</div>}
        {valid && taken && <div className="mt-1 text-[10px] text-danger-fg">该名字已存在。</div>}
      </Field>
      <div className="text-[11px] text-fg-subtle">创建后会生成一个带模板的 SKILL.md，可继续编辑。</div>
    </FormModal>
  );
}

// ============================================================
// 调度面板（聚合所有 bot 的 schedule + 手动触发）
// ============================================================
function ScheduleTab() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<BotScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await schedulesApi.list();
        if (!alive) return;
        // 内容相等则短路，避免 5s 轮询闪烁
        setEntries((prev) =>
          listEq(prev, next, (e) => [e.botId, e.index, e.cron, e.prompt, e.enabled, e.botOnline]) ? prev : next,
        );
      } catch {
        // 静默：保留上次数据
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const onRun = async (e: BotScheduleEntry) => {
    const key = `${e.botId}:${e.index}`;
    setRunning(key);
    try {
      const ack = await schedulesApi.run(e.botId, e.index);
      if (ack.status === 'triggered') toast(`已触发「${e.botName}」，去监控页查看结果`, { tone: 'success' });
      else if (ack.status === 'offline') toast(`「${e.botName}」未在线`, { tone: 'warning' });
      else toast(ack.message ?? '触发失败', { tone: 'danger' });
    } catch (err) {
      toast((err as Error).message, { tone: 'danger' });
    } finally {
      setRunning(null);
    }
  };

  if (loading) return <Skeleton className="h-32 rounded-lg" />;
  if (entries.length === 0)
    return (
      <EmptyState
        title="还没有任何定时任务"
        description="去「Bots」编辑某个 bot 的「技能·调度」tab 添加 cron 定时任务，这里会汇总展示并支持手动触发。"
      />
    );

  return (
    <div className="space-y-2">
      {entries.map((e) => {
        const key = `${e.botId}:${e.index}`;
        return (
          <Card key={key} padding="md">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`inline-block size-2 rounded-full ${e.botOnline ? 'bg-success' : 'bg-fg-subtle'}`} />
                  <span className="font-medium text-fg">{e.botName}</span>
                  <code className="rounded bg-bg-subtle px-1 text-xs">{e.cron}</code>
                  <Badge tone={e.enabled ? 'success' : 'neutral'}>{e.enabled ? '启用' : '停用'}</Badge>
                  {e.targetChannelId && <Badge tone="info">直发频道</Badge>}
                </div>
                <div className="mt-1 truncate text-xs text-fg-muted">{e.prompt}</div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Play className="size-3.5" />}
                loading={running === key}
                disabled={!e.botOnline}
                title={e.botOnline ? '立即跑一次' : 'bot 离线，先去 Bots 启用'}
                onClick={() => void onRun(e)}
              >
                手动触发
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================
// 测试运行（选 bot + prompt → 立即触发一回合）
// ============================================================
function RunTab() {
  const { toast } = useToast();
  const [bots, setBots] = useState<BotWithRuntime[]>([]);
  const [botId, setBotId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void botsApi
      .list()
      .then((bs) => {
        setBots(bs);
        const firstOnline = bs.find((b) => b.runtime.status === 'online');
        if (firstOnline) setBotId(firstOnline.id);
      })
      .catch(() => {});
  }, []);

  const onRun = async () => {
    if (!botId || !prompt.trim()) return;
    setRunning(true);
    try {
      const ack = await schedulesApi.triggerBot(botId, prompt.trim());
      if (ack.status === 'triggered') toast('已触发，结果会出现在该 bot 的频道与「监控」页', { tone: 'success' });
      else if (ack.status === 'offline') toast('该 bot 未在线', { tone: 'warning' });
      else toast(ack.message ?? '触发失败', { tone: 'danger' });
    } catch (e) {
      toast((e as Error).message, { tone: 'danger' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card padding="md" className="max-w-2xl space-y-3">
      <div className="text-[11px] text-fg-subtle">
        用任意 prompt 立即触发某个 bot 跑一回合（等同调度到点）。常用于调试 skill：让 bot 按 SKILL.md 跑一遍，
        到 <Link href="/observability" className="underline">监控</Link> 页看执行追踪。
      </div>
      <Field label="选择 bot">
        <Select value={botId} onChange={(e) => setBotId(e.target.value)}>
          <option value="">（选择一个 bot）</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id} disabled={b.runtime.status !== 'online'}>
              {b.name}
              {b.runtime.status !== 'online' ? '（离线）' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="触发 prompt">
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="如：播报一下当前状态" />
      </Field>
      <Button variant="primary" leftIcon={<Play className="size-4" />} loading={running} disabled={!botId || !prompt.trim()} onClick={onRun}>
        运行一次
      </Button>
    </Card>
  );
}
