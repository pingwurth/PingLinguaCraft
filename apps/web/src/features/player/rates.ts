/**
 * 播放器共享常量与定位助手（精读播放页与语流页单源）
 */

/** 倍速档位（精读 Player 与语流 StreamPlayer 共用——两处各写一份会随档位调整漂移） */
export const PLAYER_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** 续播定位生效阈值（毫秒）：低于此值视为从头播（精读续播/补跳与语流换材定位共用） */
export const RESUME_SEEK_MIN_MS = 500;

/**
 * 定位值按媒体时长夹取（片尾 0.5s 退避：贴尾定位会立刻触发 ended）
 * @param ms          目标定位（毫秒）
 * @param durationSec 媒体时长（秒）；未知/非有限值不夹取原样返回
 */
export function clampSeekMs(ms: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return ms;
  return Math.min(ms, Math.max(0, durationSec * 1000 - 500));
}

/** 续播贴尾判定阈值（毫秒）：夹取后距片尾不足此值视为「整篇听完」 */
export const RESUME_TAIL_MS = 1000;

/**
 * 续播目标解析（精读/语流两播放器共用的完整语义）：夹取 + 贴尾回落。
 * 整篇听完的材料 lastPositionMs ≈ 时长，落点贴片尾会「播半秒即 ended」——
 * 语流被连播接力带走（chip 看似跳材）、精读停在末句，统一回落从头播。
 * 夹取一律委托 clampSeekMs（片尾退避改档只改那一处，两路不漂移）
 * @param ms          续播定位（毫秒）
 * @param durationSec 媒体时长（秒）；未知/非有限值不夹取
 * @returns 实际落点（毫秒）；贴尾时 0（从头）
 */
export function resolveResumeSeekMs(ms: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return ms;
  const clamped = clampSeekMs(ms, durationSec);
  return durationSec * 1000 - clamped < RESUME_TAIL_MS ? 0 : clamped;
}

/**
 * 定位落点解析（精读 Player 的 loadedmetadata 补跳与续播 effect 共用单源）：
 * 深链（?t=，手册「去原声」等）只钳尾不贴尾回落——目标可以是末句，回落
 * 从头会跳丢目标句；续播走完整的贴尾回落语义
 * @param ms          定位值（毫秒）
 * @param durationSec 媒体时长（秒）
 * @param deepLink    定位值来自 ?t= 深链（true 时只钳尾）
 */
export function resolveSeekTargetMs(ms: number, durationSec: number, deepLink: boolean): number {
  return deepLink ? clampSeekMs(ms, durationSec) : resolveResumeSeekMs(ms, durationSec);
}
