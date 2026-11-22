'use client';

/**
 * 进度上报 hook（精读播放页与语流页共用）
 *
 * - 位图逐句标记：激活句变化记入已听集合（rAF 频率天然去抖）
 * - 5s 防抖 + pagehide 兜底 + 卸载/换材终报（keepalive 尽力送达）
 * - materialId 变化即重建：已听集合清零、旧材料卸载时终报
 *   （语流页连播切换材料依赖此语义接力上报）
 * - 上报值取「持续快照」而非实时读取：位置与句号随 store 变化持续快照，
 *   句号走高水位（只增不减）。卸载终报时 React 已置空 ref/重置激活句，
 *   实时读会发出脏值（语流换材曾把旧材料进度清零），故一律读快照；
 *   高水位则防句间间隙的 -1 覆盖服务端 max_cue_index（无条件覆盖语义）
 */

import { useEffect, useRef } from 'react';
import { usePlayer } from './store';

/**
 * 启动进度上报（挂载期间持续，随 materialId 重建）
 * @param materialId 当前材料 id（切换即重建上报上下文）
 */
export function useProgressReporter(materialId: number): void {
  /** 已听句集合（材料内累积；materialId 重建时清零） */
  const listenedRef = useRef<Set<number>>(new Set());
  /** 持续快照：最近位置（毫秒）与高水位句号（终报兜底用，见文件头注释） */
  const snapRef = useRef({ positionMs: 0, maxCueIndex: -1 });

  useEffect(() => {
    listenedRef.current = new Set();
    snapRef.current = { positionMs: 0, maxCueIndex: -1 };
    // 起始时间记当前时刻：从 0 起算会让重建后第一条 store 变化立即上报，
    // 此时快照可能仍是被切走材料的旧值（语流换材 setCues 触发订阅），
    // 会把旧播放头写进新材料的进度行；首报落在 5s 后，期间快照已随新
    // 材料的 rAF 帧刷新
    let lastReport = Date.now();
    // 是否观测到有效播放（终报守卫）：从未产生快照就卸载（StrictMode 双挂载、
    // 秒进秒出）时终报会把 positionMs=0/maxCueIndex=-1 打给服务端无条件覆盖，
    // 抹掉既有续研位置——只在真的听过/走表后才终报
    let touched = false;
    const report = (final = false) => {
      const s = usePlayer.getState();
      if (s.cues.length === 0) return;
      const now = Date.now();
      if (!final && now - lastReport < 5000) return;
      lastReport = now;
      // 位图序列化
      const total = s.cues.length;
      const buf = new Uint8Array(Math.ceil(total / 8));
      listenedRef.current.forEach((i) => {
        buf[i >> 3] |= 1 << i % 8;
      });
      // 转标准 base64
      let bin = '';
      buf.forEach((b) => (bin += String.fromCharCode(b)));
      const mask = btoa(bin);
      void fetch(`/api/materials/${materialId}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lastPositionMs: snapRef.current.positionMs,
          maxCueIndex: snapRef.current.maxCueIndex,
          listenedMask: mask,
          listenedThrough: listenedRef.current.size >= total,
        }),
        keepalive: final,
      }).catch(() => undefined);
    };
    // store 变化即快照（位置随时钟帧更新、句号取高水位），激活句记入已听集合
    const unsub = usePlayer.subscribe((state) => {
      if (state.activeCueIndex >= 0) {
        listenedRef.current.add(state.activeCueIndex);
        if (state.activeCueIndex > snapRef.current.maxCueIndex) {
          snapRef.current.maxCueIndex = state.activeCueIndex;
        }
      }
      snapRef.current.positionMs = state.currentTimeMs;
      // 有激活句或播放头已走表才算有效播放（换材归零重置触发的 store 写不算）
      if (state.activeCueIndex >= 0 || snapRef.current.positionMs > 0) touched = true;
      if (Date.now() - lastReport >= 5000) report();
    });
    const onHide = () => {
      if (touched) report(true);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      unsub();
      window.removeEventListener('pagehide', onHide);
      if (touched) report(true);
    };
  }, [materialId]);
}
