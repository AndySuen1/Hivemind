'use client';

import { useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { BotAvatar } from './BotAvatar';
import { AvatarCropModal } from './AvatarCropModal';

/** 读文件成 data URL 再解码成 <img>（顺带校验可解码 + 非零尺寸）；失败抛中文错误。 */
async function fileToImage(file: File): Promise<HTMLImageElement> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () =>
      im.naturalWidth && im.naturalHeight ? resolve(im) : reject(new Error('图片解码失败'));
    im.onerror = () => reject(new Error('图片解码失败'));
    im.src = dataUrl;
  });
}

/**
 * 头像上传/裁剪控件：点击或拖入图片 → 弹出裁剪框（拖动/缩放/旋转/翻转）→ 应用后输出方形 data URL 回调 onChange；
 * 空值显示名字 initials。裁剪逻辑见 AvatarCropModal；解码失败走内联 err、不开弹窗。
 */
export function AvatarPicker({
  value,
  onChange,
  name,
  id,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  name: string;
  id?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cropImg, setCropImg] = useState<HTMLImageElement | null>(null);

  const pick = async (file?: File | null) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      setCropImg(await fileToImage(file)); // 成功才开裁剪弹窗
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void pick(e.dataTransfer.files?.[0]);
        }}
        className="group relative rounded-2xl ring-2 ring-border transition-colors hover:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        title="点击或拖入图片设为头像"
        disabled={busy}
      >
        <BotAvatar name={name || '?'} avatar={value} id={id} size={72} rounded="2xl" />
        <span className="absolute inset-0 grid place-items-center rounded-2xl text-white opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100">
          <ImagePlus className="size-5" />
        </span>
      </button>
      <div className="space-y-1 text-xs">
        <div className="text-fg-muted">{busy ? '处理中…' : '点击 / 拖入图片，自动裁成 128px 方形'}</div>
        {value && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-fg-subtle hover:text-danger-fg"
            onClick={() => onChange('')}
          >
            <X className="size-3.5" /> 移除头像
          </button>
        )}
        {err && <div className="text-danger-fg">{err}</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <AvatarCropModal
        open={cropImg != null}
        image={cropImg}
        onApply={(dataUrl) => {
          onChange(dataUrl);
          setCropImg(null);
        }}
        onCancel={() => setCropImg(null)}
        onRepick={() => inputRef.current?.click()}
      />
    </div>
  );
}
