'use client';

/**
 * rAF 媒体时钟（播放器心脏）
 *
 * - 每帧读 video.currentTime → store.currentTimeMs（timeupdate ≈4Hz 太粗）
 * - 单句/A-B 循环回跳在本 tick 内完成（超帧 16ms 内无感）
 * - cue 激活判定：区间二分（cues 有序）
 * - 双语字幕跟随进度在此派生，不额外设状态
 */

import { useEffect } from 'react';
import { findCueIndex } from '@pinglc/core';
import { usePlayer } from './store';

// findCueIndex（二分查当前句）已上移 @pinglc/core —— 与 Expo 端播放跟随共用；
// 此处再导出保持播放器内部既有引用面稳定
export { findCueIndex };

/**
 * 启动 rAF 时钟：绑定媒体元素，驱动 store 的时间/激活句/循环回跳
 * @param mediaRef 媒体元素 ref（<video>；音频材料也用同一元素）
 */
export function useMediaClock(mediaRef: React.RefObject<HTMLVideoElement | null>): void {
  // 循环参数从 store 读快照（tick 内 getState，避免闭包过期）
  const cues = usePlayer((s) => s.cues);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    let rafId = 0;
    let lastActive = -2; // 去重：只在激活句变化时写 store

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const s = usePlayer.getState();
      const t = media.currentTime * 1000;

      // —— 单句播放区间：到点自动暂停（听写/跟读的「听原文」）——
      // 判定必须先于循环回跳：循环条件命中会提前 return，「听一次」将变成无限循环
      if (s.playRange && t >= s.playRange.endMs && !media.paused) {
        media.pause();
        s.setPlayRange(null);
        return;
      }

      // —— 循环回跳（在渲染前完成，听感无断点）——
      if (s.loopMode === 'sentence' && s.activeCueIndex >= 0) {
        const cue = s.cues[s.activeCueIndex];
        if (cue && t >= cue.endMs - 10 && !media.paused) {
          media.currentTime = cue.startMs / 1000;
          return;
        }
      } else if (s.loopMode === 'ab' && s.abRange) {
        const { a, b } = s.abRange;
        if (b > a && t >= b - 10 && !media.paused) {
          media.currentTime = a / 1000;
          return;
        }
      }

      // —— 时间与激活句（帧内写；selector 订阅者自精简渲染）——
      s.setCurrentTimeMs(t);

      const active = findCueIndex(cues, t);
      if (active !== lastActive) {
        lastActive = active;
        s.setActiveCueIndex(active);
      }

      // —— 缓冲进度（低频写：只在变化 >1% 时）——
      try {
        if (media.buffered.length > 0 && media.duration > 0) {
          const end = media.buffered.end(media.buffered.length - 1);
          const ratio = end / media.duration;
          if (Math.abs(ratio - s.bufferedRatio) > 0.01) s.setBufferedRatio(ratio);
        }
      } catch {
        /* buffered 查询竞态无害 */
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mediaRef, cues]);
}
