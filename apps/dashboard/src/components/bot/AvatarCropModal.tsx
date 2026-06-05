'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Check, FlipHorizontal2, ImagePlus, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useCallbackRef } from '@/components/ui/use-callback-ref';
import { cn } from '@/lib/utils';

const OUT = 256; // 导出方形边长（px）：256 webp 仍仅约 10–25KB
const VIEW = 360; // 预览视口 CSS 边长（px）
const MAX_OVER_COVER = 4; // 允许 cover 之上最多 4× 放大
const DPR_CAP = 3; // backing store DPR 上限，避免高分屏过度开销

/** 透明区棋盘格背景（画在 canvas 之下；canvas 自身透明，露出棋盘 = 输出透明区）。 */
const CHECKER: React.CSSProperties = {
  backgroundColor: '#fff',
  backgroundImage:
    'linear-gradient(45deg,#dcdce0 25%,transparent 25%),linear-gradient(-45deg,#dcdce0 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#dcdce0 75%),linear-gradient(-45deg,transparent 75%,#dcdce0 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
};

/** 裁剪变换状态：全部归一化到「单位方形」（边长记为 1），绘制时只在 drawTransformed 里乘一次 S。 */
interface CropState {
  /** 每个图片原生像素占输出方形边长的比例 ÷ S（见 drawTransformed 的 k=scale*S）。 */
  scale: number;
  /** 平移：按方形边长的分数（屏幕空间，旋转之前应用）。 */
  offX: number;
  offY: number;
  rot: 0 | 90 | 180 | 270;
  flip: boolean;
}

interface Bounds {
  fitScale: number; // contain：整图可见
  coverScale: number; // cover：铺满方框
  minScale: number;
  maxScale: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 由图片原生尺寸 + 当前旋转算缩放边界（90/270 交换长宽）。 */
function getBounds(img: HTMLImageElement, rot: number): Bounds {
  const swap = rot === 90 || rot === 270;
  const natW = swap ? img.naturalHeight : img.naturalWidth;
  const natH = swap ? img.naturalWidth : img.naturalHeight;
  const fitScale = 1 / Math.max(natW, natH);
  const coverScale = 1 / Math.min(natW, natH);
  return { fitScale, coverScale, minScale: fitScale, maxScale: coverScale * MAX_OVER_COVER };
}

// 几何（对数）滑块：等长滑动 = 等比缩放，极端长宽比也不偏。
const scaleFromSlider = (t: number, b: Bounds) => b.minScale * Math.pow(b.maxScale / b.minScale, t);
const sliderFromScale = (s: number, b: Bounds) =>
  clamp(Math.log(s / b.minScale) / Math.log(b.maxScale / b.minScale), 0, 1);

/**
 * 唯一真相源：预览与导出共用此函数，仅传入的 S 不同（预览=canvas.width 含 dpr；导出=OUT）。
 * dest(p)=S·[ R·F·(scale·(p-图心)) + (1/2+off) ]，方括号内与 S 无关 → 所见即所得。
 */
function drawTransformed(ctx: CanvasRenderingContext2D, S: number, img: HTMLImageElement, st: CropState): void {
  ctx.clearRect(0, 0, S, S); // 透明底，保住 alpha（绝不填白）
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(S / 2, S / 2); // 1. 原点移到方形中心
  ctx.translate(st.offX * S, st.offY * S); // 2. 平移（屏幕空间，旋转之前 → 拖动方向不随旋转翻）
  ctx.rotate((st.rot * Math.PI) / 180); // 3. 绕中心旋转
  if (st.flip) ctx.scale(-1, 1); // 4. 水平翻转（务必在 rotate 之后）
  const k = st.scale * S; // 5. 归一化 scale → 设备像素
  ctx.scale(k, k);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2, img.naturalWidth, img.naturalHeight); // 6. 以图心为中心画
  ctx.restore();
}

export interface AvatarCropModalProps {
  open: boolean;
  /** 已解码的源图片（解码 + 解码失败处理由 AvatarPicker 负责，这里只裁剪）。 */
  image: HTMLImageElement | null;
  /** 导出 OUT×OUT 方形 data URL 回调（webp 优先，回退 png）。 */
  onApply: (dataUrl: string) => void;
  /** 放弃，不改头像。 */
  onCancel: () => void;
  /** 重新选图：复用 AvatarPicker 的隐藏 file input。 */
  onRepick?: () => void;
  title?: string;
}

/**
 * Bot 头像裁剪弹窗：方形裁剪框内 拖动平移 / 缩放（滑块+滚轮）/ 旋转 90° / 水平翻转，
 * 不铺满时露出透明棋盘格。复用 Modal 原语；嵌套在 NewBotModal 内时用 window 捕获相拦 Esc。
 */
export function AvatarCropModal({ open, image, onApply, onCancel, onRepick, title = '添加图片' }: AvatarCropModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stateRef = useRef<CropState>({ scale: 1, offX: 0, offY: 0, rot: 0, flip: false });
  const pending = useRef(false);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const [, bump] = useReducer((x: number) => x + 1, 0); // 仅在控件相关变化时强制重渲（平移不触发）

  // canvas 回调 ref → state，确保「图片就绪 + canvas 已挂载」后才初始化（Modal 延迟挂载 portal）。
  const setCanvasNode = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    setCanvasEl(node);
  }, []);

  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    const img = imgRef.current;
    if (!cv || !img) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    drawTransformed(ctx, cv.width, img, stateRef.current);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    requestAnimationFrame(() => {
      pending.current = false;
      redraw();
    });
  }, [redraw]);

  // 初始化：图片或 canvas 变化时，重置变换为 cover、按 DPR 设 backing store、首帧绘制。
  useEffect(() => {
    if (!image || !canvasEl) return;
    imgRef.current = image;
    const b = getBounds(image, 0);
    stateRef.current = { scale: b.coverScale, offX: 0, offY: 0, rot: 0, flip: false };
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvasEl.width = Math.round(VIEW * dpr); // backing store = 设备像素（drawTransformed 传 S=canvas.width，不再 ctx.scale(dpr)）
    canvasEl.height = Math.round(VIEW * dpr);
    bump();
    redraw();
  }, [image, canvasEl, redraw]);

  // 滚轮缩放：非 passive 才能 preventDefault（拦页面/面板滚动）。
  useEffect(() => {
    const cv = canvasEl;
    const img = image;
    if (!cv || !img) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = getBounds(img, stateRef.current.rot);
      const next = clamp(stateRef.current.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), b.minScale, b.maxScale);
      stateRef.current = { ...stateRef.current, scale: next };
      bump();
      scheduleDraw();
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [canvasEl, image, scheduleDraw]);

  // 嵌套弹窗 Esc：window 捕获相严格早于 document → stopPropagation 拦住父 FormModal 的 document 监听，只关裁剪窗。
  const cancelStable = useCallbackRef(onCancel);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      cancelStable();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, cancelStable]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!imgRef.current) return;
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    // delta 是 CSS px，除以 CSS 边长 VIEW 归一化（与 DPR 无关）；不 clamp（允许透明）。
    stateRef.current = {
      ...stateRef.current,
      offX: stateRef.current.offX + dx / VIEW,
      offY: stateRef.current.offY + dy / VIEW,
    };
    scheduleDraw(); // 平移不改任何控件 → 不 bump，免去逐 move 的 React 重渲
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
  };

  const onSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const b = getBounds(img, stateRef.current.rot);
    stateRef.current = { ...stateRef.current, scale: scaleFromSlider(Number(e.target.value), b) };
    bump();
    scheduleDraw();
  };

  const onRotate = () => {
    const img = imgRef.current;
    if (!img) return;
    const rot = ((stateRef.current.rot + 90) % 360) as CropState['rot'];
    const b = getBounds(img, rot); // 旋转改变长宽轴 → 重算边界并按新 contain 下限 clamp
    stateRef.current = { ...stateRef.current, rot, scale: Math.max(stateRef.current.scale, b.minScale) };
    bump();
    scheduleDraw();
  };

  const onFlip = () => {
    if (!imgRef.current) return;
    stateRef.current = { ...stateRef.current, flip: !stateRef.current.flip };
    bump();
    scheduleDraw();
  };

  const onReset = () => {
    const img = imgRef.current;
    if (!img) return;
    const b = getBounds(img, 0);
    stateRef.current = { scale: b.coverScale, offX: 0, offY: 0, rot: 0, flip: false };
    bump();
    scheduleDraw();
  };

  const onApplyClick = () => {
    const img = imgRef.current;
    if (!img) return;
    const cv = document.createElement('canvas');
    cv.width = OUT;
    cv.height = OUT;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    drawTransformed(ctx, OUT, img, stateRef.current);
    const webp = cv.toDataURL('image/webp', 0.9);
    onApply(webp.startsWith('data:image/webp') ? webp : cv.toDataURL('image/png'));
  };

  // 控件展示用的派生值（render 时读 stateRef，bump 后即时刷新）。
  const bounds = image ? getBounds(image, stateRef.current.rot) : null;
  const sliderT = bounds ? sliderFromScale(stateRef.current.scale, bounds) : 0.5;
  const flipped = stateRef.current.flip;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="lg"
      closeOnEsc={false}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RotateCcw className="size-3.5" />}
            className="mr-auto"
            onClick={onReset}
          >
            重置
          </Button>
          <Button ref={cancelRef} variant="secondary" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" size="sm" leftIcon={<Check className="size-3.5" />} onClick={onApplyClick}>
            应用
          </Button>
        </>
      }
    >
      {/* 顶部 header：左「选择文件」/ 中标题 / 右 X（负边距抵消 Modal body padding，让分割线齐顶通栏） */}
      <div className="relative -mx-5 -mt-4 mb-4 border-b border-border px-5 py-3">
        {onRepick && (
          <button
            type="button"
            onClick={onRepick}
            className="absolute left-4 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg"
          >
            <ImagePlus className="size-3.5" /> 选择文件
          </button>
        )}
        <h2 className="text-center text-base font-semibold text-fg">{title}</h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="关闭"
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-md p-1 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* 图片舞台：棋盘格底 + 透明 canvas 预览 + 裁剪框描边 + 悬浮工具栏 */}
      <div className="flex justify-center">
        <div className="relative" style={{ width: VIEW, height: VIEW }}>
          <div className="absolute inset-0 rounded-lg" style={CHECKER} aria-hidden />
          <canvas
            ref={setCanvasNode}
            style={{ width: VIEW, height: VIEW }}
            className="relative cursor-grab touch-none rounded-lg active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          <div className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-inset ring-black/10" aria-hidden />
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <div className="flex items-center gap-2 rounded-full border border-border bg-bg-card/95 px-3 py-1.5 shadow-popover backdrop-blur">
              <button
                type="button"
                onClick={onRotate}
                aria-label="旋转 90°"
                className="rounded-md p-1 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
              >
                <RotateCw className="size-4" />
              </button>
              <button
                type="button"
                onClick={onFlip}
                aria-label="水平翻转"
                aria-pressed={flipped}
                className={cn(
                  'rounded-md p-1 transition-colors hover:bg-bg-hover',
                  flipped ? 'text-primary' : 'text-fg-muted hover:text-fg',
                )}
              >
                <FlipHorizontal2 className="size-4" />
              </button>
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              <ZoomOut className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={sliderT}
                onChange={onSlider}
                aria-label="缩放"
                className="w-36 accent-primary-strong"
              />
              <ZoomIn className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            </div>
          </div>
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-fg-subtle">拖动调整位置 · 滚轮或滑块缩放 · 可旋转/翻转</p>
    </Modal>
  );
}
