import type { Config } from 'tailwindcss';

// Design tokens lifted 1:1 from the original frontend/index.html :root CSS variables
// so the migrated UI matches colors, radii, and density exactly.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        bg2: 'var(--bg2)',
        bg3: 'var(--bg3)',
        text: 'var(--text)',
        text2: 'var(--text2)',
        text3: 'var(--text3)',
        border: 'var(--border)',
        border2: 'var(--border2)',
        blue: { DEFAULT: 'var(--blue)', l: 'var(--blue-l)', d: 'var(--blue-d)' },
        green: { DEFAULT: 'var(--green)', l: 'var(--green-l)' },
        amber: { DEFAULT: 'var(--amber)', l: 'var(--amber-l)' },
        red: { DEFAULT: 'var(--red)', l: 'var(--red-l)' },
        purple: { DEFAULT: 'var(--purple)', l: 'var(--purple-l)' },
      },
      borderRadius: {
        sm2: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg2: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Mono', 'Courier New', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,.08)',
      },
    },
  },
  plugins: [],
};

export default config;
