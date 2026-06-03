// pJ = Skill 加载器冒烟（Phase 3.5）：listSkills / frontmatter 解析 / 路径穿越防护 / composeSkillsPrompt 跳过缺失。
// 在临时目录造 skill fixtures + 设 SKILL_ROOT env 后再动态 import skills.ts（SKILL_ROOT 在模块加载时读 env）。
// 重跑：apps/orchestrator/node_modules/.bin/tsx apps/orchestrator/pJ-smoke.ts
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'd:/tmp/pJ-skills';
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'good-skill'), { recursive: true });
writeFileSync(
  join(ROOT, 'good-skill', 'SKILL.md'),
  `---\nname: good-skill\ndescription: 一个好技能 --- 带破折号\n---\n\n# Good\n正文内容\n`,
);
mkdirSync(join(ROOT, 'no-frontmatter'), { recursive: true });
writeFileSync(join(ROOT, 'no-frontmatter', 'SKILL.md'), `# 无 frontmatter\n只有正文`);
mkdirSync(join(ROOT, 'empty-dir'), { recursive: true }); // 无 SKILL.md → 应跳过
mkdirSync(join(ROOT, 'BadName'), { recursive: true }); // 非法目录名（大写）→ 应跳过
writeFileSync(join(ROOT, 'BadName', 'SKILL.md'), `---\nname: x\ndescription: y\n---\n`);

process.env.SKILL_ROOT = ROOT;
const skills = await import('./src/skills.ts');

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

console.log('— listSkills：只列合法且含 SKILL.md 的目录 —');
const list = skills.listSkills();
const names = list.map((s) => s.name);
check('含 good-skill', names.includes('good-skill'));
check('含 no-frontmatter', names.includes('no-frontmatter'));
check('跳过无 SKILL.md 的 empty-dir', !names.includes('empty-dir'));
check('跳过非法目录名 BadName', !names.includes('BadName'));
check('数量为 2', list.length === 2, names);
check('按名排序', JSON.stringify(names) === JSON.stringify(['good-skill', 'no-frontmatter']));

console.log('— frontmatter 解析 + description 单行/去 --- 卫生 —');
const good = list.find((s) => s.name === 'good-skill')!;
check('description 取自 frontmatter', good.description.includes('一个好技能'));
check('description 去掉了 ---（防截断注入）', !good.description.includes('---'));
const fm = skills.parseSkillFrontmatter('---\nname: a\ndescription: hi\n---\nbody');
check('parseSkillFrontmatter 取 name', fm.name === 'a');
check('parseSkillFrontmatter 取 description', fm.description === 'hi');
check('无 frontmatter → 空 description', skills.parseSkillFrontmatter('no fm here').description === '');

console.log('— loadSkillMarkdown / 路径穿越防护 —');
check('读到 good-skill 原文', (skills.loadSkillMarkdown('good-skill') ?? '').includes('# Good'));
check('不存在 → null', skills.loadSkillMarkdown('nope') === null);
check('路径穿越 ../escape → null', skills.loadSkillMarkdown('../escape') === null);
check('路径穿越 ..\\.. → null', skills.loadSkillMarkdown('..\\..') === null);
check('getSkillDetail 不存在 → null', skills.getSkillDetail('nope') === null);
check('getSkillDetail good-skill 带 content', (skills.getSkillDetail('good-skill')?.content ?? '').includes('# Good'));

console.log('— composeSkillsPrompt：拼接 + 跳过缺失/非法 —');
const prompt = skills.composeSkillsPrompt(['good-skill', 'nonexistent']);
check('含分段标题', prompt.includes('## 已加载的技能'));
check('含 good-skill 内容', prompt.includes('# Good') && prompt.includes('good-skill'));
check('跳过缺失项（不抛、不含 nonexistent 报错）', !prompt.includes('nonexistent'));
check('空数组 → 空串', skills.composeSkillsPrompt([]) === '');
check('全缺失/非法 → 空串', skills.composeSkillsPrompt(['BadName', 'nope']) === '');

console.log('— getEnabledSkillDirs：只返回实际存在的 skill 目录 —');
const dirs = skills.getEnabledSkillDirs(['good-skill', 'nonexistent', '../escape']);
check('只含 good-skill 目录', dirs.length === 1 && dirs[0].replace(/\\/g, '/').endsWith('good-skill'), dirs);

console.log(`\npJ Skill 加载器冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
