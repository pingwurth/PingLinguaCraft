/**
 * 数据库迁移编排（应用启动时一次性执行 + 迁移前自动快照）
 *
 * 为什么从 getDb() 的懒触发改为启动时执行：懒触发在迁移失败后，单例保持 null，
 * 每次请求都会重开连接、重跑失败的迁移（请求级抖动）；且 DDL 执行前没有回退点
 * ——~/.pinglc 是唯一数据源，迁移脚本一旦有 bug 库文件直接损坏。
 *
 * 设计：
 * - 正常路径：src/instrumentation.ts 在服务进程启动时（先于任何请求）调用
 *   ensureDatabaseReady()，用一条短命连接完成「检测待执行迁移 → 快照 → 迁移」
 * - 兜底路径：getDb() 首次建连时同步补跑（脚本直接引入 db 等场景）；
 *   状态全局单飞（done/failed 缓存），失败后不再重试，重启进程才会重试。
 *   状态挂在 globalThis（Symbol.for 键）而非模块作用域：Next 把 instrumentation
 *   入口与路由 chunk 编译为独立 bundle，模块顶层 let 各持一份副本时会互不可见
 *   ——启动侧已 done/failed，路由侧仍 idle，单飞与失败缓存全部失效
 * - 快照：仅在确有待执行迁移且库文件已存在（非全新库）时，经当前连接执行
 *   VACUUM INTO 生成自洽单文件到 ~/.pinglc/backups/pinglc-premigrate-<时间戳>.db，
 *   保留最近 5 组（VACUUM INTO 为在线一致性页级复制，自洽且不带 -wal 伴生，
 *   比直接复制 db+-wal 两文件——两文件读取瞬间不同，可能撕裂——更可靠）
 * - 与 drizzle-kit migrate（pnpm db:migrate）共享同一套迁移记录表，可交替使用
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PATH, MEDIA_ROOT, PINGLC_HOME } from './paths';

/**
 * 静默取文件大小（字节）；取不到（权限/非目录等）返回 -1，让调用方按不合格处理
 */
function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/**
 * 静默删除快照产出：rmSync 的 force 只吞 ENOENT，EACCES/ENOTDIR/EPERM 仍会抛出
 * ——清理失败若逃逸会把「告警不阻断迁移」变成「快照故障阻断启动」，故再兜一层
 */
function rmQuiet(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* 尽力而为：残留文件不参与轮转判定之外的关键路径 */
  }
}

/** 迁移前快照目录与保留组数（遵循「一切用户数据在 ~/.pinglc/」约定） */
const SNAPSHOT_DIR = join(PINGLC_HOME, 'backups');
const SNAPSHOT_KEEP = 5;

/** globalThis 上的迁移状态键（Symbol.for：跨 bundle/跨模块副本取到同一个符号） */
const MIGRATION_STATE_KEY = Symbol.for('pinglc.dbMigrationState');

/** 迁移状态：idle 未执行 / done 已完成（或确认无事可做）/ failed 已失败（缓存错误） */
interface MigrationState {
  status: 'idle' | 'done' | 'failed';
  error: Error | null;
}

/**
 * 取跨 bundle 共享的迁移状态（首次访问时在 globalThis 上初始化）
 */
function sharedState(): MigrationState {
  const store = globalThis as Record<symbol, MigrationState | undefined>;
  store[MIGRATION_STATE_KEY] ??= { status: 'idle', error: null };
  return store[MIGRATION_STATE_KEY]!;
}

/**
 * 打开数据库连接（迁移编排与 getDb() 共用的建连引导，收敛为一处避免两路漂移）
 * @returns sqlite 已按 WAL/busy_timeout 初始化的连接；dbExisted 打开前库文件是否已存在
 *          （打开动作本身会创建空文件，快照判定必须用「打开前」的事实——
 *           全新库首启没有可保护的数据）
 */
export function openDatabase(): { sqlite: Database.Database; dbExisted: boolean } {
  mkdirSync(PINGLC_HOME, { recursive: true });
  mkdirSync(MEDIA_ROOT, { recursive: true });
  const dbExisted = existsSync(DB_PATH);
  const sqlite = new Database(DB_PATH);
  // WAL 模式：读写并发更平滑；busy 超时避免偶发锁冲突直接报错
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  return { sqlite, dbExisted };
}

/**
 * 迁移目录候选：next dev / next start 的 cwd 在 apps/web，
 * 兼容从仓库根直接启动 Node 进程的场景；以 meta/_journal.json 存在与否判定。
 */
const MIGRATION_DIR_CANDIDATES = [
  join(process.cwd(), 'src/lib/db/migrations'),
  join(process.cwd(), 'apps/web/src/lib/db/migrations'),
];

/**
 * 找到有效迁移目录（含 meta/_journal.json），找不到返回 null
 */
function findMigrationsFolder(): string | null {
  return MIGRATION_DIR_CANDIDATES.find((dir) => existsSync(join(dir, 'meta', '_journal.json'))) ?? null;
}

/**
 * 判断是否有待执行迁移（与 drizzle migrator 的真实判定对齐）
 * drizzle 的 better-sqlite3 migrator 只比较「journal 最新条目的 when」与
 * 「记录表中最大的 created_at」：前者更大即有迁移要跑。此前用「journal 条目数 −
 * 记录行数」计数，在 journal 被重新生成/条目变少/created_at 被改写时会误判 0
 * ——快照被静默跳过后 DDL 照跑，正是快照要防的数据丢失窗口。
 * 记录表不存在按「无已应用」处理（全新库）；检测自身出错时返回 true
 * （宁可贵一次快照，也不在状态不明时裸跑 DDL）
 * @param sqlite            已打开的数据库连接
 * @param migrationsFolder  迁移目录
 */
function hasPendingMigrations(sqlite: Database.Database, migrationsFolder: string): boolean {
  try {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
    ) as { entries?: Array<{ when?: number | string }> };
    // journal 最新条目的 when（drizzle 生成时单调递增，取 max 兜底防乱序）。
    // 任何条目的 when 非有限数值（journal 格式漂移）时按「有待执行」处理：
    // NaN 参与比较恒为 false，会静默跳过快照裸跑 DDL——正是快照要堵的窗口
    const whens = journal.entries!.map((e) => Number(e.when));
    let maxJournalWhen: number;
    if (whens.every(Number.isFinite)) {
      maxJournalWhen = Math.max(...whens);
    } else {
      // 格式漂移：fail-safe 按有待执行处理，但必须留线索——否则此后每次启动
      // 都判定有待执行并快照一次，悄悄耗掉轮转保留位却无人知道根因在 journal
      console.warn('[db] 迁移 journal 含非数值 when（meta/_journal.json 格式漂移？），按有待执行迁移处理');
      maxJournalWhen = Number.POSITIVE_INFINITY;
    }
    // 已应用的最大 created_at（SQLite 双引号才是标识符引用，单引号是字符串字面量——
    // 靠兼容解析才碰巧成立；表不存在（全新库）按无已应用处理）
    const row = sqlite
      .prepare('SELECT max(created_at) AS latest FROM "__drizzle_migrations"')
      .get() as { latest: number | null } | undefined;
    return maxJournalWhen > Number(row?.latest ?? Number.NEGATIVE_INFINITY);
  } catch {
    return true;
  }
}

/**
 * 迁移前快照库文件（DDL 前的回退点）
 * 经当前连接执行 VACUUM INTO：在线一致性页级复制，产出自洽单文件（恢复时拷回
 * ~/.pinglc/ 即可，无 -wal 伴生）——比直接复制 db+-wal 两个文件可靠：两次读取
 * 之间若有提交落盘，拷出的两文件互相撕裂，恢复时可能 malformed。
 * 此时本进程尚未写入任何数据（快照的是启动瞬间的已提交状态）。
 * @param sqlite 已打开的数据库连接（借用其执行快照 SQL）
 * @returns 快照文件路径；失败返回 null（告警不阻断迁移——迁移本身可回放）
 */
function snapshotDbFile(sqlite: Database.Database): string | null {
  // ISO 时间戳里的冒号/点替换为连字符，保证文件名字典序 == 时间序
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 声明在 try 外：中途失败（磁盘满等）可能已产出残缺文件，catch 里要能清理
  const base = `${SNAPSHOT_DIR}/pinglc-premigrate-${stamp}.db`;
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    // 路径经绑定参数传入，不做字符串拼接与手工转义（转义规则再确定也不如参数化根除）
    sqlite.prepare('VACUUM INTO ?').run(base);
    // 产出校验（与 scripts/backup.sh 的「非空 + quick_check」同一纪律）：
    // 非空断言拦「合法但空库」（0 字节源库的产出——quick_check 对它也返回 ok）；
    // quick_check 拦「非空但损坏」（VACUUM INTO 中途失败）；不合格即删，
    // 不占用轮转保留位
    const snap = new Database(base, { readonly: true });
    let quickCheck: string | undefined;
    try {
      quickCheck = (snap.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined)
        ?.quick_check;
    } finally {
      snap.close();
    }
    const size = statSize(base);
    if (size <= 0 || quickCheck !== 'ok') {
      // 大小与 quick_check 都进告警（先取值再删文件）：空产出（0 字节源库）的
      // quick_check 仍是 ok，只报其一会让排障看不出到底是空产出还是损坏
      rmQuiet(base);
      console.warn(
        `[db] 迁移前快照校验未通过（size=${size}B quick_check=${quickCheck ?? '无法打开'}），已丢弃（继续执行迁移）`
      );
      return null;
    }
    rotateSnapshots();
    return base;
  } catch (err) {
    // 清掉可能的残缺产出，再告警不阻断迁移（迁移本身可回放）；清理自身再失败
    // 也不能让异常逃出去阻断启动——快照任何失败都只告警
    rmQuiet(base);
    console.warn('[db] 迁移前快照失败（继续执行迁移）：', err);
    return null;
  }
}

/**
 * 快照轮转：按文件名字典序（时间戳命名，字典序 == 时间序）只保留最近 SNAPSHOT_KEEP 组
 * 兼容清理旧格式快照遗留的 -wal 伴生文件（现快照为 VACUUM INTO 单文件，不再产生）
 * 轮转失败只告警，不影响主流程
 */
function rotateSnapshots(): void {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => /^pinglc-premigrate-.*\.db$/.test(f))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - SNAPSHOT_KEEP))) {
      rmSync(join(SNAPSHOT_DIR, old), { force: true });
      rmSync(`${join(SNAPSHOT_DIR, old)}-wal`, { force: true });
    }
  } catch (err) {
    console.warn('[db] 快照轮转失败（不影响迁移）：', err);
  }
}

/**
 * 在已打开的连接上执行迁移（全局单飞 + 失败缓存；已 done 时为空操作）
 * 状态经 globalThis 共享：instrumentation bundle 与路由 chunk 各自的模块副本
 * 读写同一份，单飞与失败缓存对两条路径都成立。
 * @param sqlite    已按 WAL/busy_timeout 初始化的 better-sqlite3 连接
 * @param dbExisted 打开连接之前库文件是否已存在（打开动作本身会创建空文件，
 *                  快照判定必须用「打开前」的事实——全新库首启没有可保护的数据）
 * @throws 迁移失败时抛缓存过的 Error（连接的关闭由调用方负责）
 */
export function runMigrations(sqlite: Database.Database, dbExisted: boolean): void {
  const state = sharedState();
  if (state.status === 'done') return;
  if (state.status === 'failed') throw state.error;

  const migrationsFolder = findMigrationsFolder();
  if (!migrationsFolder) {
    // 不置 done、保持 idle：置 done 会把「迁移目录缺失」永久记成「迁移已 OK」，
    // 此后查询只剩 no such table 而日志再无提示；保持 idle 让每次建连都重新
    // 检查并告警（existsSync 探测开销可忽略），配置修复（正确 cwd/补齐文件）即自愈
    console.warn(
      '[db] 未找到迁移目录（src/lib/db/migrations），跳过自动迁移；如遇 no such table 请在 apps/web 下运行 pnpm db:migrate'
    );
    return;
  }
  try {
    // 有待执行迁移且库文件非全新（打开前已存在，含上次首启中途失败的部分库）
    // → 先快照再动 DDL
    if (dbExisted && hasPendingMigrations(sqlite, migrationsFolder)) {
      const snap = snapshotDbFile(sqlite);
      if (snap) console.log(`[db] 检测到待执行迁移，已快照库文件 → ${snap}（迁移失败时可拷回恢复）`);
    }
    migrate(drizzle(sqlite), { migrationsFolder });
    state.status = 'done';
  } catch (err) {
    state.status = 'failed';
    // 归一化为 Error：假值抛出（throw ''/0）会绕过调用方的真值判断快速失败；
    // 非 Error 对象也统一包一层，保证类型即契约
    state.error = err instanceof Error ? err : new Error(`数据库迁移失败: ${String(err)}`);
    throw state.error;
  }
}

/**
 * 迁移是否已失败
 * @returns 已失败时返回缓存错误（供懒兜底路径快速失败，避免重开连接重试），否则 null
 */
export function migrationFailure(): Error | null {
  return sharedState().status === 'failed' ? sharedState().error : null;
}

/**
 * 启动期迁移入口（instrumentation.ts 调用）：短命连接上一次性完成迁移
 * 连接即开即关（关闭时 WAL 自动 checkpoint 回主库文件），后续 getDb() 建连时
 * runMigrations 已 done，不会重复执行。
 * @throws 迁移失败时原样抛出（启动 fail fast，具体错误已在 migrate 内带上下文输出）
 */
export function ensureDatabaseReady(): void {
  const state = sharedState();
  if (state.status === 'failed') throw state.error;
  if (state.status === 'done') return;

  const { sqlite, dbExisted } = openDatabase();
  try {
    runMigrations(sqlite, dbExisted);
  } finally {
    sqlite.close();
  }
}
