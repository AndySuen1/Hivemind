// 跨平台启动包装：在拉起 Electron 前清掉 ELECTRON_RUN_AS_NODE。
// 某些环境（如本机被 Claude Code / Agent SDK 注入）会全局设 ELECTRON_RUN_AS_NODE=1，
// 这会让 electron 以纯 Node 模式运行，导致 require('electron').app === undefined 直接崩。
// 这里用 node 解析 electron 可执行文件路径，再以干净 env spawn，确保 GUI 模式启动。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // electron npm 包在 node 下 require 返回 exe 路径字符串

// 用绝对路径指向 app 根（apps/launcher），不依赖 cwd —— 这样从仓库根、从开机自启(cwd 未知)调用都成立。
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [appRoot], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
