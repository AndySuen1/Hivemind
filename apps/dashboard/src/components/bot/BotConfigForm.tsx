'use client';

import type { RefObject } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Plus, Puzzle, Sparkles, Wrench, X } from 'lucide-react';
import type { Provider, SkillSummary } from '@hivemind/shared';
import type { ProjectWithMembers } from '@/lib/api';
import type { BotFormState } from '@/lib/bot-form';
import { Button, Field, Input, Select, TabPanel, Tabs, Textarea, useTabs } from '@/components/ui';
import { AvatarPicker } from './AvatarPicker';

/** 工具卡外壳：浅灰底区分各工具模块。 */
function ToolCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-border bg-bg-subtle p-3">{children}</div>;
}

/** 工具开关行：复选框 + 标题 + 说明。 */
function ToolHeader({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" className="accent-primary-strong" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm font-medium text-fg">{title}</span>
      {desc && <span className="text-[11px] text-fg-subtle">{desc}</span>}
    </label>
  );
}

export interface BotConfigFormProps {
  state: BotFormState;
  setState: Dispatch<SetStateAction<BotFormState>>;
  providers: Provider[];
  projects: ProjectWithMembers[];
  availableSkills: SkillSummary[];
  botId?: string;
  nameRef?: RefObject<HTMLInputElement>;
}

/**
 * Bot 配置表单主体（4 个子页签：基本 / 工具 / 技能·调度 / 高级），不含弹窗与保存按钮。
 * 子页签经 useTabs 同步到 URL ?ctab=；状态由父组件持有（state + setState）。
 * 注：「启用」由详情页 header 的电源开关单独管，本表单不含 enabled 复选框（见 buildBotUpdate）。
 */
export function BotConfigForm({ state: s, setState, providers, projects, availableSkills, botId, nameRef }: BotConfigFormProps) {
  const set = <K extends keyof BotFormState>(k: K, v: BotFormState[K]) => setState((p) => ({ ...p, [k]: v }));
  const tabs = useTabs(
    [
      { key: 'basic', label: '基本设置' },
      { key: 'tools', label: '工具配置', icon: Wrench },
      { key: 'skills', label: '技能 · 调度', icon: Puzzle },
      { key: 'advanced', label: '高级 · 委派', icon: Sparkles },
    ],
    { queryKey: 'ctab', defaultKey: 'basic' },
  );
  const selectedProvider = providers.find((p) => p.id === s.providerId);

  return (
    <div>
      <Tabs {...tabs.tabProps} />
      <div className="mt-4 space-y-3">
        {/* —— 基本设置 —— */}
        <TabPanel tabKey="basic" activeKey={tabs.value} className="space-y-3">
          <Field label="头像（点击 / 拖入图片上传；不设则用名字首字自动生成）">
            <AvatarPicker value={s.avatar} onChange={(v) => set('avatar', v)} name={s.name} id={botId} />
          </Field>
          <Field label="Bot 名称（日志/列表显示，非 Discord 显示名）">
            <Input ref={nameRef} value={s.name} onChange={(e) => set('name', e.target.value)} placeholder="PM-Alice" required />
          </Field>
          <Field label="Discord Bot Token（留空 = 保持原值）">
            <Input
              type="password"
              value={s.discordToken}
              onChange={(e) => set('discordToken', e.target.value)}
              placeholder="••••••••（不改就留空）"
              className="font-mono"
            />
          </Field>
          <Field
            label="Provider（决定用哪个 API endpoint + 模型）"
            hint={
              selectedProvider ? (
                <>
                  想用别的模型？去{' '}
                  <a href="/providers" className="underline">
                    Providers
                  </a>{' '}
                  多加一个（API key 可以一样，model 不同）
                </>
              ) : undefined
            }
          >
            <Select value={s.providerId} onChange={(e) => set('providerId', e.target.value)} required>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} → {p.model}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="系统提示词（人格/工种）">
            <Textarea value={s.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} rows={4} />
          </Field>
          <Field label="岗位 / 工种（如 程序 / 策划 / 项目经理；同项目成员会自动看到彼此的岗位与分工，无需在提示词里手写团队名单）">
            <Input value={s.role} onChange={(e) => set('role', e.target.value)} placeholder="如：程序" />
          </Field>
          <Field
            label={`Temperature: ${s.temperature.toFixed(1)}（DeepSeek 官方推荐：编程/数学 0.0 · 数据分析 1.0 · 对话/翻译 1.3 · 创作 1.5）`}
          >
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={s.temperature}
              onChange={(e) => set('temperature', Number(e.target.value))}
              className="w-full accent-primary-strong"
            />
            <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
              <span>0.0 严谨</span>
              <span>1.0</span>
              <span>1.3 对话</span>
              <span>1.5 创作</span>
              <span>2.0 发散</span>
            </div>
          </Field>
          <Field label="Allowlist Discord User ID（多个用逗号/空格/换行分隔，留空 = 不限制）">
            <Textarea
              value={s.allowedRaw}
              onChange={(e) => set('allowedRaw', e.target.value)}
              placeholder="1234567890123456789"
              rows={2}
              className="font-mono"
            />
          </Field>
          <Field label="所属项目（同项目的 bot 可互相 @ 协作；去「项目」页管理成员与预算）">
            <Select value={s.projectId} onChange={(e) => set('projectId', e.target.value)}>
              <option value="">（不加入任何项目）</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </TabPanel>

        {/* —— 工具配置 —— */}
        <TabPanel tabKey="tools" activeKey={tabs.value} className="space-y-3">
          {(s.fsEnabled || s.bashEnabled || s.claudeEnabled) && (
            <div className="rounded border border-info/30 bg-info-soft/50 p-3">
              <div className="mb-1 text-[11px] font-medium text-info-fg">
                工作目录白名单（fs / bash / Claude 委派共用：fs 的可访问范围 + bash 与 Claude 子进程的起始
                cwd；每行一个绝对路径，留空 = 全部拒绝）
              </div>
              <Textarea
                value={s.wsDirs}
                onChange={(e) => set('wsDirs', e.target.value)}
                rows={2}
                placeholder={'D:\\workspaces\\bot-a'}
                className="font-mono text-xs"
              />
              <div className="mt-1 text-[10px] text-fg-subtle">
                ⚠️ bash 的命令可用绝对路径越出此范围（cwd 只是起始目录、不是沙箱）；真正的访问控制靠下面的
                allowlist。bash/fs 只给可信 bot。
              </div>
            </div>
          )}

          <ToolCard>
            <ToolHeader
              checked={s.fsEnabled}
              onChange={(v) => set('fsEnabled', v)}
              title="文件系统 fs"
              desc="read / write / edit / list / grep（范围 = 工作目录）"
            />
          </ToolCard>

          <ToolCard>
            <ToolHeader
              checked={s.bashEnabled}
              onChange={(v) => set('bashEnabled', v)}
              title="命令行 bash"
              desc="run_command（cwd = 工作目录 + 命令黑名单 + 超时）"
            />
            {s.bashEnabled && (
              <div className="mt-2 space-y-2">
                <Field label="命令黑名单（子串匹配，大小写不敏感，每行一条）">
                  <Textarea
                    value={s.bashDeny}
                    onChange={(e) => set('bashDeny', e.target.value)}
                    rows={3}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="单条命令超时（毫秒）" className="w-40">
                  <Input
                    type="number"
                    min={1000}
                    max={600000}
                    step={1000}
                    value={s.bashTimeout}
                    onChange={(e) => set('bashTimeout', Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
          </ToolCard>

          <ToolCard>
            <ToolHeader
              checked={s.memEnabled}
              onChange={(v) => set('memEnabled', v)}
              title="长期记忆 memory"
              desc={<>跨会话，存于 bot-memory/&lt;botId&gt;/</>}
            />
            {s.memEnabled && (
              <div className="mt-1 text-[11px] text-fg-muted">
                开启后，达一定轮数或会话空闲时会自动把对话要点「整理」固化进上面的长期记忆文件（合并去重、总量封顶）。
              </div>
            )}
          </ToolCard>

          <ToolCard>
            <div className="text-sm font-medium text-fg">对话记忆（会话连续性）</div>
            <div className="mt-1 text-[11px] text-fg-subtle">
              决定 bot「还记得多久前的对话」。重启后会从历史自动复原。与上面的长期记忆文件是两套机制。
            </div>
            <div className="mt-2 space-y-2">
              <Field label="近期逐字窗口（轮数，0 = 用全局默认 BOT_HISTORY_TURNS=20）" className="w-32">
                <Input type="number" min={0} max={100} value={s.convWindow} onChange={(e) => set('convWindow', Number(e.target.value))} />
              </Field>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary-strong"
                  checked={s.convSummary}
                  onChange={(e) => set('convSummary', e.target.checked)}
                />
                <span className="text-xs">滚动摘要（把更早对话压缩成摘要，记住整段会话且省 token）</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary-strong"
                  checked={s.convRetrieval}
                  onChange={(e) => set('convRetrieval', e.target.checked)}
                />
                <span className="text-xs">历史检索（按当前提问从更早消息召回相关片段）</span>
              </label>
            </div>
          </ToolCard>

          <ToolCard>
            <ToolHeader checked={s.webEnabled} onChange={(v) => set('webEnabled', v)} title="联网搜索 web_search" />
            {s.webEnabled && (
              <div className="mt-1 text-[11px] text-fg-muted">
                开启即用——系统自动按优先级{' '}
                <code className="rounded bg-bg-subtle px-1">SearXNG → Brave → Tavily → DuckDuckGo</code>{' '}
                选「已配置且当天还有余量」的源（在{' '}
                <a href="/providers" className="underline">
                  Providers
                </a>{' '}
                页配 key/URL）。无需勾选或设上限；内置防失控护栏。
              </div>
            )}
          </ToolCard>
        </TabPanel>

        {/* —— 技能 · 调度 —— */}
        <TabPanel tabKey="skills" activeKey={tabs.value} className="space-y-3">
          <ToolCard>
            <div className="text-sm font-medium text-fg">启用技能（Skill）</div>
            <div className="mt-1 text-[11px] text-fg-subtle">
              勾选的 skill 的 SKILL.md 会拼进本 bot 的 system prompt（领域玩法/SOP）。去
              <a href="/skills" className="underline">技能</a>页新建/编辑。
            </div>
            {availableSkills.length === 0 ? (
              <div className="mt-2 text-[11px] text-fg-subtle">还没有任何 skill —— 先去「技能」页新建一个。</div>
            ) : (
              <div className="mt-2 max-h-44 space-y-1 overflow-y-auto rounded border border-border bg-bg p-2">
                {availableSkills.map((sk) => (
                  <label key={sk.name} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary-strong"
                      checked={s.skills.includes(sk.name)}
                      onChange={(e) =>
                        setState((p) => ({
                          ...p,
                          skills: e.target.checked ? [...new Set([...p.skills, sk.name])] : p.skills.filter((x) => x !== sk.name),
                        }))
                      }
                    />
                    <span className="min-w-0">
                      <span className="text-fg">{sk.name}</span>
                      {sk.description && <span className="ml-1 text-[11px] text-fg-subtle">— {sk.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {s.skills
              .filter((n) => !availableSkills.some((sk) => sk.name === n))
              .map((n) => (
                <div key={n} className="mt-1 text-[10px] text-warning-fg">
                  ⚠️ 已启用「{n}」但该 skill 不存在（已被删除？运行时会被跳过）。
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => setState((p) => ({ ...p, skills: p.skills.filter((x) => x !== n) }))}
                  >
                    移除
                  </button>
                </div>
              ))}
          </ToolCard>

          <ToolCard>
            <ToolHeader
              checked={s.pushEnabled}
              onChange={(v) => set('pushEnabled', v)}
              title="📤 主动推送 discord_push"
              desc="允许 bot 主动把消息推到指定频道（不必等用户问）"
            />
            {s.pushEnabled && (
              <Field label="可推送的频道白名单（每行一个 channel id；留空 = 全部拒绝）" className="mt-2">
                <Textarea
                  value={s.pushChannels}
                  onChange={(e) => set('pushChannels', e.target.value)}
                  rows={2}
                  className="font-mono text-xs"
                  placeholder={'123456789012345678'}
                />
              </Field>
            )}
          </ToolCard>

          <ToolCard>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-fg">定时任务（调度器）</div>
                <div className="mt-1 text-[11px] text-fg-subtle">
                  到点把 prompt 当一回合注入触发执行。cron 5 段：
                  <code className="rounded bg-bg-subtle px-1">分 时 日 月 周</code>（如{' '}
                  <code className="rounded bg-bg-subtle px-1">0 9 * * 1-5</code> = 工作日 9 点）。改了保存会重启本 bot。
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leftIcon={<Plus className="size-3.5" />}
                onClick={() => setState((p) => ({ ...p, schedule: [...p.schedule, { cron: '', prompt: '', enabled: true }] }))}
              >
                新增一条
              </Button>
            </div>
            {s.schedule.length === 0 ? (
              <div className="mt-2 text-[11px] text-fg-subtle">暂无定时任务。</div>
            ) : (
              <div className="mt-2 space-y-2">
                {s.schedule.map((row, i) => (
                  <div key={i} className="rounded border border-border bg-bg p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={row.cron}
                        onChange={(e) =>
                          setState((p) => ({ ...p, schedule: p.schedule.map((r, j) => (j === i ? { ...r, cron: e.target.value } : r)) }))
                        }
                        placeholder="0 9 * * 1-5"
                        className="w-36 font-mono text-xs"
                      />
                      <label className="flex items-center gap-1 text-[11px] text-fg-muted">
                        <input
                          type="checkbox"
                          className="accent-primary-strong"
                          checked={row.enabled}
                          onChange={(e) =>
                            setState((p) => ({
                              ...p,
                              schedule: p.schedule.map((r, j) => (j === i ? { ...r, enabled: e.target.checked } : r)),
                            }))
                          }
                        />
                        启用
                      </label>
                      <button
                        type="button"
                        className="ml-auto text-fg-subtle hover:text-danger-fg"
                        title="删除这条"
                        onClick={() => setState((p) => ({ ...p, schedule: p.schedule.filter((_, j) => j !== i) }))}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    <Input
                      value={row.prompt}
                      onChange={(e) =>
                        setState((p) => ({ ...p, schedule: p.schedule.map((r, j) => (j === i ? { ...r, prompt: e.target.value } : r)) }))
                      }
                      placeholder="到点要 bot 做什么（如：播报一下当前状态）"
                      className="mt-2 text-xs"
                    />
                    <Input
                      value={row.targetChannelId ?? ''}
                      onChange={(e) =>
                        setState((p) => ({
                          ...p,
                          schedule: p.schedule.map((r, j) => (j === i ? { ...r, targetChannelId: e.target.value || undefined } : r)),
                        }))
                      }
                      placeholder="目标频道 id（可选，填了就把结果直接发该频道；留空则靠 skill 内 discord_push）"
                      className="mt-2 font-mono text-xs"
                    />
                    {!(row.cron.trim() && row.prompt.trim()) && (
                      <div className="mt-1.5 text-[10px] text-warning-fg">⚠️ cron 与 prompt 都要填，否则保存时这行会被忽略（不会注册、也无提示）。</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ToolCard>
        </TabPanel>

        {/* —— 高级 · 委派 —— */}
        <TabPanel tabKey="advanced" activeKey={tabs.value} className="space-y-3">
          <ToolCard>
            <ToolHeader
              checked={s.claudeEnabled}
              onChange={(v) => set('claudeEnabled', v)}
              title="🤖 Claude Code 委派 delegate_to_claude"
              desc="复杂工程任务交给 Claude（走本机订阅）"
            />
            {s.claudeEnabled && (
              <div className="mt-2 space-y-2">
                <div className="flex gap-3">
                  <Field label="最大轮数（防失控）" className="w-32">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={s.claudeMaxTurns}
                      onChange={(e) => set('claudeMaxTurns', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="单次超时（分钟）" className="w-32">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={s.claudeTimeoutMin}
                      onChange={(e) => set('claudeTimeoutMin', Number(e.target.value))}
                    />
                  </Field>
                </div>
                <div className="text-[11px] text-fg-muted">
                  Claude 在「工具配置」段的工作目录内干活。危险操作（删文件 / git push / 联网 / 装包）和澄清问题会
                  <strong>弹 Discord 按钮/菜单</strong>等你批准；只读与普通写自动放行。并发受限（单 bot 1 个 / 全局 5
                  个）。
                </div>
                <div className="text-[10px] text-warning-fg">
                  ⚠️ 计费：6/15 起 Agent SDK 用量走独立的「Agent SDK
                  月度额度」（与交互式 Claude Code 分开），用尽不回落。上线前请去 claude.ai 确认 opt-in 与额度。
                </div>
              </div>
            )}
          </ToolCard>
          {s.claudeEnabled && !(s.fsEnabled || s.bashEnabled) && (
            <div className="text-[11px] text-fg-subtle">
              提示：记得到「工具配置」段填好工作目录白名单，Claude 才有干活的地方。
            </div>
          )}

          <ToolCard>
            <ToolHeader
              checked={s.threadEnabled}
              onChange={(v) => set('threadEnabled', v)}
              title="🧵 Claude 帖直通（论坛帖 ↔ 本地 Claude session）"
              desc="@bot + 触发词 → 在论坛频道开帖；帖内每条消息直通一个本地 Claude Code session（跳过主脑），实时贴出对话与命令"
            />
            {s.threadEnabled && (
              <div className="mt-2 space-y-2">
                <Field label="论坛(Forum)频道 id（建帖目标；留空 = 不建帖、不接管任何帖）">
                  <Input
                    value={s.threadForumChannelId}
                    onChange={(e) => set('threadForumChannelId', e.target.value)}
                    placeholder="123456789012345678"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="建帖触发词（@bot + 该词才建帖；普通 @bot 仍走主脑对话）" className="w-64">
                  <Input value={s.threadTrigger} onChange={(e) => set('threadTrigger', e.target.value)} placeholder="新建会话" />
                </Field>
                <Field label="帖内「重开会话」关键词（每行一个；旧上下文自我总结成交接文档续接）">
                  <Textarea
                    value={s.threadResetKeywords}
                    onChange={(e) => set('threadResetKeywords', e.target.value)}
                    rows={2}
                    className="font-mono text-xs"
                    placeholder={'/reset\n重开'}
                  />
                </Field>
                <div className="flex gap-3">
                  <Field label="单回合最大轮数" className="w-32">
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={s.threadMaxTurns}
                      onChange={(e) => set('threadMaxTurns', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="单回合超时（分钟）" className="w-32">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={s.threadTimeoutMin}
                      onChange={(e) => set('threadTimeoutMin', Number(e.target.value))}
                    />
                  </Field>
                </div>
                <div className="text-[11px] text-fg-muted">
                  帖内驱动沿用本 bot 的 <strong>访问白名单</strong>（基本设置里的 allowedRequesters）；危险命令会
                  <strong>在帖里弹按钮</strong>等触发者批准。工作目录复用「工具配置」段的白名单（首条消息可用首个词指定子目录）。
                  绑定持久化、orchestrator 重启后回原帖可续。
                </div>
              </div>
            )}
          </ToolCard>
          {s.threadEnabled && !(s.fsEnabled || s.bashEnabled || s.claudeEnabled) && (
            <div className="text-[11px] text-fg-subtle">
              提示：记得到「工具配置」段填好工作目录白名单，Claude 帖才有干活的地方。
            </div>
          )}

          <div className="rounded border border-border bg-bg-subtle p-3 text-[11px] text-fg-muted">
            🤝 跨 bot 协作（mention_bot）现在由「项目」驱动：把本 bot 和同伴编进同一个「项目」，它们就能在频道里
            互相 @ 转交任务——在「基本设置」选所属项目，或去「项目」页统一编组。转交预算（跳数 / 成本）挂在项目上。
          </div>
        </TabPanel>
      </div>
    </div>
  );
}
