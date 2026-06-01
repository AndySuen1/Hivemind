# discord-agent-hub

通过 Discord 远程指挥本机 Claude Code 干活，多 bot / 多 LLM 协作平台。

## 快速开始（Phase 0 单 bot 对话）

```bash
# 1. 装依赖（首次）
pnpm install

# 2. 配置环境变量
cp .env.example apps/orchestrator/.env
# 编辑 apps/orchestrator/.env 填入 DISCORD_BOT_TOKEN / DEEPSEEK_API_KEY / ALLOWED_USER_IDS

# 3. 跑起来
pnpm dev
```

启动后在 Discord DM 这个 bot 任意消息，应该收到 DeepSeek 的回复。

## 桌面托盘启动器（一键启动 + 托盘）

`apps/launcher` 是 Electron 托盘启动器：一条命令启动后驻留系统托盘，自动拉起 orchestrator + dashboard。

```bash
pnpm dev:launcher
```

托盘菜单：打开管理网站 / 启动·停止·重启服务 / 开机自启 / 退出。管理网站「系统设置」页可改端口、开机自启、导出/导入配置。细节见 [apps/launcher/README.md](apps/launcher/README.md)。

## 在新机器上运行（clone 后继续开发 / 使用）

前提：**Node ≥ 20、pnpm、git**。

```bash
git clone <你的仓库地址>
cd discord-agent-hub
pnpm install        # 重新下载 electron + 就地重编原生模块（better-sqlite3 / keytar）
pnpm dev:launcher   # 或 pnpm dev（不带托盘，仅两个服务）
```

- **electron 下载慢 / 断**（国内常见）：用镜像重试
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node apps/launcher/node_modules/electron/install.js`
- **密钥与 bot 配置不随仓库走（按设计）**：
  - API key / Discord token 存系统凭证库（keytar）；bots / providers 存**被 git 忽略**的 `data/app.db`。
  - 迁移：旧机器在 dashboard「系统设置 → 配置迁移」勾「包含密钥」**导出 JSON**，新机器**导入**即可；或在新机器重新添加 Provider / Bot。
  - ⚠️ 含密钥的导出文件请勿提交到 git 或外发。
- **跨平台**：Windows / macOS 均可（Electron 跨平台；原生模块 `pnpm install` 自动按本机重编）。
  - 开机自启：Win / macOS 的 dev 形态都已支持（分别写注册表 Run / `~/Library/LaunchAgents` plist，指向「系统 node 跑 `scripts/dev.mjs`」）。
  - macOS 若用未签名打包 app，首次需在「系统设置 → 隐私与安全性」放行；dev 形态 `pnpm dev:launcher` 无此问题。

> **推 GitHub 安全**：密钥在 keytar，`.env` 与 `data/*.db` 已被 `.gitignore` 忽略，仓库不含任何密钥 / token。

## 目录

```
discord-agent-hub/
├── apps/
│   └── orchestrator/       # Node.js 后端
│       └── src/
│           ├── index.ts    # 入口
│           ├── bot.ts      # discord.js + LLM
│           └── config.ts   # env 加载
└── (后续 phase) apps/dashboard, packages/shared, data/, ...
```

## Phase 进度

- [x] Phase -1：版本检查、目录建立、ANTHROPIC_API_KEY 确认未设
- [ ] Phase 0：单 DeepSeek bot 对话 MVP（当前）
- [ ] Phase 1：fs / bash / memory 工具
- [ ] Phase 1.5：Web Search (Tavily)
- [ ] Phase 2：delegate_to_claude + 完整中转交互
- [ ] Phase 3：多 bot + Inter-Agent + SQLite + keytar
- [ ] Phase 3.5：Skill 系统 + 调度器
- [ ] Phase 4：Dashboard (Next.js)
- [ ] Phase 4.5：RAG（可选）
- [ ] Phase 5：完善 + 上线
