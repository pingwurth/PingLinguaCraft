// ESLint 配置（flat config）：移动骨架用 JS 推荐 + TS 推荐 + React Hooks 规则
// （无 Next 环境，web 端的 next/core-web-vitals 规则集不适用）。
// 补齐后仓库门禁 pnpm -r lint 不再静默跳过本包。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // 全局忽略：依赖与 Expo 构建产物
  { ignores: ['node_modules/**', '.expo/**', 'dist/**', 'web-build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // React Hooks 规则（App.tsx 播放订阅 effect 的依赖检查）。
  // exhaustive-deps 必须为 error：lint 脚本无 --max-warnings 0，warn 不拦门禁
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // Expo 生成的 CommonJS 配置文件（metro.config.js 等）：Node 环境 + commonjs 源
  {
    files: ['**/*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
