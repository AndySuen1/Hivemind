// 允许的前端（dashboard）来源：由 launcher spawn 时注入的 env 派生，避免改端口后被 CORS 拦。
// CORS（api.ts）与 SSE hijack 后手动补头（api-stream.ts）共用此函数，杜绝两处硬编码漂移。
//
// 取值优先级（取并集）：
//   - DASHBOARD_PORT  → 同时放行 http://localhost:<port> 与 http://127.0.0.1:<port>
//   - DASHBOARD_ORIGIN→ 逗号分隔的显式来源列表
//   - 都没有          → 回退默认 3000 两种变体（保持原行为，手动 pnpm dev 不受影响）
export function allowedOrigins(): string[] {
  const set = new Set<string>();

  const port = process.env.DASHBOARD_PORT;
  if (port) {
    set.add(`http://localhost:${port}`);
    set.add(`http://127.0.0.1:${port}`);
  }

  const explicit = process.env.DASHBOARD_ORIGIN;
  if (explicit) {
    for (const o of explicit.split(',').map((s) => s.trim()).filter(Boolean)) set.add(o);
  }

  if (set.size === 0) {
    set.add('http://localhost:3000');
    set.add('http://127.0.0.1:3000');
  }

  return [...set];
}
