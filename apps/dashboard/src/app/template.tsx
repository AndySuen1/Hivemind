// App Router 约定：template.tsx 每次导航都重新挂载，适合做整页进场。
// 纯 CSS 淡入（克制，不需 framer），reduced-motion 下自动趋零。
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-in">{children}</div>;
}
