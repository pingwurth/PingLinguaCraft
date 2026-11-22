'use client';

/**
 * 进度上报 hook（精读播放页与语流页共用）
 *
 * - 位图逐句标记：激活句变化记入已听集合（rAF 频率天然去抖）
 * - 5s 防抖 + pagehide 兜底 + 卸载/换材终报（keepalive 尽力送达）
 * - materialId 变化即重建：已听集合清零、旧材料卸载时终报
 *   （语流页连播切换材料依赖此语义接力上报）
 * - 上报位置取「持续快照」：随 store 变化持续快照（卸载终报读实时位置会拿到
 *   React 已置空的脏值）；句号取实际停留句（书签「第 N 句」引文与续研 seek
 *   位置同句），高水位仅作句间间隙 -1 的兜底——全程未观测到激活句则整体
 *   省略该字段，服务端保留库中现值（防 -1 被钳 0 抹掉已存续研书签）
 * - 卸载（真正离开播放页）后失效 ['home'] 聚合缓存：壳层统计常驻且有
 *   staleTime，不失效会挂旧数。失效等最后一次终报 PUT 落定再发（并发
 *   在途时 GET 可能先读旧进度），且不随 materialId 重建触发——语流连播
 *   每次换材都跑一次 cleanup，跟着失效会让常驻 home 查询连播一晚打
 *   十几次重聚合
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePlayer } from './store';
import { HOME_QUERY_KEY } from '@/features/home/query-keys';

/**
 * 启动进度上报（挂载期间持续，随 materialId 重建）
 * @param materialId 当前材料 id（切换即重建上报上下文）
 * @param mediaRef   媒体元素 ref（可选；仅 pagehide 终报取实时位置用——后台
 *                   标签页 rAF 停摆而音频继续播，快照会停在转入后台那一刻，
 *                   把续播书签倒回几分钟前。卸载终报不读它：ref 已被 React
 *                   置空，换材时元素 src 也已切换，读了必是脏值）
 */
export function useProgressReporter(
  materialId: number,
  mediaRef?: React.RefObject<HTMLVideoElement | null>,
): void {
  /** 已听句集合（材料内累积；materialId 重建时清零） */
  const listenedRef = useRef<Set<number>>(new Set());
  /** 持续快照：最近位置（毫秒）与高水位句号（终报兜底用，见文件头注释） */
  const snapRef = useRef({ positionMs: 0, maxCueIndex: -1 });
  /** 在途上报链：所有已发出的 PUT 依次串链（终报与 5s 防抖上报都计入——
   *  卸载时任何在途 PUT 晚落都会让紧随的 GET 读到旧进度） */
  const inflightRef = useRef<Promise<void>>(Promise.resolve());
  const qc = useQueryClient();

  useEffect(() => {
    /* 清掉单例 store 里上一素材残留的播放头/激活句（resetClock 与语流换材
     * 同一动作单源）。store 是模块单例且 Player/StreamPlayer 卸载都不清时钟
     * （Player 卸载只清 playRange），故此清零承担全部责任：本 effect 内先清
     * 后 subscribe，订阅注册前的任何旧值都不会进快照/已听集合——精读页
     * 软导航、语流→精读等所有入口的残留都由这里兜住 */
    usePlayer.getState().resetClock();
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
    const report = (final = false, livePositionMs?: number): Promise<void> | undefined => {
      const s = usePlayer.getState();
      if (s.cues.length === 0) return undefined;
      const now = Date.now();
      if (!final && now - lastReport < 5000) return undefined;
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
      // 上报句号 = 实际停留句（书签引文与续研位置一致）；句间间隙 -1 退高水位
      // 兜底；全程未观测到激活句则整体省略——服务端保留库中现值（无条件钳 0
      // 会把已存书签抹成「第 1 句」，首页续研入口随之消失）
      const cueIndex = s.activeCueIndex >= 0 ? s.activeCueIndex : snapRef.current.maxCueIndex;
      // 返回 fetch Promise 并串入在途链（卸载路径等全链落定后再失效 home 缓存）
      const p = fetch(`/api/materials/${materialId}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lastPositionMs: livePositionMs ?? snapRef.current.positionMs,
          ...(cueIndex >= 0 ? { maxCueIndex: cueIndex } : {}),
          listenedMask: mask,
          listenedThrough: listenedRef.current.size >= total,
        }),
        keepalive: final,
      })
        .then(() => undefined)
        .catch(() => undefined);
      inflightRef.current = inflightRef.current.then(() => p);
      return p;
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
      if (Date.now() - lastReport >= 5000) void report();
    });
    const onHide = () => {
      if (!touched) return;
      // 后台收听场景 rAF 停摆：终报位置优先取媒体元素实时值（见 hook 头注释）。
      // 此处不失效 home：页面正在隐藏，触发的重取大概率被中断；回前台聚焦自会重取
      const live = mediaRef?.current;
      void report(true, live ? live.currentTime * 1000 : undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      unsub();
      window.removeEventListener('pagehide', onHide);
      if (touched) void report(true);
    };
  }, [materialId, mediaRef]);

  /* 卸载时（真正离开播放页，不随 materialId 重建触发）：等在途上报链全部
   * 落定后失效 home 聚合缓存。声明在上报 effect 之后——卸载 cleanup 按
   * 声明序执行，本 cleanup 运行时上报 effect 的 cleanup 已把终报串入链；
   * 声明在前的话读到的是不含终报的旧链，失效与终报 PUT 并发在途 */
  useEffect(() => {
    return () => {
      void inflightRef.current.then(() => {
        void qc.invalidateQueries({ queryKey: HOME_QUERY_KEY });
      });
    };
  }, [qc]);
}
