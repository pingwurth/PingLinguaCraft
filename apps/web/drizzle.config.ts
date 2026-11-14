// Drizzle Kit 配置：迁移文件生成与应用（pnpm db:generate / db:migrate）
import { join } from 'node:path';
import { homedir } from 'node:os';

export default {
  // Schema 文件位置
  schema: './src/lib/db/schema.ts',
  // 迁移 SQL 输出目录
  out: './src/lib/db/migrations',
  // 数据库方言
  dialect: 'sqlite',
  // 迁移应用目标：用户数据目录下的库文件
  dbCredentials: {
    url: join(homedir(), '.pinglc', 'pinglc.db'),
  },
} as const;
