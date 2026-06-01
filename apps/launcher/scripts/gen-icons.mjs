// 生成托盘图标（无外部依赖：手写 PNG 编码 + zlib 压缩 + 自实现 CRC32）。
// 产物：
//   assets/tray.png            32x32 彩色（Windows/Linux 托盘）
//   assets/trayTemplate.png    16x16 mac template（纯黑+透明，菜单栏自动反色）
//   assets/trayTemplate@2x.png 32x32 mac template（Retina）
// 设计：圆角方底 + 白色机器人头 + 两只眼睛，monochrome 版为带眼孔的圆。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// ---- PNG 编码 ----
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 形状 ----
function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r || (px >= x0 + r && px <= x1 - r) || (py >= y0 + r && py <= y1 - r);
  }
  return false;
}
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function render(size, mode) {
  const ss = 4; // supersample for anti-alias
  const W = size;
  const H = size;
  const out = Buffer.alloc(W * H * 4);
  const cx = W / 2;
  const headCy = H * 0.52;
  const headR = size * 0.30;
  const eyeR = Math.max(size * 0.05, 0.8);
  const eyeOff = size * 0.12;
  const m = size * 0.06;
  const bgR = size * 0.24;

  const sample = (px, py) => {
    if (mode === 'template') {
      // 头部圆为黑色实心，眼睛为透明孔
      const head = inCircle(px, py, cx, headCy, headR);
      if (!head) return [0, 0, 0, 0];
      const eye =
        inCircle(px, py, cx - eyeOff, headCy - size * 0.02, eyeR * 1.3) ||
        inCircle(px, py, cx + eyeOff, headCy - size * 0.02, eyeR * 1.3);
      if (eye) return [0, 0, 0, 0];
      return [0, 0, 0, 255];
    }
    // color
    let col = [0, 0, 0, 0];
    if (insideRoundRect(px, py, m, m, W - m, H - m, bgR)) col = [79, 70, 229, 255]; // #4f46e5
    if (inCircle(px, py, cx, headCy, headR)) col = [255, 255, 255, 255];
    if (
      inCircle(px, py, cx - eyeOff, headCy - size * 0.02, eyeR) ||
      inCircle(px, py, cx + eyeOff, headCy - size * 0.02, eyeR)
    )
      col = [67, 56, 202, 255]; // #4338ca
    return col;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }
      const n = ss * ss;
      const i = (y * W + x) * 4;
      // 预乘外的直观处理：颜色取覆盖到的平均色，alpha 取覆盖率
      const alpha = a / n;
      out[i] = alpha > 0 ? Math.round(r / n) : 0;
      out[i + 1] = alpha > 0 ? Math.round(g / n) : 0;
      out[i + 2] = alpha > 0 ? Math.round(b / n) : 0;
      out[i + 3] = Math.round(alpha);
    }
  }
  return encodePNG(W, H, out);
}

mkdirSync(ASSETS, { recursive: true });
writeFileSync(join(ASSETS, 'tray.png'), render(32, 'color'));
writeFileSync(join(ASSETS, 'trayTemplate.png'), render(16, 'template'));
writeFileSync(join(ASSETS, 'trayTemplate@2x.png'), render(32, 'template'));
writeFileSync(join(ASSETS, 'icon.png'), render(256, 'color'));
console.log('图标已生成到', ASSETS);
