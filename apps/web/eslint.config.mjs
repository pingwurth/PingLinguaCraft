// ESLint 配置（flat config）：Next.js 官方规则集 + monorepo 源码包豁免
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  // 全局忽略：构建产物与依赖
  { ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts', 'public/sw.js'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  // @pinglc/core 为 TS 源码包，Next 插件对其规则告警可忽略
  {
    files: ['../../packages/core/**/*.ts'],
    rules: {
      'import/no-anonymous-default-export': 'off',
    },
  },
];

export default eslintConfig;
