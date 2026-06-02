// 列表内容相等短路：长度或任一项的「关键字段」变化才算不等。
// pick 决定参与比较的字段——务必排除 lastActiveAt 这类每刷必变字段，否则永远短路不命中。
export function listEq<T>(a: T[], b: T[], pick: (x: T) => unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = pick(a[i]!);
    const pb = pick(b[i]!);
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) if (pa[j] !== pb[j]) return false;
  }
  return true;
}
