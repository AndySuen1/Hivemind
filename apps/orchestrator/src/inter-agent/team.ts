// 项目「团队」相关的纯逻辑（无 DB / 无 discord.js，便于单测）：
//  · mergeWorkspaceDirs：项目级工作目录 ∪ bot 自己的工作目录（成员实际可见范围）。
//  · formatTeamRoster：把「本 bot 岗位 + 同项目成员及其岗位」渲染成注入 system prompt 的团队花名册，
//    让每个员工自动知道同项目其它员工的存在与分工，免去在 systemPrompt 里手写「成员包括…」。

/** 同伴的最小信息（用于花名册）。 */
export interface RosterMember {
  name: string;
  role: string; // 岗位，可能为空
}

/**
 * 合并工作目录白名单：项目级在前、bot 自己的在后，去空白 + 去重（保序）。
 * 成员实际可访问的目录范围 = 项目共享这份 ∪ bot 自己配置的这份。
 */
export function mergeWorkspaceDirs(projectDirs: readonly string[], botDirs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of [...projectDirs, ...botDirs]) {
    const t = (d ?? '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 一个成员的花名册行：`- 名字 —— 岗位`（无岗位则只列名字），自己追加「（你）」。 */
function rosterLine(m: RosterMember, isSelf: boolean): string {
  const role = m.role.trim();
  return `- ${m.name}${role ? ` —— ${role}` : ''}${isSelf ? '（你）' : ''}`;
}

/**
 * 渲染团队花名册，注入到 system prompt。
 * @param projectName 项目名
 * @param self 本 bot（名字 + 岗位）
 * @param others 同项目其它在编启用成员（名字 + 岗位）
 * 返回一段中文说明：本 bot 岗位 + 成员清单。others 为空时说明暂无其它成员。
 */
export function formatTeamRoster(projectName: string, self: RosterMember, others: readonly RosterMember[]): string {
  const selfRole = self.role.trim();
  const head = selfRole
    ? `## 团队与分工（项目「${projectName}」）\n你在本项目的岗位是「${selfRole}」（代号 ${self.name}）。`
    : `## 团队与分工（项目「${projectName}」）\n你是本项目成员（代号 ${self.name}）。`;
  if (others.length === 0) {
    return `${head}\n目前项目里暂无其它在编成员。`;
  }
  const lines = [rosterLine(self, true), ...others.map((m) => rosterLine(m, false))];
  return (
    `${head}\n同项目成员及分工（你们在同一频道协作，可按各自岗位分工配合）：\n${lines.join('\n')}`
  );
}
