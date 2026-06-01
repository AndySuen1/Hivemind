// 启动器本地控制 HTTP API：仅绑 127.0.0.1 + 本地 token，供管理网站“系统设置”页读写端口/自启、启停服务。
// 直连启动器（不经 orchestrator 中转）：改端口/重启期 orchestrator 恰好不可达，且重启子进程+设登录项天然属于父进程。
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { LauncherController, PublicSettings } from './types';

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // 只回显回环来源；非回环不放行（杜绝外部站点借浏览器调用 OS 级能力）。
  if (isLoopbackOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin as string);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Launcher-Token');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 校验并规整 PublicSettings 的部分字段（端口范围 / 布尔）。 */
function sanitizeSettings(input: unknown): Partial<PublicSettings> {
  const o = (input ?? {}) as Record<string, unknown>;
  const out: Partial<PublicSettings> = {};
  const port = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
  };
  if (o.apiPort !== undefined) {
    const p = port(o.apiPort);
    if (p === undefined) throw new Error('apiPort 不合法（1–65535）');
    out.apiPort = p;
  }
  if (o.dashboardPort !== undefined) {
    const p = port(o.dashboardPort);
    if (p === undefined) throw new Error('dashboardPort 不合法（1–65535）');
    out.dashboardPort = p;
  }
  if (o.autoStartService !== undefined) out.autoStartService = Boolean(o.autoStartService);
  if (o.openLoginItem !== undefined) out.openLoginItem = Boolean(o.openLoginItem);
  if (out.apiPort !== undefined && out.dashboardPort !== undefined && out.apiPort === out.dashboardPort) {
    throw new Error('两个端口不能相同');
  }
  return out;
}

export function startControlServer(controller: LauncherController, token: string, port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // token 校验（GET/PUT/POST 全部要求）
    const provided = req.headers['x-launcher-token'];
    if (provided !== token) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    const url = req.url ?? '';
    const path = url.split('?')[0];

    void (async () => {
      try {
        if (req.method === 'GET' && path === '/launcher/settings') {
          sendJson(res, 200, { ok: true, data: { settings: controller.getSettings(), status: controller.getStatus() } });
          return;
        }
        if (req.method === 'PUT' && path === '/launcher/settings') {
          const patch = sanitizeSettings(await readBody(req));
          const status = await controller.applySettings(patch);
          sendJson(res, 200, { ok: true, data: { settings: controller.getSettings(), status } });
          return;
        }
        if (req.method === 'GET' && path === '/launcher/service/status') {
          sendJson(res, 200, { ok: true, data: controller.getStatus() });
          return;
        }
        if (req.method === 'POST' && path === '/launcher/service/start') {
          await controller.startServices();
          sendJson(res, 200, { ok: true, data: controller.getStatus() });
          return;
        }
        if (req.method === 'POST' && path === '/launcher/service/stop') {
          await controller.stopServices();
          sendJson(res, 200, { ok: true, data: controller.getStatus() });
          return;
        }
        if (req.method === 'POST' && path === '/launcher/service/restart') {
          await controller.restartServices();
          sendJson(res, 200, { ok: true, data: controller.getStatus() });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: (e as Error).message });
      }
    })();
  });

  server.on('error', (e) => console.error('[control] 控制 API 出错：', e));
  server.listen(port, host, () => console.log(`[control] 控制 API 监听 http://${host}:${port}`));
  return server;
}
