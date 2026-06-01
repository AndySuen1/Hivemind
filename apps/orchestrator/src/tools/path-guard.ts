import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';

/** 规范化用于比较：解析为绝对路径，Windows 下统一小写（大小写不敏感文件系统） */
function normForCompare(p: string): string {
  const abs = resolve(p);
  return IS_WIN ? abs.toLowerCase() : abs;
}

/**
 * 判断 absTarget 是否落在 base 目录内（含 base 本身）。
 * 用 path.relative 而非字符串前缀，避免 `D:\app` 误放行 `D:\appEvil`。
 */
function isInside(baseNorm: string, targetNorm: string): boolean {
  if (targetNorm === baseNorm) return true;
  const rel = relative(baseNorm, targetNorm);
  // rel 为空 = 同目录；以 '..' 开头或为绝对路径 = 在 base 之外
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 校验 target 是否在 allowed 白名单内的任一目录下；通过则返回解析后的绝对路径（保留原始大小写），
 * 否则抛错。allowed 为空 = 一律拒绝（fail-closed）。
 *
 * 防御范围：`..` 跳出、白名单近邻目录前缀混淆、相对路径。
 * 残余风险：符号链接逃逸——对已存在的目标做 realpath 二次校验（见 assertRealpathAllowed）。
 */
export function assertPathAllowed(target: string, allowed: string[]): string {
  if (!allowed || allowed.length === 0) {
    throw new Error('该工具未配置 allowedPaths 白名单，所有文件操作被拒绝');
  }
  const absReal = resolve(target);
  const targetNorm = normForCompare(target);
  for (const base of allowed) {
    if (!base || !base.trim()) continue;
    if (isInside(normForCompare(base), targetNorm)) return absReal;
  }
  throw new Error(`路径越权：${absReal} 不在允许的白名单目录内`);
}

/**
 * 在 assertPathAllowed 基础上，对“已存在的路径”做 realpath 解析后二次校验，
 * 防止白名单内的符号链接指向白名单外。目标不存在时（如即将写入的新文件）跳过 realpath，
 * 仅靠词法校验——这是可接受的，因为新文件会落在已校验的父目录下。
 */
export function assertRealpathAllowed(target: string, allowed: string[]): string {
  const abs = assertPathAllowed(target, allowed);
  // 关键：realpathSync 的 ENOENT 必须单独捕获，绝不能把下面 assertPathAllowed 的
  // “路径越权”异常也吞掉——否则 symlink 逃逸校验形同虚设（曾踩此坑）。
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return abs; // 目标不存在 → 词法校验已足够（新文件落在已校验父目录下）
  }
  // 仅当 realpath 与原路径不同（即存在 symlink/junction）时才重校验
  if (normForCompare(real) !== normForCompare(abs)) {
    return assertPathAllowed(real, allowed); // 在白名单外则抛出“路径越权”
  }
  return abs;
}

/**
 * 给“即将写入的新文件”用：目标本身可能尚不存在，但其最近的已存在祖先目录若是
 * 白名单内的 junction/symlink 指向白名单外，写入仍会逃逸。这里解析最近已存在祖先的
 * realpath 并校验其仍在白名单内（realpath 会一并解析该祖先路径上所有 junction）。
 */
export function assertWriteTargetAllowed(target: string, allowed: string[]): string {
  const abs = assertPathAllowed(target, allowed); // 先做词法校验
  let dir = dirname(abs);
  let prev = '';
  while (dir !== prev) {
    if (existsSync(dir)) {
      const realDir = realpathSync(dir);
      if (normForCompare(realDir) !== normForCompare(dir)) {
        assertPathAllowed(realDir, allowed); // 祖先是 symlink/junction → 校验真实路径，越权则抛错
      }
      break;
    }
    prev = dir;
    dir = dirname(dir);
  }
  return abs;
}
