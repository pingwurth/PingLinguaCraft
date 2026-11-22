'use client';

/**
 * rAF 媒体时钟（播放器心脏）
 *
 * - 每帧读 video.currentTime → store.currentTimeMs（timeupdate ≈4Hz 太粗）
 * - 单句/A-B 循环回跳在本 tick 内完成（超帧 16ms 内无感）；单句循环目标
 *   跟随 seek 落点句迁移（详见 tick 内「循环回跳」注释）
 * - cue 激活判定：区间二分（cues 有序）
 * - 双语字幕跟随进度在此派生，不额外设状态
 */

import { useEffect } from 'react';
import { findCueIndex } from '@pinglc/core';
import { usePlayer } from './store';

/** 帧间位置跳变阈值（毫秒）：超过即视为 seek 接管。自然推进每帧最多约
 *  70ms（2x 倍速 × 33ms 低频帧），250ms 余量充分；比它小的 seek 由媒体
 *  seeking 事件兜底捕获，两者互补 */
const SEEK_JUMP_MS = 250;

/**
 * 启动 rAF 时钟：绑定媒体元素，驱动 store 的时间/激活句/循环回跳
 * @param mediaRef 媒体元素 ref（<video>；音频材料也用同一元素，泛型兼容 <audio>）
 */
export function useMediaClock<T extends HTMLMediaElement>(mediaRef: React.RefObject<T | null>): void {
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    let rafId = 0;
    let lastActive = -2; // 去重：只在激活句变化时写 store
    let prevT = -1; // 上一帧位置（毫秒）：判帧间跳变
    let seekFlag = false; // 媒体 seeking 事件旗标：下一帧按「seek 接管」处理

    /** 任何 seek（用户操作或本 tick 的循环回跳）都置旗标，供下一帧判别 */
    const onSeeking = () => {
      seekFlag = true;
    };
    media.addEventListener('seeking', onSeeking);

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const s = usePlayer.getState();
      // 句段/激活句/循环参数一律取同一份 store 快照：渲染闭包里的 cues 是
      // 上一轮渲染值，与 getState 的句号混用会在换材间隙拿新句号配旧句段，
      // 单句循环误判 endMs 后回跳到无关时间戳
      const cues = s.cues;
      const t = media.currentTime * 1000;
      // seek 接管判定：seeking 事件（任意幅度，含暂停态拖动）或帧间大跳
      // （后台标签页 rAF 停摆、音频继续走，回前台时位置的静默跳变）
      const jumped = seekFlag || (prevT >= 0 && Math.abs(t - prevT) > SEEK_JUMP_MS);
      seekFlag = false;
      prevT = t;

      // —— 单句播放区间：到点自动暂停（听写/跟读的「听原文」）——
      // 判定必须先于循环回跳：循环条件命中会提前 return，「听一次」将变成无限循环
      if (s.playRange && t >= s.playRange.endMs && !media.paused) {
        media.pause();
        s.setPlayRange(null);
        return;
      }

      // —— 循环回跳（在渲染前完成，听感无断点）——
      // 单句循环目标 = store 激活句：自然播到句尾即回跳——用 store 句而非本帧
      // 位置判定，句尾触发窗（10ms）被 16ms 帧步长整体跳过、或字幕零间隙
      // （endMs == 下句 startMs）时位置已落入下句，仍稳回跳不逃逸。
      // seek 接管帧（jumped）跳过本帧回跳：位置先行，下方激活句更新为落点句，
      // 循环目标随之迁移——单句循环下点「下一句」/Shift+←/→/点字幕/拖进度条
      // /±5s 全靠此生效；落进句间间隙则放行自由播，进句后循环该句
      if (s.loopMode === 'sentence' && !media.paused && !jumped && s.activeCueIndex >= 0) {
        const cue = cues[s.activeCueIndex];
        if (cue && t >= cue.endMs - 10) {
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
    return () => {
      cancelAnimationFrame(rafId);
      media.removeEventListener('seeking', onSeeking);
    };
  }, [mediaRef]);
}
