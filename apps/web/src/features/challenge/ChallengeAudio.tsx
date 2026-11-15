'use client';

/**
 * 闯关玩法播放通道（独立于播放页 Player）
 *
 * 闯关路由不挂载 Player，而 playSentenceOnce/stopPlayback 只是发 window 事件——
 * 本组件在闯关页提供专属监听与隐藏 <audio>：单句播放区间（到点自停）、
 * 跳播、暂停。离开玩法卸载即停。
 */

import { useEffect, useRef } from 'react';
import { usePlayer } from '@/features/player/store';

/**
 * 播放通道组件（隐藏挂载于闯关页）
 * @param props.materialId 材料 id（媒体经 /api/media 流式取用）
 */
export function ChallengeAudio({ materialId }: { materialId: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    /** rAF 循环：单句区间到点自停（与播放页时钟同语义） */
    let rafId = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const s = usePlayer.getState();
      if (s.playRange && el.currentTime * 1000 >= s.playRange.endMs && !el.paused) {
        el.pause();
        s.setPlayRange(null);
      }
    };
    rafId = requestAnimationFrame(tick);

    /** 单句播放（听写/跟读「听原句」） */
    const onPlayRange = (e: Event) => {
      const range = (e as CustomEvent<{ startMs: number; endMs: number }>).detail;
      const s = usePlayer.getState();
      s.setPlayRange(range);
      el.currentTime = range.startMs / 1000 + 0.01;
      void el.play().catch(() => undefined);
    };
    /** 跳播 */
    const onSeek = (e: Event) => {
      usePlayer.getState().setPlayRange(null);
      el.currentTime = (e as CustomEvent<number>).detail / 1000 + 0.01;
      void el.play().catch(() => undefined);
    };
    /** 暂停（同时放弃区间） */
    const onPause = () => {
      usePlayer.getState().setPlayRange(null);
      el.pause();
    };
    window.addEventListener('pinglc:play-range', onPlayRange);
    window.addEventListener('pinglc:seek', onSeek);
    window.addEventListener('pinglc:pause', onPause);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('pinglc:play-range', onPlayRange);
      window.removeEventListener('pinglc:seek', onSeek);
      window.removeEventListener('pinglc:pause', onPause);
      el.pause();
      usePlayer.getState().setPlayRange(null);
    };
  }, []);

  return (
    /* 隐藏音频元素：闯关玩法的原声通道 */
    <audio ref={audioRef} src={`/api/media/${materialId}`} preload="metadata" className="hidden" />
  );
}
