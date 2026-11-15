/**
 * DB 迁移重放校验（pre-commit 的 *.sql 门禁，亦可在 apps/web 下手动运行）
 *
 * 三道检查（按失败定位精度从高到低排列，前道不过即跳过后续）：
 * 1. 已应用的迁移文件被改动/删除/重命名（AGENTS.md：「已应用的迁移文件永不改动」，
 *    改动等于重跑 → DROP 重建丢数据）——重放到全新库无法暴露这种漂移（新旧都能
 *    干净重放，真实库却按 created_at 跳过），必须对照 git 暂存快照显式拦截；
 *    比对用 --cached（与提交内容严格一致），比对工作区会把未暂存 WIP 误拦入册
 * 2. journal 与 .sql 文件双向核对——孤立 .sql（新增文件但没跑 db:generate 进
 *    journal）不会被任何路径执行，静默放行等于门禁空转；journal 条目缺 .sql
 *    则重放会抛笼统错误，先核对才能给出精确报错（故本道在重放之前）
 * 3. 全部迁移按 journal 顺序重放到一次性 SQLite 库——拦语法错误、顺序依赖错、
 *    与既有 schema 冲突的破坏性 DDL（typecheck/test/lint 都不解析 SQL）
 *
 * 全程只读迁移目录、写 /tmp 一次性库，绝不触碰 ~/.pinglc 真实库。
 * 退出码：0 通过 / 1 校验失败（供 pre-commit 判定阻断）。
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// 迁移目录以本脚本位置定位（apps/web/scripts → apps/web/src/lib/db/migrations），
// 不依赖调用方 cwd（pre-commit 在仓库根运行）
const migrationsFolder = fileURLToPath(new URL('../src/lib/db/migrations', import.meta.url));

/**
 * 检查一：已跟踪迁移 .sql 在暂存快照中是否被改动/删除/重命名
 * 阻塞型门禁不 fail-open：git 真实故障（index 损坏、dubious ownership）置失败
 * 而非静默跳过；仅「确实不在 git 仓库内」（解包目录直跑）才跳过，交给重放兜底
 */
function failOnModifiedMigrations() {
  const git = (args) =>
    execSync(args, {
      cwd: migrationsFolder,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let inside;
  try {
    inside = git('git rev-parse --is-inside-work-tree').trim();
  } catch (err) {
    console.error(`无法判定是否在 git 仓库内（git 不可用？${err.message ?? ''}），迁移改动检查失败`);
    process.exitCode = 1;
    return;
  }
  if (inside !== 'true') return; // 不在仓库内：跳过检查一，交给检查二/三兜底

  let status;
  try {
    status = git('git diff --cached --name-status HEAD --ignore-submodules -- .');
  } catch (err) {
    console.error(`git diff 执行失败（index 损坏 / dubious ownership？）：${err.message ?? ''}`);
    process.exitCode = 1;
    return;
  }
  // M/D 单路径；R100	old	new 重命名两端都可能是迁移，都报出来
  const offenders = [];
  for (const line of status.split('\n')) {
    const cols = (line ?? '').split('\t');
    const st = cols[0] ?? '';
    if (!/^[MDR]/.test(st)) continue;
    const paths = st.startsWith('R') ? cols.slice(1) : [cols[cols.length - 1]];
    for (const p of paths) {
      if (p && p.trimEnd().endsWith('.sql')) offenders.push(`${st.replace(/\d+$/, '')}  ${p.trim()}`);
    }
  }
  if (offenders.length > 0) {
    console.error('以下已跟踪的迁移文件在本次提交中被改动/删除/重命名（已应用的迁移文件永不改动——改动等于重跑，真实库会 DROP 重建丢数据）：');
    for (const o of offenders) console.error(`  ${o}`);
    process.exitCode = 1;
  }
}

/**
 * 检查二：journal 结构校验 + 与 .sql 文件双向核对
 * @returns 解析后的 journal（entries 数组）；结构不合规时打印明确原因并返回 null
 */
function checkJournal() {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    console.error(`未找到迁移 journal（${journalPath}）：请先在 apps/web 下运行 pnpm db:generate`);
    return null;
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch (err) {
    console.error(`meta/_journal.json 不是合法 JSON：${err.message ?? err}`);
    return null;
  }
  if (!Array.isArray(journal?.entries)) {
    console.error('meta/_journal.json 缺少合法的 entries 数组（手工编辑/截断/格式漂移？）：请重新运行 pnpm db:generate');
    return null;
  }
  const sqlFiles = readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql'));
  const tags = new Set(journal.entries.map((e) => e.tag));
  const orphans = sqlFiles.filter((f) => !tags.has(f.replace(/\.sql$/, '')));
  const missing = journal.entries.filter((e) => !sqlFiles.includes(`${e.tag}.sql`));
  if (orphans.length > 0) {
    console.error('以下 .sql 未进 meta/_journal.json（新增迁移后请运行 pnpm db:generate），它们不会被任何路径执行：');
    for (const f of orphans) console.error(`  ${f}`);
  }
  if (missing.length > 0) {
    console.error('以下 journal 条目缺少对应 .sql 文件（文件被误删/改名？）：');
    for (const e of missing) console.error(`  ${e.tag}`);
  }
  return orphans.length > 0 || missing.length > 0 ? null : journal;
}

// ---- 主流程：前道检查不过即跳过后续（失败定位由精到粗）----

failOnModifiedMigrations();
const journal = process.exitCode ? null : checkJournal();
if (!process.exitCode && !journal) process.exitCode = 1;

// 一次性重放库（/tmp 下临时目录，结束即删）
const workdir = mkdtempSync(join(tmpdir(), 'pinglc-migcheck-'));

if (!process.exitCode) {
  try {
    const sqlite = new Database(join(workdir, 'replay.db'));
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      // 完整性复核：迁移能跑完不代表库结构自洽（如迁移内 PRAGMA 异常被吞的极端情形）
      const check = sqlite.prepare('PRAGMA quick_check;').get();
      if (check?.quick_check !== 'ok') {
        console.error(`迁移重放完成但 quick_check 未通过：${check?.quick_check ?? '无结果'}`);
        process.exitCode = 1;
      }
      const applied = sqlite.prepare('SELECT count(*) AS c FROM "__drizzle_migrations"').get();
      if (applied?.c !== journal.entries.length) {
        console.error(`迁移重放条数（${applied?.c}）与 journal 条目数（${journal.entries.length}）不一致`);
        process.exitCode = 1;
      }
      if (!process.exitCode) {
        console.log(`迁移重放通过：${applied.c} 条迁移全部应用，quick_check=ok`);
      }
    } finally {
      // close 放 finally；失败用 exitCode 而非 process.exit——后者立即终止进程，
      // finally 中的 rmSync(workdir) 不会执行，失败路径会在 /tmp 遗留整库副本
      sqlite.close();
    }
  } catch (err) {
    console.error('迁移重放失败（该迁移应用到全新库即出错，提交前必须修复）：', err);
    process.exitCode = 1;
  }
}

rmSync(workdir, { recursive: true, force: true });
