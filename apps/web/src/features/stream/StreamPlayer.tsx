'use client';

/**
 * 语流播放器（/stream 连续研习流的核心）
 *
 * 形态：跨材料自动连播的「顺听/磨耳朵」模式——精读播放器的听读精简化：
 * - 队列：全部就绪材料按「最近研习优先」排列（chips 横条，点击切材）
 * - 播放：单 <video>（隐藏，无视觉区）+ 复用 useMediaClock（rAF 时钟/激活句/循环回跳）
 *   与 useProgressReporter（位图进度上报——语流听过同样计入「听过一遍」解锁闯关）
 * - 连播：当前材料 ended → 自动加载队列下一材（从头播）；首材按上次位置续播但不自动播
 *   （浏览器自动播放手势限制），用户点播放后连播不再需要手势
 * - 字幕瀑布：激活句居中滚动，已过句淡出（窗口化渲染），点任意句跳播
 * - 控制：播放/暂停、上一句/下一句、倍速、进度条（点击跳转）
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePlayer } from '@/features/player/store';
import { useMediaClock } from '@/features/player/useMediaClock';
import { useProgressReporter } from '@/features/player/useProgressReporter';
import { PLAYER_RATES, RESUME_SEEK_MIN_MS, clampSeekMs, resolveResumeSeekMs } from '@/features/player/rates';
import { api, type CueDTO, type StreamQueueItem } from '@/lib/api';
import { fmtClock } from '@/lib/format';

/**
 * 语流播放器
 * @param props.queue 语流队列（就绪材料，「最近研习优先」排序）
 */
export function StreamPlayer({ queue }: { queue: StreamQueueItem[] }) {
  /* 当前材料以 id 标识（数组下标只作缺位兜底）：队列按「最近研习优先」排，
   * 本页每 5s 的进度上报恰好刷新排序键——后台 refetch（重连/聚焦）重排队列
   * 时下标会指向另一篇，id 反查下标才能与「顺序稳定性优先」注释对齐 */
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [rateMenu, setRateMenu] = useState(false);
  const mediaRef = useRef<HTMLVideoElement>(null);
  /** 换材定位意图：loadedmetadata 后跳到这里（>500ms 才生效，与精读续播阈值一致） */
  const pendingSeekMs = useRef(0);
  /** 连播意图：ended 接力时置 true，新材就绪即播（首次装载不自动播，等用户手势） */
  const autoPlayNext = useRef(false);
  /** 会话内各材料最新播放头（换材时快照存入）：队列是进页快照且不再 refetch，
   * 点 chip 续播若只看队列 progress 会退回进页时的旧位置（本会话听过的白听） */
  const sessionPosRef = useRef(new Map<number, number>());

  // id 反查下标：当前材料仍 在队列则取新位置（重排跟随）；被移出队列（refetch
  // 缩短/材料删除）则退回上次下标并收敛到有效域；空队列走 hooks 之后的早退
  // 占位（hooks 数量必须稳定，不能提前 return）
  const byId = currentId == null ? -1 : queue.findIndex((q) => q.id === currentId);
  const safeIndex =
    byId >= 0 ? byId : Math.min(fallbackIndex, Math.max(0, queue.length - 1));
  const current = queue[safeIndex];
  const isLast = safeIndex >= queue.length - 1;

  /* 句段（与精读页同 queryKey —— 进语流前听过的话直接命中缓存） */
  const cuesQuery = useQuery({
    queryKey: ['cues', current?.id ?? 0],
    queryFn: () => api<{ cues: CueDTO[] }>(`/api/materials/${current?.id ?? 0}/cues`),
    enabled: current != null,
  });
  // useMemo：空数组稳定引用（否则每次渲染新引用，setCues effect 依赖抖动）
  const cues = useMemo(() => cuesQuery.data?.cues ?? [], [cuesQuery.data]);

  useMediaClock(mediaRef);
  // current 缺位时传 0：上报内部在无 cues 时整体 no-op，不会产生脏写
  useProgressReporter(current?.id ?? 0, mediaRef);

  /* store 订阅（控制条粒度） */
  const isPlaying = usePlayer((s) => s.isPlaying);
  const currentTimeMs = usePlayer((s) => s.currentTimeMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const rate = usePlayer((s) => s.rate);
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);
  const setCues = usePlayer((s) => s.setCues);
  const setActiveCueIndex = usePlayer((s) => s.setActiveCueIndex);
  const setLoopMode = usePlayer((s) => s.setLoopMode);
  const setPlayRange = usePlayer((s) => s.setPlayRange);
  const setRate = usePlayer((s) => s.setRate);
  const setPlaying = usePlayer((s) => s.setPlaying);

  useEffect(() => setCues(cues), [cues, setCues]);

  /* 进入语流：清掉精读页残留的循环/单句区间（store 是模块单例，跨路由存活）；
     首材定位意图仅在首次装载时落定（挂载后 refetch 重排队列不再覆写定位意图） */
  const initialSeekDone = useRef(false);
  useEffect(() => {
    setLoopMode('none');
    setPlayRange(null);
    if (!initialSeekDone.current) {
      initialSeekDone.current = true;
      // 首材定位意图 = 上次研习位置（loadedmetadata 后生效，不自动播）
      pendingSeekMs.current = queue[0]?.progress?.lastPositionMs ?? 0;
    }
  }, [setLoopMode, setPlayRange, queue]);

  /* ---------- 媒体元素属性同步（倍速/音高保持 + 音量/静音，与精读一致）----------
   * store 是模块单例：精读页调过的音量/静音若不同步过来，语流会以浏览器
   * 默认满音量突然开嗓 */
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    m.playbackRate = rate;
    m.volume = volume;
    m.muted = muted;
    type MediaWithPitch = HTMLVideoElement & { preservesPitch?: boolean };
    (m as MediaWithPitch).preservesPitch = true;
  }, [rate, volume, muted, current?.id]);

  /* ---------- 换材/进页：重置单例 store 的时钟与激活句 ----------
   * store 跨路由存活，精读页/上一材料残留的播放头与时长会让新材料控制条
   * 在元数据就绪前显示旧值，也可能混入进度上报快照——换材即归零。
   * resetClock 与进度上报器的进页清残留同一动作单源（含时长的字段集差
   * 由 includeDuration 表达）；原子 set：分次 set 会让订阅者（进度上报）
   * 先看到「旧播放头 + 已清激活句」的中间态，把旧位置误记为新材快照 */
  useEffect(() => {
    usePlayer.getState().resetClock({ includeDuration: true });
  }, [current?.id]);

  /* ---------- 换材后的元数据就绪：定位 + 按意图续播 ---------- */
  const onLoadedMetadata = () => {
    const m = mediaRef.current;
    if (!m) return;
    if (Number.isFinite(m.duration)) usePlayer.getState().setDurationMs(m.duration * 1000);
    if (pendingSeekMs.current > RESUME_SEEK_MIN_MS) {
      /* 贴尾回落（resolveResumeSeekMs）：整篇听完的材料从头重听——否则播
       * 半秒就 ended 又被连播接力带走，chip 看似跳到别的材料 */
      m.currentTime = resolveResumeSeekMs(pendingSeekMs.current, m.duration) / 1000;
    }
    // 消费即清：挂起的定位意图不清理的话，「点 chip 记下续播位置 → 立刻再点
    // 同 chip 从头重听」会被随后的 loadedmetadata 拉回旧意图位置
    pendingSeekMs.current = 0;
    if (autoPlayNext.current) void m.play().catch(() => undefined);
  };

  /* ---------- 连播：当前材料播完 → 队列下一材（从头） ---------- */
  const onEnded = () => {
    if (isLast) {
      usePlayer.getState().setPlaying(false);
      return;
    }
    switchTo(safeIndex + 1, { fromStart: true, autoPlay: true });
  };

  /**
   * 切换到队列中某材料
   * @param i 队列下标
   * @param opts.fromStart 从头播（默认续播上次位置）
   * @param opts.autoPlay 就绪后立即播放（连播接力）
   */
  const switchTo = (i: number, opts?: { fromStart?: boolean; autoPlay?: boolean }) => {
    if (i < 0 || i >= queue.length) return;
    const item = queue[i];
    /* 离开当前材料前快照其播放头（点当前 chip 重听时也会先存——无害） */
    if (current) {
      sessionPosRef.current.set(current.id, usePlayer.getState().currentTimeMs);
    }
    // 点当前材料自己的 chip = 从头重听：src 不变不会再触发 loadedmetadata，
    // 定位意图无处消费——直接定位到 0 并续播（否则按钮看似失灵）；
    // 挂起的旧续播意图一并清掉：元数据迟到的话会把播放头拉回续播位置
    if (item.id === current?.id) {
      const m = mediaRef.current;
      pendingSeekMs.current = 0;
      if (m) {
        m.currentTime = 0;
        void m.play().catch(() => undefined);
      }
      return;
    }
    setFallbackIndex(i);
    setCurrentId(item.id);
    setActiveCueIndex(-1); // 新材激活句未知，先清（防旧 index 索引错位）
    pendingSeekMs.current = opts?.fromStart
      ? 0
      : (sessionPosRef.current.get(item.id) ?? item.progress?.lastPositionMs ?? 0);
    autoPlayNext.current = opts?.autoPlay ?? false;
  };

  /* ---------- 播放控制 ---------- */
  /** 播放/暂停切换 */
  const togglePlay = async () => {
    const m = mediaRef.current;
    if (!m) return;
    if (m.paused) {
      autoPlayNext.current = true; // 用户已交互：后续连播可自动续
      await m.play().catch(() => undefined);
    } else m.pause();
  };
  /** 跳到指定句（点击字幕瀑布/上下句共用） */
  const seekCue = (i: number) => {
    const m = mediaRef.current;
    const cue = cues[i];
    if (!m || !cue) return;
    m.currentTime = cue.startMs / 1000 + 0.01;
    void m.play().catch(() => undefined);
  };
  /**
   * 跳到上/下一句（与精读页 seekSentence 同款）：激活句为 -1（句间间隙/
   * 首句前/片尾）时以「起点不晚于当前位置的最后一句」为基准再 ±1，否则
   * 直接 ±1 会双双算出 0 跳回首句
   * @param dir 方向：-1 上一句 / 1 下一句
   */
  const seekSentence = (dir: 1 | -1) => {
    const m = mediaRef.current;
    if (!m) return;
    let base = activeCueIndex;
    if (base < 0) {
      const t = m.currentTime * 1000;
      for (let k = cues.length - 1; k >= 0; k--) {
        if (cues[k]!.startMs <= t) {
          base = k;
          break;
        }
      }
    }
    seekCue(Math.min(cues.length - 1, Math.max(0, base + dir)));
  };
  /** 进度条点击跳转 */
  const onScrubClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const m = mediaRef.current;
    const raw = m?.duration;
    const d = durationMs || (raw != null && Number.isFinite(raw) ? raw * 1000 : 0);
    if (!m || d <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    /* 贴尾钳取与续播路径同一助手：点进度条右缘会落到恰好 duration，ended
       抢在尾音播出前触发、连播立即切下一材（末尾秒数被吞且不进位图） */
    m.currentTime = clampSeekMs(((e.clientX - rect.left) / rect.width) * d, m.duration) / 1000;
  };

  /* ---------- 字幕瀑布：激活句居中滚动 ---------- */
  const activeSentenceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeSentenceRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeCueIndex]);

  const duration = durationMs || 1;
  // 窗口：激活句前 5 句（淡出历史）后 2 句（预读）
  const winStart = Math.max(0, (activeCueIndex >= 0 ? activeCueIndex : 0) - 5);
  const winEnd = Math.min(cues.length, Math.max(8, (activeCueIndex >= 0 ? activeCueIndex : 0) + 3));
  const windowCues = cues.slice(winStart, winEnd);

  // 空队列占位（hooks 全部执行完之后的早退——hooks 数量不能随渲染变化）
  if (!current) {
    return <div className="p-10 text-center text-sm text-muted-foreground">语流队列为空</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col px-3 pb-6 pt-3 md:px-8 md:pt-6">
      {/* 隐藏媒体元素（size-0 保 DOM 存活；音频/视频统一走 /api/media 流） */}
      <video
        ref={mediaRef}
        src={`/api/media/${current.id}`}
        onLoadedMetadata={onLoadedMetadata}
        onEnded={onEnded}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        playsInline
        preload="auto"
        className="pointer-events-none absolute size-0 opacity-0"
      />

      {/* ===== 头部：当前材料 + 去精读入口 ===== */}
      <header className="mb-1 flex items-baseline gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{current.collectionName}</p>
          <h1 className="truncate font-serif text-lg leading-tight md:text-xl">{current.title}</h1>
        </div>
        <Link
          href={`/material/${current.id}`}
          className="ml-auto shrink-0 rounded-md border border-ochre/40 px-2.5 py-1 text-xs text-ochre"
        >
          去精读 →
        </Link>
      </header>

      {/* ===== 队列 chips（横向滚动，点击换材） ===== */}
      <nav className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        {queue.map((item, i) => (
          /* 点 chip 换材：默认接上次研习位置续播（与队列「最近研习优先」语义
             一致）；点前正在播则接力自动播——否则 src 换载会静默停住，用户
             还得再点一次播放 */
          <button
            key={item.id}
            onClick={() => switchTo(i, { autoPlay: usePlayer.getState().isPlaying })}
            className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors ${
              item.id === current?.id
                ? 'bg-primary text-primary-foreground'
                : 'border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {/* 听过一遍的材料打勾标记 */}
            {item.progress?.listenedThrough && (
              <span className="material-symbols-outlined text-sm">check_circle</span>
            )}
            <span className="max-w-36 truncate">{item.title}</span>
          </button>
        ))}
      </nav>

      {/* ===== 字幕瀑布（滚动主体；确定视口高度内部滚动，上下边缘渐隐遮罩） ===== */}
      <div
        className="relative h-[48dvh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:h-[60dvh] [mask-image:linear-gradient(to_bottom,transparent,black_12%,black_88%,transparent)]"
      >
        <div className="flex min-h-full flex-col justify-center gap-4 py-10">
          {(() => {
            /* 三态早返回（装载中/失败可重试/瀑布），不嵌套三元 */
            if (cuesQuery.isLoading) {
              return <p className="text-center text-sm text-muted-foreground">字幕装载中…</p>;
            }
            if (cuesQuery.isError && !cuesQuery.data) {
              /* 装载失败可见可重试：静默空白会让用户以为该材料没有字幕 */
              return (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <p className="text-sm text-muted-foreground">字幕装载失败</p>
                  <button
                    type="button"
                    onClick={() => void cuesQuery.refetch()}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    重试
                  </button>
                </div>
              );
            }
            return windowCues.map((cue) => {
              const active = cue.index === activeCueIndex;
              const past = activeCueIndex >= 0 && cue.index < activeCueIndex;
              return (
                /* 单句卡片：当前句浓墨大字 + 朱砂左线；已过句淡出；点击跳播 */
                <div
                  key={cue.id}
                  ref={active ? activeSentenceRef : undefined}
                  onClick={() => seekCue(cue.index)}
                  className={`cursor-pointer rounded-md border-l-4 px-3 py-1 transition-colors ${
                    active
                      ? 'border-primary bg-card'
                      : past
                        ? 'border-transparent opacity-40 hover:opacity-70'
                        : 'border-transparent opacity-75 hover:opacity-100'
                  }`}
                >
                  <p className={`font-serif leading-relaxed ${active ? 'text-xl md:text-2xl' : 'text-base md:text-lg'}`}>
                    {cue.textEn}
                  </p>
                  {/* 中文译文（无译文材料不渲染） */}
                  {cue.textZh && (
                    <p className={`mt-1 text-sm leading-relaxed ${active ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {cue.textZh}
                    </p>
                  )}
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* ===== 控制条（常驻：语流是顺听模式，不套用精读页的渐隐策略） ===== */}
      <div className="mt-3 space-y-2">
        {/* 进度条 + 时间 */}
        <div className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <span>{fmtClock(currentTimeMs)}</span>
          {/* 可点击进度条：当前材料内跳转 */}
          <div onClick={onScrubClick} className="h-1.5 flex-1 cursor-pointer overflow-hidden rounded-full bg-border">
            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${(currentTimeMs / duration) * 100}%` }} />
          </div>
          <span>{fmtClock(durationMs)}</span>
        </div>
        {/* 按钮组 */}
        <div className="flex items-center justify-center gap-2">
          {/* 上一句 */}
          <button
            onClick={() => seekSentence(-1)}
            aria-label="上一句"
            className="flex size-10 items-center justify-center rounded-full text-foreground hover:bg-accent"
          >
            <span className="material-symbols-outlined text-2xl">skip_previous</span>
          </button>
          {/* 播放/暂停（朱砂主按钮） */}
          <button
            onClick={() => void togglePlay()}
            aria-label={isPlaying ? '暂停' : '播放'}
            className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <span className="material-symbols-outlined text-3xl">{isPlaying ? 'pause' : 'play_arrow'}</span>
          </button>
          {/* 下一句（队尾时钳到末句重播） */}
          <button
            onClick={() => seekSentence(1)}
            aria-label="下一句"
            className="flex size-10 items-center justify-center rounded-full text-foreground hover:bg-accent"
          >
            <span className="material-symbols-outlined text-2xl">skip_next</span>
          </button>
          {/* 倍速菜单 */}
          <div className="relative ml-2">
            <button
              onClick={() => setRateMenu((v) => !v)}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs tabular-nums text-foreground"
            >
              {rate}x
            </button>
            {/* 倍速档位弹出层 */}
            {rateMenu && (
              <div className="absolute bottom-10 right-0 z-10 w-20 overflow-hidden rounded-md border bg-card shadow-sm">
                {PLAYER_RATES.map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      setRate(r);
                      setRateMenu(false);
                    }}
                    className={`block w-full px-3 py-2 text-left text-xs tabular-nums hover:bg-accent ${
                      r === rate ? 'font-medium text-primary' : 'text-foreground'
                    }`}
                  >
                    {r}x
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* 队列位置提示 */}
        <p className="text-center text-[11px] text-muted-foreground">
          语流第 {safeIndex + 1} / {queue.length} 卷{isLast ? ' · 已到队尾' : ''}
        </p>
      </div>
    </div>
  );
}
