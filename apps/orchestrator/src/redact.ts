// 脱敏：把可能出现在工具入参/出参/Bash 命令/聊天文本里的密钥类内容替换为占位符，
// 尽量别把明文密钥落库或经 SSE 外泄。
//
// ⚠️ 这是**弱护栏**——启发式正则，必然有漏网（变量拼接、base64、自定义格式都能绕）。
// 真正的边界是：密钥存 keytar 不入库（见 secrets.ts）+ allowedRequesters 访问控制。
// 与 permission-relay 的危险命令匹配同属「尽量挡，挡不住别假装安全」的定位。

export const REDACTED = '‹redacted›';

// 1) 独立的密钥 token：整段替换为占位符。
const TOKEN_RULES: RegExp[] = [
  // PEM 私钥块
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // JWT：eyJ 开头的三段 base64url（裸 token，未必带 Authorization 头）。
  // 三段各 ≥8 字符把误报压到近零（eyJ 前缀 = base64 of `{"`）。
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // OpenAI / Anthropic：sk-..., sk-ant-...
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  // GitHub：ghp_/gho_/ghu_/ghs_/ghr_ + pat 前缀 github_pat_
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS Access Key Id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack：xoxb-/xoxp-/xoxa-/xoxr-/xoxs-
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  // Discord bot/user token：3 段（id.base64时间戳.hmac），含新版长尾
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g,
  // Discord 新版 MFA token
  /\bmfa\.[A-Za-z0-9_-]{20,}\b/gi,
];

// 2) Authorization 头：保留 scheme，替换其后凭证。
const AUTH_RE = /\b(authorization\s*[:=]\s*)(bearer|basic|token|digest)\s+[A-Za-z0-9._\-+/=~]+/gi;

// 3) key=value / "key": "value" 形态：保留键名，替换敏感键的值。
//    捕获组：1=键名 2=分隔（含可选引号） 3=值。值至少 4 字符才替换，避免误伤空/占位。
const KV_RE =
  /\b(api[_-]?key|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|passphrase|private[_-]?key)\b(\s*[:=]\s*"?|"\s*:\s*")([^\s"',}\)]{4,})/gi;

/** 对单段文本做脱敏。幂等（占位符不含会被二次命中的子串）。 */
export function redactText(input: string): string {
  if (!input) return input;
  let s = input;
  for (const re of TOKEN_RULES) s = s.replace(re, REDACTED);
  s = s.replace(AUTH_RE, (_m, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED}`);
  s = s.replace(KV_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  return s;
}
