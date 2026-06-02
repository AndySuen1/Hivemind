import type { Config } from 'tailwindcss';

// Notion 风设计 token：颜色全部走 CSS 变量（HSL 通道），亮色在 :root、暗色在 .dark（见 globals.css）。
// 组件只引用语义类名（bg-card / text-fg-muted / bg-primary 等），不再出现 zinc-*/blue-600。
export default {
  darkMode: 'class', // 预留暗色：仅切 .dark 类，组件零改
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1200px' }, // 内容区不过宽
    },
    extend: {
      colors: {
        // —— 表面 / 背景 ——
        bg: {
          DEFAULT: 'hsl(var(--bg) / <alpha-value>)',
          subtle: 'hsl(var(--bg-subtle) / <alpha-value>)',
          card: 'hsl(var(--bg-card) / <alpha-value>)',
          hover: 'hsl(var(--bg-hover) / <alpha-value>)',
        },
        // —— 文字 ——
        fg: {
          DEFAULT: 'hsl(var(--fg) / <alpha-value>)',
          muted: 'hsl(var(--fg-muted) / <alpha-value>)',
          subtle: 'hsl(var(--fg-subtle) / <alpha-value>)', // 仅禁用态/装饰，非正文级对比
          inverse: 'hsl(var(--fg-inverse) / <alpha-value>)',
        },
        // —— 边框 / 分割 ——
        border: {
          DEFAULT: 'hsl(var(--border) / <alpha-value>)',
          strong: 'hsl(var(--border-strong) / <alpha-value>)',
        },
        ring: 'hsl(var(--ring) / <alpha-value>)',
        // —— 主强调（柔和蓝）——
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)', // 仅装饰/描边/hover/大标题
          strong: 'hsl(var(--primary-strong) / <alpha-value>)', // 蓝底白字/蓝色正文专用，达 AA
          hover: 'hsl(var(--primary-hover) / <alpha-value>)',
          fg: 'hsl(var(--primary-fg) / <alpha-value>)',
          soft: 'hsl(var(--primary-soft) / <alpha-value>)',
        },
        // —— 语义状态（主色 + fg 深色文字 + soft 浅底，配套用）——
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          fg: 'hsl(var(--success-fg) / <alpha-value>)',
          soft: 'hsl(var(--success-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          fg: 'hsl(var(--warning-fg) / <alpha-value>)',
          soft: 'hsl(var(--warning-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
          fg: 'hsl(var(--danger-fg) / <alpha-value>)',
          soft: 'hsl(var(--danger-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          fg: 'hsl(var(--info-fg) / <alpha-value>)',
          soft: 'hsl(var(--info-soft) / <alpha-value>)',
        },
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px', // Notion 标准
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(15,15,15,0.04)',
        sm: '0 2px 4px rgba(15,15,15,0.06)',
        md: '0 4px 8px rgba(15,15,15,0.08)',
        lg: '0 8px 16px rgba(15,15,15,0.10)',
        popover: '0 12px 24px rgba(15,15,15,0.12)',
        none: 'none',
      },
      fontFamily: {
        sans: [
          'Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"',
          'Roboto', '"Helvetica Neue"', '"Microsoft YaHei"', '"微软雅黑"',
          '"PingFang SC"', '"Hiragino Sans GB"', 'sans-serif',
        ],
        mono: ['"SFMono-Regular"', 'Consolas', '"Liberation Mono"', 'Menlo', 'monospace'],
      },
      fontSize: {
        // [size, lineHeight] —— Notion 紧凑层级，base = 14px
        xs: ['12px', '18px'],
        sm: ['13px', '20px'],
        base: ['14px', '22px'],
        lg: ['16px', '24px'],
        xl: ['18px', '25px'],
        '2xl': ['20px', '28px'],
        '3xl': ['24px', '31px'],
        '4xl': ['32px', '38px'],
      },
      spacing: {
        0.5: '2px',
      },
      // bot 详情多栏面板限高：取代原 7 处 maxHeight:'70vh' 内联 style（静态类名供 JIT 扫描）。
      maxHeight: {
        panel: '70vh',
        'panel-sm': '24rem',
      },
      height: {
        panel: '70vh',
      },
      transitionDuration: {
        fast: '150ms',
        DEFAULT: '200ms',
        slow: '300ms',
      },
      transitionTimingFunction: {
        notion: 'cubic-bezier(0.16, 1, 0.3, 1)', // 克制 ease-out
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-out': { from: { opacity: '1' }, to: { opacity: '0' } },
        'slide-down': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-up-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'highlight-fade': {
          from: { backgroundColor: 'hsl(var(--primary-soft))' },
          to: { backgroundColor: 'transparent' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        shake: {
          '0%,100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-3px)' },
          '75%': { transform: 'translateX(3px)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms cubic-bezier(0.16,1,0.3,1)',
        'slide-down': 'slide-down 200ms cubic-bezier(0.16,1,0.3,1)',
        'slide-up-in': 'slide-up-in 200ms cubic-bezier(0.16,1,0.3,1)',
        'highlight-fade': 'highlight-fade 1200ms ease-out',
        // SSE 新项进场：位移 + 高亮渐隐，合并为单值（同元素叠两个 animation 类会互相覆盖）
        'enter-row': 'slide-up-in 200ms cubic-bezier(0.16,1,0.3,1), highlight-fade 1200ms ease-out',
        shimmer: 'shimmer 1.5s infinite',
        shake: 'shake 320ms ease-in-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
