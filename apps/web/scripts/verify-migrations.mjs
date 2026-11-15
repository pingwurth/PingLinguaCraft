/**
 * DB 迁移重放校验（pre-commit 的 *.sql 门禁，亦可在 apps/web 下手动运行）
 *
 * 把 src/lib/db/migrations 的全部迁移按 journal 顺序应用到一次性 SQLite 库，
 * 完成后 quick_check 复核——typecheck/test/lint 都不解析 SQL，对迁移提交是
 * 零验证；重放能拦下语法错误、顺序依赖错、与既有 schema 冲突的破坏性 DDL。
 * 全程只读迁移目录、写 /tmp 一次性库，绝不触碰 ~/.pinglc 真实库。
 * 退出码：0 通过 / 1 重放或校验失败（供 pre-commit 判定阻断）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// 迁移目录以本脚本位置定位（apps/web/scripts → apps/web/src/lib/db/migrations），
// 不依赖调用方 cwd（pre-commit 在仓库根运行）
const migrationsFolder = fileURLToPath(new URL('../src/lib/db/migrations', import.meta.url));

// 一次性重放库（/tmp 下临时目录，结束即删）
const workdir = mkdtempSync(join(tmpdir(), 'pinglc-migcheck-'));

try {
  const sqlite = new Database(join(workdir, 'replay.db'));
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
    // 完整性复核：迁移能跑完不代表库结构自洽（如迁移内 PRAGMA 异常被吞的极端情形）
    const check = sqlite.prepare('PRAGMA quick_check;').get();
    if (check?.quick_check !== 'ok') {
      console.error(`迁移重放完成但 quick_check 未通过：${check?.quick_check ?? '无结果'}`);
      process.exit(1);
    }
    const applied = sqlite.prepare('SELECT count(*) AS c FROM "__drizzle_migrations"').get();
    console.log(`迁移重放通过：${applied.c} 条迁移全部应用，quick_check=ok`);
  } finally {
    sqlite.close();
  }
} catch (err) {
  console.error('迁移重放失败（该迁移应用到全新库即出错，提交前必须修复）：', err);
  process.exit(1);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
