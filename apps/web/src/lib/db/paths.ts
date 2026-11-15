/**
 * 数据库与用户数据路径常量
 *
 * 从 db/index.ts 拆出：连接管理（index.ts）与迁移编排（migrate.ts）都需要这些
 * 常量，放在任一方都会造成循环依赖；index.ts 对外原样 re-export，既有
 * `import { MEDIA_ROOT } from '@/lib/db'` 的用法不受影响。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** PingLinguaCraft 用户数据根目录（一切配置/模型/缓存的父目录） */
export const PINGLC_HOME = join(homedir(), '.pinglc');

/** SQLite 数据库文件路径 */
export const DB_PATH = join(PINGLC_HOME, 'pinglc.db');

/** 媒体文件根目录 */
export const MEDIA_ROOT = join(PINGLC_HOME, 'media');
