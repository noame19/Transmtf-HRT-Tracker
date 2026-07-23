import type { Config } from 'tailwindcss';

// Local Tailwind config — replaces the previous runtime Play CDN
// (https://cdn.tailwindcss.com) that loaded at browser parse time.
//
//  - darkMode: 'class' — the theme bootstrap inline script in index.html
//    toggles `.dark` on <html>; Tailwind's `dark:` variant keys off that.
//  - content — scan only the production source paths. .worktrees/ is
//    intentionally excluded (parallel worktrees would emit duplicate
//    utilities and confuse HMR / dev server).
const config: Config = {
  darkMode: 'class',
  content: [
    './index.html',
    './index.tsx',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
