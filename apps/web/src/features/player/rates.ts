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
