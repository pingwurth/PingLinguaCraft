/**
 * Hermes 兼容性守卫（「core 必须能被 Expo 直接消费」约束的机械化检查）
 *
 * 正则后行断言（(?<=) / (?<!)）在 Hermes（Expo/React Native 默认引擎）与旧 Safari
 * 上不受支持，模块加载即抛 SyntaxError——编译期与 Node 测试都发现不了。本测试遍历
 * src 全目录逐一检查源码，一旦引入立即失败；与 .opencodereview/rule.json 的 core
 * 规则互为兜底（规则管 AI 审查提醒，本测试管机器门禁）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 递归收集目录下全部 .ts/.tsx 源文件的绝对路径 */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectSources(full, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe('Hermes 兼容性', () => {
  it('src 全目录不含正则后行断言（Hermes/旧 Safari 加载即 SyntaxError）', () => {
    const srcDir = join(fileURLToPath(new URL('..', import.meta.url)), 'src');
    const offenders = collectSources(srcDir).filter((f) =>
      readFileSync(f, 'utf8').includes('(?<'),
    );
    expect(offenders).toEqual([]);
  });
});
