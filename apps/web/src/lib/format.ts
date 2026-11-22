/**
 * 展示格式化单源（web 端纯函数）
 *
 * 藏经阁 / 案头今研首页 / 材料集详情页等页面共用的时长、相对时间、进度配色等
 * 纯展示函数：抽出单源避免跨页复制后口径漂移（时长进位、相对时间分段、
 * 进度条换色的阈值各写各的）。
 */

/**
 * 研读进度 → 进度条填充色（近毕深朱 / 进行竹青，与藏经阁稿 _10 一致）
 * @param pct 研读进度百分比
 */
export function progressTone(pct: number): string {
  return pct >= 60 ? 'bg-shell-seal' : 'bg-shell-bamboo';
}

/**
 * ms → 「x 小时 y 分」展示
 * @param ms 毫秒时长
 */
export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分`;
  return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
}

/**
 * epoch ms → 相对时间（刚刚 / N分钟前 / N小时前 / N天前 / M月D日）
 * @param ms epoch 毫秒
 */
export function fmtRelative(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 整数千分位展示（统计卡大数）
 * @param n 整数
 */
export function fmtInt(n: number): string {
  return n.toLocaleString('zh-CN');
}

/**
 * ms → mm:ss（材料时长角标）
 * @param ms 毫秒时长（空值显示占位破折号）
 */
export function fmtMs(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
