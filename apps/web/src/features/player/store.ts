'use client';

/**
 * 播放器状态机（zustand）
 *
 * 时钟：rAF 每帧读 currentTime 写入 store（selector 订阅，避免全树重渲染）；
 * 循环：单句/A-B/整集在 tick 内完成回跳（详见 useMediaClock）；
 * 渐隐：controlsVisible 由 Player 的鼠标/触摸交互策略驱动（需求 6）。
 */

import { create } from 'zustand';
import type { CueDTO } from '@/lib/api';
import type { LoopMode, SubtitleMode } from '@pinglc/core';

/** 播放器全部状态与动作 */
interface PlayerState {
  /** 句段列表（播放页装载后写入） */
  cues: CueDTO[];
  /** 当前激活句下标（-1=间隙） */
  activeCueIndex: number;
  /** 当前播放时间（毫秒，rAF 每帧更新） */
  currentTimeMs: number;
  /** 总时长（毫秒） */
  durationMs: number;
  /** 播放中 */
  isPlaying: boolean;
  /** 缓冲进度（0~1） */
  bufferedRatio: number;
  /** 倍速（0.5~2.0） */
  rate: number;
  /** 音量（0~1） */
  volume: number;
  /** 静音 */
  muted: boolean;
  /** 循环模式 */
  loopMode: LoopMode;
  /** A-B 循环区间（毫秒） */
  abRange: { a: number; b: number } | null;
  /** 字幕显示模式 */
  subtitleMode: SubtitleMode;
  /** 控制条可见（渐隐策略驱动） */
  controlsVisible: boolean;
  /** 点词朗读目标（读一次即清） */
  pendingSpeak: { text: string; nonce: number } | null;
  /** 单句播放区间（听写/跟读用：播到 end 自动暂停；null=无） */
  playRange: { startMs: number; endMs: number } | null;

  // ---- 动作 ----
  setCues: (cues: CueDTO[]) => void;
  setActiveCueIndex: (i: number) => void;
  setCurrentTimeMs: (ms: number) => void;
  setDurationMs: (ms: number) => void;
  setPlaying: (v: boolean) => void;
  setBufferedRatio: (v: number) => void;
  setRate: (v: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setLoopMode: (m: LoopMode) => void;
  setAB: (range: { a: number; b: number } | null) => void;
  cycleSubtitleMode: () => void;
  setControlsVisible: (v: boolean) => void;
  speakWord: (text: string) => void;
  clearPendingSpeak: () => void;
  setPlayRange: (range: { startMs: number; endMs: number } | null) => void;
}

/** 全局播放器 store 单例 */
export const usePlayer = create<PlayerState>((set) => ({
  cues: [],
  activeCueIndex: -1,
  currentTimeMs: 0,
  durationMs: 0,
  isPlaying: false,
  bufferedRatio: 0,
  rate: 1,
  volume: 1,
  muted: false,
  loopMode: 'none',
  abRange: null,
  subtitleMode: 'bilingual',
  controlsVisible: true,
  pendingSpeak: null,
  playRange: null,

  setCues: (cues) => set({ cues }),
  setActiveCueIndex: (activeCueIndex) => set({ activeCueIndex }),
  setCurrentTimeMs: (currentTimeMs) => set({ currentTimeMs }),
  setDurationMs: (durationMs) => set({ durationMs }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setBufferedRatio: (bufferedRatio) => set({ bufferedRatio }),
  setRate: (rate) => set({ rate }),
  setVolume: (volume) => set({ volume }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  setLoopMode: (loopMode) =>
    set((s) => ({
      loopMode,
      // 切出 A-B 模式时清掉旧区间
      abRange: loopMode === 'ab' ? s.abRange : null,
    })),
  setAB: (abRange) => set({ abRange }),
  cycleSubtitleMode: () =>
    set((s) => ({
      subtitleMode:
        s.subtitleMode === 'bilingual' ? 'en' : s.subtitleMode === 'en' ? 'zh' : s.subtitleMode === 'zh' ? 'off' : 'bilingual',
    })),
  setControlsVisible: (controlsVisible) => set({ controlsVisible }),
  speakWord: (text) => set({ pendingSpeak: { text, nonce: Date.now() } }),
  clearPendingSpeak: () => set({ pendingSpeak: null }),
  setPlayRange: (playRange: { startMs: number; endMs: number } | null) => set({ playRange }),
}));
