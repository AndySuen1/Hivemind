# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 项目内沟通与代码注释一律用中文（technical terms 可保留英文）。

## 项目本质

Hivemind 是一个 Discord 多 agent 平台，核心是 **两层 LLM 分工**：

- **DeepSeek = 主脑**（OpenAI-compatible，经 AI SDK v5 `generateText` 的多步 tool-calling 循环驱动）。负责对话、调度、判断。
- **Claude Code = 工人**。当主脑判断遇到「真正要写/改/调试代码」的工程任务时，调用 `delegate_to_claude` 工具 spawn 一个 Claude Code 子进程（经 `@anthropic-ai/claude-agent-sdk` 的 `query()`）在工作目录内自主干活，过程实时反映到 Discord，危险操作走审批。

用户在 Discord DM / @ 一个 bot → orchestrator 跑工具循环 → 必要时委派 Claude → 回复。

## 常用命令

```bash
pnpm install              # 装依赖（会就地重编 better-sqlite3/keytar/electron 原生模块，见 pnpm-workspace.yaml 的 allowBuilds）
pnpm dev                  # 并行起 orchestrator(:3001) + dashboard(:3000)，不带托盘
pnpm dev:launcher         # Electron 托盘启动器（它再 spawn 上面两个服务）
pnpm dev:orchestrator     # 只起后端
pnpm dev:dashboard        # 只起管理网站
pnpm build:launcher       # tsc 编译 launcher 主进程

cp .env.example apps/orchestrator/.env   # 首次：填 DISCORD_BOT_TOKEN / DEEPSEEK_API_KEY / ALLOWED_USER_IDS
```

**类型检查**（无 lint，orchestrator 用 tsx 运行不产出 dist）：

```bash
apps/orchestrator/node_modules/.bin/tsc -p apps/orchestrator/tsconfig.json --noEmit
```

## 测试：standalone 冒烟脚本

没有正式 test runner。测试是 `apps/orchestrator/p*-smoke.ts` —— 独立 tsx 脚本，直接 import `./src/*.ts`、用临时 DB（`d:/tmp/*.db`）、自带 `check()` 断言并打印 ✓/✗。

```bash
# 跑单个（从仓库根）
apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pA-smoke.ts
```

各脚本对应的功能：`p2`=可观测性埋点链路 · `p3`=委派/权限消息解析 · `p4`=查询 API · `p5`=SSE 实时推送 · `p7`=数据保留清理 · `pA`=L1 对话复原 · `pB`=L2 滚动摘要 · `pC`=L4 FTS5 检索 · `pD`=L3 触发式整理 · `pE`=字符预算裁剪 · `pG`=Inter-Agent Router（任务预算/短循环/熔断/relay 注册消费，纯逻辑无 Discord）· `pH`=Project repo（项目 CRUD + 单 bot 单项目成员语义 + 删项目置空成员）· `pJ`=Skill 加载器（listSkills/frontmatter/路径穿越/composeSkillsPrompt）· `pK`=调度器（register 合法性/幂等/unregister/invoke 防重入）· `pL`=discord_push 白名单（命中/非白名单/缺上下文/fail-closed/发送失败）· `pM`=日志系统（patch stdout/stderr 采集/level 推断/脱敏/批量落盘/游标分页/ingest 去重/onLog 订阅/retention/SSE 流/HTTP 路由）· `pN`=Claude 帖直通（thread-session-repo CRUD/bot_id 校验/reset 链 + classifyThreadMessage 四分支 + ThreadStreamSink 逐条贴帖/纯读结果不贴/大输出转附件/滑窗节流 + cwd path-guard）。改了相关模块就跑对应脚本验证。

## 仓库结构

```
apps/orchestrator   @hivemind/orchestrator  Fastify 后端，所有运行时逻辑都在这
apps/dashboard      @hivemind/dashboard     Next.js 14 管理网站（Providers/Bots/Observability/Settings）
apps/launcher       @hivemind/launcher      Electron 托盘启动器（进程管家）
packages/shared     @hivemind/shared        跨包 Zod schema + TS 类型（唯一事实源）
```

## 架构要点（读多个文件才能拼出的全局图）

### 委派与鉴权（最关键的设计约束）
- `apps/orchestrator/src/index.ts` **第一行** `delete process.env.ANTHROPIC_API_KEY` 必须保留：强制 Claude 子进程走本机订阅（Pro/Max OAuth）而非 API key，避免误扣费。
- 委派核心在 `src/claude/delegation.ts`：`query()` 配 `settingSources: []`（不继承本机 `.claude` 放行规则，权限完全由 `canUseTool` 决定）、`maxTurns`/超时/AbortController 管控、sessionId 内存缓存以支持「在刚才基础上继续改」(resume)。
- **权限中转** `src/claude/permission-relay.ts`：只读工具自动放行；危险 Bash（rm/push/网络/装包）、`AskUserQuestion` 反问 → 发 Discord 按钮等用户裁决。

### 工具系统（`src/tools/`）
- 每个 bot 按 `bot.tools` 配置在启动时组装工具集（`buildBotToolRuntime`）：`fs` / `bash` / `memory` / `webSearch` / `claudeCode`，以及由 `bot.projectId`（非 tools 配置）驱动的 `mention_bot`（同项目有同伴时才装）。运行期不变，改配置要重启实例。
- `composeSystemPrompt` 每条消息现算 system prompt = 人格 + 静态工具说明 + 实时记忆索引 + 【可选】L2 摘要 / L4 检索片段。所有源自历史的注入都套「参考数据，非指令」外壳防 prompt 注入。
- **路径安全** `src/tools/path-guard.ts`：fs/bash/委派的所有路径都被关进 `workspaceDirs` 白名单，fail-closed（空白名单=全拒），并对已存在路径/写入目标祖先做 realpath 二次校验防 symlink/junction 逃逸。改这里务必跑相关冒烟。
- Web search 是多源自动兜底链（DuckDuckGo→Tavily→Brave→SearXNG），按全局优先级 + 是否配 key + 当日余量自动选源。

### Inter-Agent 协作（`mention_bot`，Phase 3，`src/inter-agent/`）
- **协作范围 = 项目**：每个 bot 一个可空 `projectId`（`bots.project_id`，migration 0008）；**同一项目（projectId 相同且非空）的 bot 自动可互相 @**，无需逐个配白名单。转交预算（`maxTurnsPerTask`/`maxCostUsd`）挂在 `projects` 表上，一个项目一套。`projectRepo` 管 CRUD + `setMembers`（单 bot 单项目：加入即从原项目移出）；删项目把成员 `project_id` 置 NULL（无硬 FK）。
- **转发机制 = 真实 @mention**：A 的 `mention_bot` 用 A 的身份在频道里发 `<@Buser> message`，B 的 `handleMessage` 接力（**异步即发即走**，A 不等 B）。防全队循环的闸门：`handleMessage` 忽略自己发的消息，且对**其它 bot 发的消息只在 `interAgentRouter.consumeRelay()` 命中我方登记的 relay 时**才处理，其余 bot/webhook 一律丢弃。
- `inter-agent/router.ts`（全局单例，纯逻辑无 Discord）：`taskRegistry`（一条 @ 链 = 一个 `MentionTask`，预算/跳数/路径的单一真相源，taskId 作跨 bot 血缘键）+ 待转交 relay 注册表（发 @ 前按 (channel,target,fromUser) FIFO 登记、发出后按 messageId 精确索引，消除网关/REST 竞态）+ 护栏（跳数 / 成本 / 短循环 A→B→A→B / 全局日成本熔断 `INTERAGENT_DAILY_USD_CAP`）。
- `bot-manager.deliverMention`（编排 Discord 副作用）：解析目标限定**同项目** enabled bot → 在线 → **目标按人类发起人做访问控制**（接力回合的唯一访问闸门，防 confused-deputy）→预算（项目）/循环/熔断检查。受阻 → `pauseTask` + 向发起人弹「继续/终止」按钮（`askResume`，仅 rootRequester）；继续会**重新校验在线+访问**后只放行这一跳。`buildBotToolRuntime` 仅在 bot 有 projectId 且项目里有同伴时装配 `mention_bot`（同伴名单进静态提示）。
- ⚠️ 项目成员/归属变更（`/api/projects/*` 或 bot 的 projectId 改动）会**重启受影响的 bot 实例**（刷新同伴名单 + 工具装配）；预算/项目名改动不重启（转交时实时读项目预算）。
- 链状态只在内存、**绝不进 LLM history**（铁律）；经 `experimental_context.mention` 传 `{taskId}`（接力）或 `{root}`（人类回合，首次转交才惰性开链；同回合后续调用写回 `taskId` 复用同链预算）。委派成本经 `delegate_to_claude` 回灌全局熔断 + 任务预算。

### Skill 系统 + 调度器（Phase 3.5，`skills.ts` / `scheduler.ts` / `tools/discord-push.ts`）
- **Skill = 受信资产，事实源在文件系统**：共享目录 `SKILL_ROOT/<name>/SKILL.md`（默认仓库父目录 `skills/`，与 `bot-memory/` 同级，env `SKILL_ROOT` 覆盖），YAML frontmatter 存 name/description。库里只存 `bots.skills: string[]`（启用了哪些名，migration 0010）。`buildBotToolRuntime` 把启用 skill 的 `SKILL.md` 经 `composeSkillsPrompt` 拼到 `staticPromptSuffix` 末尾——**直接当指令、不套「参考数据」外壳**（信任级同 systemPrompt，与 L2/L4 历史注入区别对待）；并把启用 skill 的目录并入 path-guard `workspaceDirs`，使 SKILL.md 引用的脚本可被 fs/bash 读。skill 名严格 `SKILL_NAME_RE`（小写 kebab）防 `join` 路径穿越。
- **discord_push 工具**：`bot.tools.discordPush.{enabled,channelIds}`。bot 主动推消息到白名单频道，经 `experimental_context.push`（`DiscordPushContext`，由 `BotInstance.buildPushContext` 注入，含绑定本 bot client 的 `sendToChannel`）。工具 execute 内做白名单校验（fail-closed：空=全拒），不抛、以「错误：」串返回。
- **调度器**：`scheduler.ts` 全局单例（node-cron v4，`noOverlap`+`running` Set 双重防重入，env `SCHEDULER_TZ` 默认 `Asia/Shanghai`）。**单向依赖**——不 import bot-manager；`BotInstance.start()` 末尾 `scheduler.register(this.bot, fire)`、`stop()` 开头 `unregister`，故 `restart()`(=stop+start) 自动「注销旧 cron + 注册新」。`bots.schedule: [{cron,prompt,targetChannelId?,enabled}]`（JSON 列，migration 0010）。
- **合成回合 `BotInstance.runSyntheticTurn`**（调度触发 + Dashboard 手动触发/测试运行共用，经 `BotManager.triggerBot`）：**不复用 `handleMessage`**（它私有且强依赖 Discord `Message`），而是经 `channelQueues` 串行 → 空历史 + 现算 system prompt（含已加载 skill）跑 `generateAgentReply` → 记 `schedule_trigger` 事件。`targetChannelId` 有值则最终回复直发该频道（平台授权，**不经** discordPush 白名单）；空则发哪靠 skill 内 `discord_push`。不写 `this.history`（不污染人类对话窗口）。
- **重启纪律**：`skills`/`schedule`/`tools.discordPush` 都进 BotInstance 启动快照，改了必须重启实例（`api.ts` 的 `needsRestart` 已纳入 `skills`/`schedule`；`tools` 改动已覆盖 discordPush）。skills/schedule 是 bot 私有，不触发 `restartProjectPeers`。
- **API/UI**：`api-skills.ts`（skill CRUD + `GET /api/schedules` 聚合 + 手动触发，`:name` 经 `SKILL_NAME_RE` 防穿越）；Dashboard `/skills` 页（编辑/调度/测试运行）+ bots 编辑页「技能·调度」tab。冒烟 `pJ`/`pK`/`pL`。

### 四层对话记忆（重启后仍能接上）
1. **L1** 近期逐字窗口（`bot-manager.ts`，每频道内存 history，重启首次见到该频道时从 `messages` 表复原）
2. **L2** 滚动摘要（`conversation-memory.ts`：把滑出窗口的旧轮 fold 进有字符上限的摘要，fire-and-forget，注入 system prompt）
3. **L4** FTS5 历史检索（`retrieval.ts` + migration 0007 触发器同步）
4. **L3** 触发式记忆固化（`memory-consolidation.ts`：把 L2 摘要整理进长期记忆 `.md` 文件，轮数触发 + 空闲后台 loop 双触发）

均为 best-effort：任一层失败只 `console.error`，绝不打断 Discord 回复路径。

### 可观测性
- `src/recorder.ts` 是**唯一写入口**：脱敏 → 截断 8KB → 事务写库 → EventEmitter 广播。所有埋点都经它，绝不直接碰 SQL，且整体 try/catch 永不阻断主流程。
- 数据流：`recorder` 落库 → 查询 API（`api-observ.ts`，游标分页）+ SSE 实时（`api-stream.ts`）→ dashboard。保留清理在 `observ-retention.ts`（启动恢复孤儿 running 回合 + 周期清理）。
- 面向前端的 camelCase 类型在 `packages/shared`；DB 行是 snake_case（migration 0005），repo 层映射。

### 可视化日志系统（与可观测性正交：采「原始运行日志」而非结构化业务事件）
- **背景**：全项目 80+ 处 `console.*` 只写 stdout/stderr；托盘开机自启用 wscript+VBS 隐藏了控制台窗口 → 这些日志原本无处可看。本系统把它们采集、落库、在 dashboard「监控」页「日志」tab 实时可视化。
- **采集核心** `src/log-collector.ts`（单例 `logCollector`，仿 recorder）：**patch `process.stdout/stderr.write`**（字节流层拦一次即覆盖所有 console.* / pino / 第三方库 / delegation 对 claude 子进程的直写），**不 patch console.\***（避免双记）。`record()` 入口脱敏（复用 `redactText`）+ 截断 → push 环形缓冲（事实源，最近 2000）→ `bus.emit` 广播 → 入 pending；**DB 是异步批量旁路**（`db.transaction()` 满 200 或 250ms 节流，失败丢这批不重试）——绝不在 Discord 热路径上同步 INSERT。**铁律：本模块任何代码禁用 console.\***（否则被自己的 patch 捕获 → 递归放大）；内部错误只写 `_lastError`，经 `/api/health` 的 `logCollector.stats()` 自检。
- `install()` 在 `index.ts` 的 dotenv 后、`initDb` 前调（抓最早 boot 日志）；`initStore(db)` 在 initDb 后 flush 早期 pending。`parseLine` 统一推断 level（pino JSON 抽 level / 关键词含中文「异常/失败/错误」）+ 解析 `[tag]` 前缀。
- **跨进程**（migration 0012 `logs` 表，无 CASCADE；清理并入 `observ-retention.ts` 的 sweep，env `LOG_RETENTION_DAYS` 默认 7）：launcher（CommonJS，**不能加载原生模块** → 不能直接写 SQLite）经 `apps/launcher/src/log-forwarder.ts` 把**它自身 + spawn 的 dashboard/orchestrator 子进程**的 stdout/stderr 用 `node:http` 批量 POST 到 orchestrator `POST /api/logs/ingest`（鉴权 `LOG_INGEST_TOKEN`，由 launcher 随机生成经 env **只**注入 orchestrator 子进程，绝不进 NEXT_PUBLIC）。转发 orchestrator 子进程是为了补齐其 **install 之前 / 崩溃那一刻**（EADDRINUSE/`[fatal]`）的日志——正常期与自捕获重复由 ingest 端按 `source+message+ts` 近窗口**去重**。
- 数据流：`logCollector` → 查询 `GET /api/logs`（游标分页 + level/source/q 过滤）+ SSE `GET /api/logs/stream`（`src/sse.ts` 共享骨架，与 `api-stream.ts` 同源）→ dashboard `components/observ/LogsView.tsx`（`use-log-stream.ts` + 去重合并 + 粘底 + 加载更早 + 100ms 批量 setText 防洪峰）。冒烟 `pM`。

### Claude 帖直通（论坛帖子 ↔ 本地 Claude Code session，`bot.tools.claudeThread`）
- **本质**：与 DeepSeek 主脑**并行**的第二条入口——「帖子 = Claude Code 终端」。`@bot + triggerKeyword`（默认「新建会话」）→ 在配置的 forum 频道建帖（`ChannelType.GuildForum`，`threads.create` 必带首条 message），帖子 1:1 绑定一个**按需 spawn 的本地 Claude session**；帖内每条白名单成员消息**直通**该 session（**跳过主脑、免逐条 @**），Claude 的文本/命令原文/工具结果按「步」实时贴帖；危险命令在帖里弹按钮（复用 `permission-relay`）。
- **会话机制 = 逐条 spawn + resume**（非常驻子进程）：每条消息 = 一次 `query({prompt, resume: 上次 session_id})`，`system/init` 拿到新 fork id 后**覆盖落库**。重启续接**零成本**——绑定查表即得（`thread_sessions`），下条消息 resume 即续；resume 失效则自动降级新开 + 提示。
- **复用核心** `src/claude/delegation-core.ts`：把「`buildClaudeOptions`（含 `settingSources:[]`/`resume`）+ `wireAbort`（AbortController+挂钟超时）+ `pumpQuery`（SDKMessage 流 → 可插拔 `ClaudeStreamSink`）+ `extractAssistant`/`extractToolResults`/`toolLabel`」从 `delegation.ts` 抽出。`runDelegation` 现是「`StatusEditSink`（编辑单条状态消息，行为不变）」薄封装；直通用 `ThreadStreamSink`（`src/claude/thread-stream-sink.ts`：逐条 `thread.send`，**纯读工具结果不贴**、大输出转附件、` ``` ` 围栏自适应、串行队列 + 滑窗节流 5 条/5 秒、收尾强制 flush，与 discord.js 解耦经 `ThreadStreamTarget` 注入便于单测）。**关键**：`pumpQuery` 消费 SDK 的 `type:'user'` 消息（旧委派从不消费）取 `tool_result`——这是「贴出真实命令输出」的数据源。
- **分流** `src/thread-router.ts`（纯函数 `classifyThreadMessage`）：`create`（@bot+触发词，非帖内，**快捷直建**）/`passthrough`（绑定 active 帖内任意消息）/`reset`（帖内命中 resetKeyword）/`normal`（其余走原 DeepSeek 流）。`bot-manager.handleMessage` 早期 `maybeHandleThread` 命中即 return，不入主脑。串行复用 `channelQueues`（key=thread.id 天然按帖串行）。访问控制沿用 `allowedRequesters`（**无 owner 限制**，团队共用帖）；危险命令审批找该回合触发者。
- **建帖双入口**：① 关键词快捷（上面的 `create` 分支，开头喊 triggerKeyword 直建，省一次主脑往返）；② **口语化**——普通 @bot 落 `normal` 进主脑工具循环，主脑判意图后调 `open_claude_thread` 工具（`src/tools/open-thread.ts`，仅在 `claudeThread.enabled && forumChannelId` 时装配）建帖。两入口共用 `BotInstance.createThreadSession`（建帖+绑定+fire 首轮）；工具经 `BotManager.openClaudeThread` 回调到发起实例（仿 `deliverMention`）。**建帖之后帖内对话恒走 passthrough 直通**，与入口无关。`open_claude_thread` 与 `delegate_to_claude` 的区别（要持续对话的专属帖 vs 当前频道一次性委派）写在工具 description 里。
- **重开 session**（`/reset`/「重开」）：让旧 Claude **自我总结**（resume 旧 session + `canUseTool` 全 deny + 安静渲染）成交接文档 → 写 `<cwd>/.hivemind-threads/<threadId>/gen-<N>-carryover.md`（过 `assertWriteTargetAllowed`）→ 文档作**新 session 开场白首 prompt**（不带 resume）→ **同一帖子**换 session、`reset_count++`、记 `thread_session_resets` 链。
- **持久化** `src/thread-session-repo.ts` + migration `0013`（`thread_sessions` 主键 thread_id、`claude_session_id`/`cwd`/`status`、无硬 FK；`thread_session_resets` reset 链）。与 recorder 的 `sessions` 表正交（那是可观测性）。**并发**：`concurrency.ts` 的 `tryAcquireThreadSlot`（**仅全局上限**，不套委派 per-bot=1，否则一 bot 多帖互堵）。成本回灌 `interAgentRouter` 全局熔断。可观测性新增事件类型 `thread_session_start`/`thread_reset`；`channelType` 区分 `'thread'`。
- **重启纪律**：`claudeThread` 进 BotInstance 启动快照，改了经 `tools` 变更 → `api.ts` 现有 `needsRestart` 已覆盖（无需新增字段）。绑定是 DB 事实源，重启实例不丢已绑定帖。冒烟 `pN`。

### 数据与密钥存储（三处，分工明确）
- **密钥**（provider API key / Discord token / web-search key）→ keytar 系统凭证库。service 名 `discord-agent-hub`（历史值，**勿改**，改了现有密钥全失联，见 `secrets.ts`）。
- **配置**（bots / providers）→ SQLite `data/app.db`（被 .gitignore 忽略）。
- **launcher 配置**（端口 / 开机自启 / controlToken）→ `userData/launcher.json`（端口是 spawn 服务的前置输入，故不放 SQLite）。
- **bot 长期记忆** → `bot-memory/<botId>/*.md`，默认在**仓库父目录**（`BOT_MEMORY_ROOT`），不在仓库内。

### DB migrations
- `src/migrations/NNNN_*.sql`，启动时 `db.ts` 自动按文件名顺序应用、记入 `schema_migrations`。WAL 模式 + `foreign_keys=ON`。加表/改表写新编号 SQL 文件即可。

### Bot 生命周期
- `BotManager` 单例管理每 bot 一个 `BotInstance`。dashboard 改配置 → 写 DB → `botManager.syncFromDb()` 对齐运行实例。
- ⚠️ `BotInstance` 构造时**快照** bot 配置；PATCH 改了 systemPrompt/temperature/tools/providerId/allowedRequesters/discordToken/enabled/projectId 任一，`api.ts` 必须**重启实例**才生效（`allowedRequesters` 是访问控制，漏重启=安全空窗；projectId/项目成员变更还要连带重启同项目同伴刷新协作名单）。
- 同频道消息走**串行队列**（`channelQueues`），杜绝并发读改写 history 丢轮；不同频道仍并发。

### Launcher 纪律
- orchestrator/dashboard **一律用系统 node 子进程 spawn**（`process-manager.ts`），主进程不加载任何原生模块 → `better-sqlite3`/`keytar` 沿用系统 Node ABI，**永不需要 electron-rebuild**。
- **绝不**用 Electron 的 `fork`/`UtilityProcess`（它们 `ELECTRON_RUN_AS_NODE=1` 仍跑 Electron ABI）。
- `scripts/dev.mjs` 启动 Electron 前会清掉 `ELECTRON_RUN_AS_NODE`（某些环境如 Agent SDK 会全局设它，否则 electron 以纯 Node 模式跑、`require('electron').app` 为 undefined 崩溃）。
- app 名 `discord-agent-hub-launcher`、keytar service `discord-agent-hub` 都是历史身份，绑定了 userData/开机自启/已存密钥，**改名会作废现有配置**。

## 工程约定 / 易踩的坑

- 全程 ESM（`"type": "module"`）+ TS `verbatimModuleSyntax`：**本地文件 import 要写 `.js` 扩展名**（即便源是 `.ts`），类型导入必须 `import type`。
- AI SDK v5：多步循环靠 `stopWhen: stepCountIs(N)`（默认 12 步防死循环）；Discord 上下文经 `experimental_context` 传进工具 `execute`；埋点经 `onStepFinish`（注意 tool-error 只进 `step.content` 不进 `toolResults`，需单独补记）。
- 模型完全由 **Provider** 决定，Bot 只挑 Provider（想换模型就新建 Provider）。DeepSeek 默认 temperature 1.3。
- API 安全：服务只监听 `127.0.0.1`；写路由额外有 Origin 白名单兜底（防 CSRF 简单请求）。
- `packages/shared` 是类型唯一事实源，改数据契约从这里改，前后端同步。
