/**
 * 数据库连接管理（better-sqlite3 + Drizzle）
 *
 * 单例模式：首次调用时确保 ~/.pinglc/ 目录存在、打开 ~/.pinglc/pinglc.db、
 * 并自动应用未执行的迁移（应用自供给——新克隆 pnpm dev 即可用，无需手动 db:migrate）。
 * WAL 模式提升并发读写性能（播放页轮询与写入并存）。
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as schema from './schema';

/** PingLinguaCraft 用户数据根目录（一切配置/模型/缓存的父目录） */
export const PINGLC_HOME = join(homedir(), '.pinglc');

/** SQLite 数据库文件路径 */
export const DB_PATH = join(PINGLC_HOME, 'pinglc.db');

/** 媒体文件根目录 */
export const MEDIA_ROOT = join(PINGLC_HOME, 'media');

/**
 * 迁移目录候选：next dev / next start 的 cwd 在 apps/web，
 * 兼容从仓库根直接启动 Node 进程的场景；以 meta/_journal.json 存在与否判定。
 */
const MIGRATION_DIR_CANDIDATES = [
  join(process.cwd(), 'src/lib/db/migrations'),
  join(process.cwd(), 'apps/web/src/lib/db/migrations'),
];

/** 数据库连接单例（懒加载） */
let dbInstance: ReturnType<typeof createDb> | null = null;

/**
 * 创建新的数据库连接（内部函数，外部请使用 getDb）
 *
 * 打开库文件后同步应用未执行的迁移（better-sqlite3 全同步，无并发窗口）；
 * 迁移与 drizzle-kit migrate 共享同一套迁移记录表，二者可交替使用。
 * @returns Drizzle 数据库实例（含 schema 类型）
 */
function createDb() {
  // 确保用户数据目录存在
  mkdirSync(PINGLC_HOME, { recursive: true });
  mkdirSync(MEDIA_ROOT, { recursive: true });
  const sqlite = new Database(DB_PATH);
  // WAL 模式：读写并发更平滑；busy 超时避免偶发锁冲突直接报错
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });

  // 自动迁移：新克隆/新迁移文件落地后首启即生效；找不到迁移目录时告警不阻断
  const migrationsFolder = MIGRATION_DIR_CANDIDATES.find((dir) =>
    existsSync(join(dir, 'meta', '_journal.json'))
  );
  if (migrationsFolder) {
    try {
      migrate(db, { migrationsFolder });
    } catch (err) {
      // 迁移失败必须先关闭连接再抛出：句柄不关会泄漏（better-sqlite3 长持文件描述符），
      // 且单例仍为 null 会让后续每次请求重开新连接、重跑失败的迁移；
      // 附上下文后原样抛出，保留原始堆栈便于定位（可在 apps/web 下运行 pnpm db:migrate 复现详情）
      sqlite.close();
      console.error('[db] 自动迁移失败（连接已关闭，下次请求会重试）：', err);
      throw err;
    }
  } else {
    console.warn(
      '[db] 未找到迁移目录（src/lib/db/migrations），跳过自动迁移；如遇 no such table 请在 apps/web 下运行 pnpm db:migrate'
    );
  }
  return db;
}

/**
 * 获取数据库连接单例
 * @returns Drizzle 数据库实例
 */
export function getDb() {
  if (!dbInstance) dbInstance = createDb();
  return dbInstance;
}
