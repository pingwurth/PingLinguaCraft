'use client';

/**
 * 播放器组件（需求 6/16 全部行为）
 *
 * - 单 <video> 元素承载音频/视频（视频区覆盖 HTML 字幕层，不用 <track>——需要交互）
 * - 控制条：桌面 mouseEnter 显示、mouseLeave 1s 后渐隐；移动点按切换、播放中 3s 自动隐藏
 * - 播放控制：播放/暂停、±5s、上下句、进度条（拖拽/A-B 高亮/缓冲区）、倍速、音量、
 *   单句循环、A-B 打点、整集循环、字幕模式切换
 * - 键盘（桌面）：空格播放/暂停、←/→ ±5s、Shift+←/→ 上下句、↑/↓ 音量、
 *   L 单句循环、A 打点
 * - 点词朗读：pendingSpeak 消费（新 Audio 播 /api/media/tts）
 * - 进度上报：5s 防抖 + pagehide → PUT /api/materials/[id]/progress（位图 listened_mask）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayer } from './store';
import { useMediaClock } from './useMediaClock';
import { PLAYER_RATES, RESUME_SEEK_MIN_MS, clampSeekMs, resolveResumeSeekMs } from './rates';
import { useProgressReporter } from './useProgressReporter';
import type { CueDTO, MaterialDetail } from '@/lib/api';
import { ttsAudioUrl } from '@/lib/ttsUrl';

/**
 * 播放器
 * @param props.material 材料详情（mediaMime 判断音视频）
 * @param props.cues     句段列表
 * @param props.initialPositionMs 续播位置
 */
export function Player({
  material,
  cues,
  initialPositionMs,
}: {
  material: MaterialDetail;
  cues: CueDTO[];
  initialPositionMs: number;
}) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [rateMenu, setRateMenu] = useState(false);
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  useMediaClock(mediaRef);

  // store 订阅（控制条重渲染友好粒度）
  const isPlaying = usePlayer((s) => s.isPlaying);
  const currentTimeMs = usePlayer((s) => s.currentTimeMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const bufferedRatio = usePlayer((s) => s.bufferedRatio);
  const rate = usePlayer((s) => s.rate);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const loopMode = usePlayer((s) => s.loopMode);
  const abRange = usePlayer((s) => s.abRange);
  const subtitleMode = usePlayer((s) => s.subtitleMode);
  const controlsVisible = usePlayer((s) => s.controlsVisible);
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);
  const pendingSpeak = usePlayer((s) => s.pendingSpeak);

  const setCues = usePlayer((s) => s.setCues);
  const setControlsVisible = usePlayer((s) => s.setControlsVisible);

  const isVideo = (material.mediaMime ?? '').startsWith('video/');
  const activeCue = activeCueIndex >= 0 ? cues[activeCueIndex] : null;

  useEffect(() => setCues(cues), [cues, setCues]);

  // 进播放页强制关闭字幕（store 是模块单例，上次会话/上个材料手动开启的状态不跨材料延续）
  useEffect(() => {
    usePlayer.setState({ subtitleMode: 'off' });
  }, []);

  /* ---------- 媒体元素属性同步 ---------- */
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    m.playbackRate = rate;
    // preservesPitch：慢速跟读时保持音高（否则男声变怪兽）
    type MediaWithPitch = HTMLVideoElement & { preservesPitch?: boolean };
    (m as MediaWithPitch).preservesPitch = true;
    m.volume = volume;
    m.muted = muted;
  }, [rate, volume, muted]);

  /* 未消化的定位值：详情/进度先到、音频元数据后到时续播 effect 扑空（duration
     仍 NaN），暂存到 loadedmetadata 补跳——否则续播与 ?t= 深链都可能停在 0 */
  const pendingSeekRef = useRef(0);

  /* ---------- 整集循环（ended 事件）---------- */
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    const onEnded = () => {
      if (usePlayer.getState().loopMode === 'episode') {
        m.currentTime = 0;
        void m.play();
      } else {
        usePlayer.getState().setPlaying(false);
      }
    };
    const onPlay = () => usePlayer.getState().setPlaying(true);
    const onPause = () => usePlayer.getState().setPlaying(false);
    const onMeta = () => {
      const d = m.duration;
      if (Number.isFinite(d)) {
        usePlayer.getState().setDurationMs(d * 1000);
        // 元数据就绪后补跳暂存的定位值（详情先到、元数据后到的竞态）；
        // resolveResumeSeekMs 与续播 effect 同一助手（夹取 + 贴尾回落从头）
        if (pendingSeekRef.current > RESUME_SEEK_MIN_MS) {
          m.currentTime = resolveResumeSeekMs(pendingSeekRef.current, d) / 1000;
          pendingSeekRef.current = 0;
        }
      }
    };
    m.addEventListener('ended', onEnded);
    m.addEventListener('play', onPlay);
    m.addEventListener('pause', onPause);
    m.addEventListener('loadedmetadata', onMeta);
    return () => {
      m.removeEventListener('ended', onEnded);
      m.removeEventListener('play', onPlay);
      m.removeEventListener('pause', onPause);
      m.removeEventListener('loadedmetadata', onMeta);
    };
  }, []);

  /* ---------- 续播定位（每材只消费一次） ---------- */
  /** 已消费续播定位的材料 id：initialPositionMs 来自本页进度查询，而进度查询
      的数据正是播放器自己 5s 一报的 PUT——播放中重连触发的 refetch 会把位置
      刷新成刚上报的值，不隔离的话 effect 重跑会把播放头拉回几秒前 */
  const appliedResumeRef = useRef<number | null>(null);
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    /* 先标记后判定：Player 只在 detail.data 就绪后渲染，首个 initialPositionMs
       即真值——「从零开播」的材料走下方早返回若不记账，播放中重连 refetch 把
       位置抬过阈值后守卫判「未消费」仍会二次 seek，正是要防的回跳 */
    const applied = appliedResumeRef.current === material.id;
    appliedResumeRef.current = material.id;
    if (applied) return;
    /* 低于阈值的定位意图视同从头播：显式清掉挂起值——详情命中缓存时组件不
       重挂载，上一轮的 pendingSeek 会在新材料的 loadedmetadata 补跳到无关位置 */
    if (initialPositionMs <= RESUME_SEEK_MIN_MS) {
      pendingSeekRef.current = 0;
      return;
    }
    if (Number.isFinite(m.duration)) {
      pendingSeekRef.current = 0;
      // 夹取与 onMeta 补跳同一助手：重导入后时长变短的材料，续播位置不至于越界
      m.currentTime = resolveResumeSeekMs(initialPositionMs, m.duration) / 1000;
    } else {
      pendingSeekRef.current = initialPositionMs;
    }
    // material.id 入依赖：缓存命中不重挂载时前后两材定位值可能相同（都续播
    // 自 20s），effect 不重跑会让新材的定位意图丢失（从 0 开始）
  }, [initialPositionMs, material.id]);

  /* ---------- 控制条渐隐策略（需求 6）---------- */
  const armHide = useCallback((delayMs: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => usePlayer.getState().setControlsVisible(false), delayMs);
  }, []);
  const showControls = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setControlsVisible(true);
  }, [setControlsVisible]);

  useEffect(() => {
    // 播放中自动隐藏；暂停/结束常显
    if (isPlaying) armHide(3000);
    else showControls();
  }, [isPlaying, armHide, showControls]);

  /** 媒体区点击/点按：移动端切换控制条；桌面单击切换播放（双击全屏留给后续） */
  const onSurfaceClick = () => {
    const s = usePlayer.getState();
    if (s.controlsVisible) {
      // 已可见：点按=切换播放（移动端习惯）；再起 3s 隐藏计时
      void togglePlay();
    } else {
      showControls();
      armHide(3000);
    }
  };

  /** 播放/暂停切换 */
  const togglePlay = async () => {
    const m = mediaRef.current;
    if (!m) return;
    if (m.paused) await m.play().catch(() => undefined);
    else m.pause();
  };

  /* ---------- 跨组件播放控制桥（精读/工坊通过 window 事件驱动媒体元素）---------- */
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    /** 用户主动跳播：清空单句区间（残留会让正常播放在旧句尾意外自停） */
    const onSeek = (e: Event) => {
      usePlayer.getState().setPlayRange(null);
      const ms = (e as CustomEvent<number>).detail;
      m.currentTime = ms / 1000 + 0.01;
      void m.play().catch(() => undefined);
    };
    /** 暂停事件（点词朗读前调用，需求 8）——同时放弃单句区间 */
    const onPause = () => {
      usePlayer.getState().setPlayRange(null);
      m.pause();
    };
    /** 单句播放事件（听写/跟读「听原文」）：detail = {startMs, endMs}
     *  进入单句播放必须退出循环模式：循环回跳先于区间终点触发，
     *  「听一次」会被循环回跳劫持成无限循环 */
    const onPlayRange = (e: Event) => {
      const range = (e as CustomEvent<{ startMs: number; endMs: number }>).detail;
      const s = usePlayer.getState();
      s.setLoopMode('none');
      s.setPlayRange(range);
      m.currentTime = range.startMs / 1000 + 0.01;
      void m.play().catch(() => undefined);
    };
    window.addEventListener('pinglc:seek', onSeek);
    window.addEventListener('pinglc:pause', onPause);
    window.addEventListener('pinglc:play-range', onPlayRange);
    return () => {
      window.removeEventListener('pinglc:seek', onSeek);
      window.removeEventListener('pinglc:pause', onPause);
      window.removeEventListener('pinglc:play-range', onPlayRange);
      // 卸载清空（store 是模块单例，不清理会跨材料泄漏）
      usePlayer.getState().setPlayRange(null);
    };
  }, []);

  /* ---------- 键盘快捷键（桌面）---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const m = mediaRef.current;
      const s = usePlayer.getState();
      if (!m) return;
      // Shift+←/→：上/下一句（工坊与精读的句级导航）。必须先于下方 switch 判定：
      // e.key 不携带修饰键（箭头键按住 Shift 后 key 仍是 'ArrowLeft'/'ArrowRight'），
      // 先进 switch 会被 ±5s 的 case 截胡，句级导航永远轮不到
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        seekSentence(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      switch (e.key) {
        case ' ':
          e.preventDefault();
          void togglePlay();
          break;
        case 'ArrowLeft':
          m.currentTime = Math.max(0, m.currentTime - 5);
          break;
        case 'ArrowRight':
          m.currentTime = Math.min(m.duration || 0, m.currentTime + 5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          s.setVolume(Math.min(1, s.volume + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          s.setVolume(Math.max(0, s.volume - 0.1));
          break;
        case 'l':
        case 'L':
          s.setLoopMode(s.loopMode === 'sentence' ? 'none' : 'sentence');
          break;
        case 'a':
        case 'A': {
          // A 打点 → B 打点 → 成环
          if (s.loopMode !== 'ab') {
            s.setLoopMode('ab');
            s.setAB({ a: m.currentTime * 1000, b: 0 });
          } else if (s.abRange && !s.abRange.b) {
            s.setAB({ a: s.abRange.a, b: m.currentTime * 1000 });
          } else {
            s.setLoopMode('none');
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- 点词朗读消费（版本化 URL：档案切换后不命中旧音色缓存） ---------- */
  useEffect(() => {
    if (!pendingSpeak) return;
    void ttsAudioUrl(pendingSpeak.text).then((u) => {
      new Audio(u).play().catch(() => undefined);
    });
    usePlayer.getState().clearPendingSpeak();
  }, [pendingSpeak]);

  /* ---------- 进度上报（5s 防抖 + pagehide；位图逐句标记，与语流页共用）---------- */
  useProgressReporter(material.id, mediaRef);

  /* ---------- 进度条拖拽 ---------- */
  const duration = durationMs || 1;
  const onScrubPointerDown = (e: React.PointerEvent) => {
    const el = scrubRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    setScrubbing(e.clientX);
  };
  const onScrubPointerMove = (e: React.PointerEvent) => {
    if (scrubbing === null) return;
    setScrubbing(e.clientX);
  };
  const onScrubPointerUp = (e: React.PointerEvent) => {
    if (scrubbing === null) return;
    const el = scrubRef.current;
    setScrubbing(null);
    if (!el || !mediaRef.current) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    // 手动拖拽 = 用户接管播放：放弃单句区间（否则残留区间会在旧句尾意外自停）
    usePlayer.getState().setPlayRange(null);
    // 贴尾钳取与语流拖动/续播同源：拖到右缘落在恰好 duration 会立刻触发
    // ended（整集循环下直接跳回 0 重播），尾音被吞——此处只钳尾不回落从头
    mediaRef.current.currentTime = clampSeekMs(ratio * duration, mediaRef.current.duration) / 1000;
  };
  const scrubRatio = useMemo(() => {
    if (scrubbing === null || !scrubRef.current) return null;
    const rect = scrubRef.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (scrubbing - rect.left) / rect.width));
  }, [scrubbing]);

  /** 秒 → mm:ss 显示 */
  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const progressRatio = scrubRatio ?? currentTimeMs / duration;
  const abLeft = abRange ? (abRange.a / duration) * 100 : 0;
  const abWidth = abRange?.b ? ((abRange.b - abRange.a) / duration) * 100 : 0;

  return (
    /* 播放器区块：媒体面 + 控制条（sticky 移动端顶部） */
    <div className="deckle relative overflow-hidden rounded-md border bg-card md:rounded-lg">
      {/* 媒体面：视频满宽；音频时衬纸面 + 波形占位 */}
      <div
        className="relative"
        onMouseEnter={() => window.matchMedia('(hover:hover)').matches && showControls()}
        onMouseLeave={() =>
          window.matchMedia('(hover:hover)').matches && armHide(1000)
        } // 需求 6：离开 1s 后渐隐
        onClick={onSurfaceClick}
      >
        {/* video 元素：音频材料同样用它（无画面），playsinline 防移动端自动全屏 */}
        <video
          ref={mediaRef}
          src={`/api/media/${material.id}`}
          className={isVideo ? 'max-h-[56vh] w-full bg-black' : 'hidden'}
          playsInline
          preload="metadata"
        />
        {/* 音频材料的衬面：衬线大字标题 + 纸面 */}
        {!isVideo && (
          <div className="flex h-28 items-center justify-center bg-muted/40 px-6 md:h-36">
            <p className="font-serif text-lg text-muted-foreground">{material.title}</p>
          </div>
        )}

        {/* 字幕覆盖层（HTML，可交互；模式由 store 决定） */}
        {subtitleMode !== 'off' && activeCue && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-4">
            <div className="max-w-full rounded bg-black/55 px-3 py-1.5 text-center backdrop-blur-[1px]">
              {subtitleMode !== 'zh' && (
                <p className="text-sm leading-snug text-white md:text-base">{activeCue.textEn}</p>
              )}
              {subtitleMode !== 'en' && activeCue.textZh && (
                <p className="text-xs leading-snug text-white/85 md:text-sm">{activeCue.textZh}</p>
              )}
            </div>
          </div>
        )}

        {/* 控制条（渐隐：需求 6 的 opacity 过渡） */}
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pb-2 pt-6 transition-opacity duration-300 ${
            controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 进度条：缓冲区 + A-B 高亮 + 播放头；句刻度 M2 */}
          <div
            ref={scrubRef}
            className="group relative h-6 cursor-pointer touch-none"
            onPointerDown={onScrubPointerDown}
            onPointerMove={onScrubPointerMove}
            onPointerUp={onScrubPointerUp}
          >
            {/* 轨道 */}
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25">
              {/* 缓冲区 */}
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-white/35"
                style={{ width: `${bufferedRatio * 100}%` }}
              />
              {/* A-B 区间高亮（朱砂） */}
              {abWidth > 0 && (
                <div
                  className="absolute inset-y-0 rounded-full bg-[#b91c1c]"
                  style={{ left: `${abLeft}%`, width: `${abWidth}%` }}
                />
              )}
              {/* 已播放 */}
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-white"
                style={{ width: `${progressRatio * 100}%` }}
              />
            </div>
            {/* 播放头圆点 */}
            <div
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
              style={{ left: `${progressRatio * 100}%` }}
            />
          </div>

          {/* 按钮排：移动 5 个核心 + 桌面全量 */}
          <div className="flex items-center gap-1 text-white">
            {/* 播放/暂停 */}
            <button aria-label="播放/暂停" onClick={() => void togglePlay()} className="flex size-10 items-center justify-center">
              <span className="material-symbols-outlined text-2xl">
                {isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            {/* 上一句 / 下一句 */}
            <button
              aria-label="上一句"
              onClick={() => seekSentence(-1)}
              className="hidden size-10 items-center justify-center md:flex"
            >
              <span className="material-symbols-outlined text-xl">skip_previous</span>
            </button>
            <button
              aria-label="下一句"
              onClick={() => seekSentence(1)}
              className="hidden size-10 items-center justify-center md:flex"
            >
              <span className="material-symbols-outlined text-xl">skip_next</span>
            </button>
            {/* 时间显示 */}
            <span className="ml-1 text-xs tabular-nums text-white/90">
              {fmt(scrubRatio !== null ? scrubRatio * duration : currentTimeMs)} / {fmt(durationMs)}
            </span>
            <div className="flex-1" />
            {/* 单句循环（朱砂高亮） */}
            <button
              aria-label="单句循环"
              onClick={() => usePlayer.getState().setLoopMode(loopMode === 'sentence' ? 'none' : 'sentence')}
              className={`flex size-10 items-center justify-center ${loopMode === 'sentence' ? 'text-[#ff8f8f]' : ''}`}
            >
              <span className="material-symbols-outlined text-xl">repeat_one</span>
            </button>
            {/* A-B 打点/循环 */}
            <button
              aria-label="A-B 循环"
              onClick={handleAB}
              className={`flex size-10 items-center justify-center text-xs font-medium ${
                loopMode === 'ab' ? 'text-[#ff8f8f]' : ''
              }`}
            >
              {loopMode === 'ab' && !abRange?.b ? 'B?' : 'A·B'}
            </button>
            {/* 整集循环 */}
            <button
              aria-label="整集循环"
              onClick={() => usePlayer.getState().setLoopMode(loopMode === 'episode' ? 'none' : 'episode')}
              className={`flex size-10 items-center justify-center ${loopMode === 'episode' ? 'text-[#ff8f8f]' : ''}`}
            >
              <span className="material-symbols-outlined text-xl">repeat</span>
            </button>
            {/* 字幕模式切换 */}
            <button
              aria-label="字幕模式"
              onClick={() => usePlayer.getState().cycleSubtitleMode()}
              className="flex size-10 items-center justify-center text-[11px] font-semibold"
            >
              {subtitleMode === 'bilingual' ? '双语' : subtitleMode === 'en' ? 'EN' : subtitleMode === 'zh' ? '中' : '关'}
            </button>
            {/* 倍速（弹出档位） */}
            <div className="relative">
              <button
                aria-label="倍速"
                onClick={() => setRateMenu((v) => !v)}
                className="flex h-10 min-w-12 items-center justify-center text-xs font-semibold"
              >
                {rate}x
              </button>
              {rateMenu && (
                <div className="deckle absolute bottom-12 right-0 z-10 flex flex-col rounded-md border bg-background py-1 text-foreground shadow-lg">
                  {PLAYER_RATES.map((r) => (
                    <button
                      key={r}
                      onClick={() => {
                        usePlayer.getState().setRate(r);
                        setRateMenu(false);
                      }}
                      className={`px-4 py-1.5 text-left text-xs ${r === rate ? 'font-bold text-primary' : ''}`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* 音量（桌面） */}
            <div className="hidden items-center md:flex">
              <button aria-label="静音" onClick={() => usePlayer.getState().toggleMute()} className="flex size-10 items-center justify-center">
                <span className="material-symbols-outlined text-xl">
                  {muted || volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'}
                </span>
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => usePlayer.getState().setVolume(Number(e.target.value))}
                aria-label="音量"
                className="w-20 accent-[#b91c1c]"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  /** 跳到上/下一句（控制条按钮与 Shift+←/→ 共用；单句循环下循环目标随新句迁移） */
  function seekSentence(dir: 1 | -1): void {
    const m = mediaRef.current;
    const s = usePlayer.getState();
    if (!m) return;
    let base = s.activeCueIndex;
    if (base < 0) {
      // 播放位置在句间间隙/材料首尾（激活句 -1）：以「起点不晚于当前位置的
      // 最后一句」为基准。单句循环跟随播放位置后，拖进度条可停进间隙/片尾，
      // 此时从 -1 直接 ±1 会错跳（如拖到片尾点「下一句」蹦回首句）
      const t = m.currentTime * 1000;
      for (let k = s.cues.length - 1; k >= 0; k--) {
        if (s.cues[k]!.startMs <= t) {
          base = k;
          break;
        }
      }
    }
    const target = Math.min(s.cues.length - 1, Math.max(0, base + dir));
    const cue = s.cues[target];
    if (cue) {
      m.currentTime = cue.startMs / 1000 + 0.01;
      void m.play().catch(() => undefined);
    }
  }

  /** A-B 打点状态机：进入 → A 定 → B 定 → 退出 */
  function handleAB(): void {
    const s = usePlayer.getState();
    const m = mediaRef.current;
    if (!m) return;
    if (s.loopMode !== 'ab') {
      s.setLoopMode('ab');
      s.setAB({ a: m.currentTime * 1000, b: 0 });
    } else if (!s.abRange?.b) {
      const b = m.currentTime * 1000;
      s.setAB({ a: Math.min(s.abRange!.a, b), b: Math.max(s.abRange!.a, b) });
    } else {
      s.setLoopMode('none');
    }
  }
}
