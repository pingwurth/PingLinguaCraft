'use client';

/**
 * 首页 —— 藏经阁（需求 19：导入材料汇聚地；设计稿 _12 移动 / _10 桌面）
 *
 * - 续研书签（移动）：最近停留的材料 + 停留句引文 + 进度 + 即刻续研
 * - 快速导入（移动）：粘贴链接就地萃取（复用 /api/import/link），展开可选拟归卷；
 *   本地文件 / 文本导入引导去 /import 向导
 * - 统计卡网格 + 流转动向（桌面）：卷帙/材料/句段/生词四卡与最近活跃材料
 * - 集卷卡列表（双端）：封面活字印模 + 研读进度 + 轻筛选（全部/最近研习/未开卷；
 *   现库无分类维度，设计稿的分类 pills 降级为基于进度数据的三档）
 * - 另辟新卷：内联建卷表单（失败可见）
 * 数据：GET /api/home 一次聚合（类型见 features/home/types.ts）
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HomeCollection, HomeData } from '@/features/home/types';

/** 轻筛选档位：全部卷帙 / 最近研习 / 未开卷 */
type Filter = 'all' | 'recent' | 'fresh';

/**
 * ms → 「x 小时 y 分」展示
 * @param ms 毫秒时长
 */
function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分`;
  return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
}

/**
 * epoch ms → 相对时间（刚刚 / N分钟前 / N小时前 / N天前 / M月D日）
 * @param ms epoch 毫秒
 */
function fmtRelative(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 整数千分位展示（统计卡大数）
 * @param n 整数
 */
function fmtInt(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 来源类型 → 图标名（流动动向条目用；未知类型回退耳机） */
const SOURCE_ICON: Record<string, string> = {
  video: 'smart_display',
  audio: 'headphones',
  text: 'text_snippet',
  link: 'link',
};

/** 字幕状态 → 展示文案 */
const STATUS_TEXT: Record<string, string> = {
  ready: '双语已就绪',
  processing: '解析中',
  failed: '解析失败',
  none: '待处理',
};

/**
 * 首页组件：藏经阁
 */
export default function HomePage() {
  const qc = useQueryClient();
  const router = useRouter();
  /* 建卷表单状态 */
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  /* 轻筛选档位 */
  const [filter, setFilter] = useState<Filter>('all');
  /* 快速导入：链接输入 / 拟归卷 / 展开态 / 提交错误 */
  const [linkUrl, setLinkUrl] = useState('');
  const [importCollectionId, setImportCollectionId] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  /* 首页聚合数据（一次请求供全页） */
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/api/home') });

  const data = home.data;
  // memo 兜底空数组：保证 useMemo(筛选) 依赖引用稳定（未加载时不产生新数组）
  const collections = useMemo(() => data?.collections ?? [], [data]);
  const recentCount = collections.filter((c) => c.lastStudiedAt != null).length;
  const freshCount = collections.filter((c) => c.progressPct === 0).length;

  /* 建卷（成功后失效首页聚合缓存刷新列表） */
  const create = useMutation({
    mutationFn: () =>
      api<{ id: number }>('/api/collections', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setCreating(false);
      setName('');
      setCreateError(null);
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
    // 创建失败必须可见（静默复位会让用户无从得知失败原因）
    onError: (err) => setCreateError(err.message),
  });

  /* 快速导入：就地提交链接导入；202 后进材料页（页内 ProcessingPanel 展示解析进度） */
  const quickImport = useMutation({
    mutationFn: (collectionId: number) =>
      api<{ materialId: number; jobId: string }>('/api/import/link', {
        method: 'POST',
        body: JSON.stringify({ url: linkUrl.trim(), collectionId }),
      }),
    onSuccess: (r) => router.push(`/material/${r.materialId}`),
    onError: (err) => setImportError(err.message),
  });

  /** 提交快速导入：未选卷取第一卷；空链接/无卷先拦截提示 */
  const submitQuickImport = () => {
    if (!linkUrl.trim()) {
      setImportError('请先粘贴音视频链接');
      return;
    }
    const cid = importCollectionId || collections[0]?.id;
    if (!cid) {
      setImportError('请先另辟新卷，再导入材料');
      return;
    }
    setImportError(null);
    quickImport.mutate(cid);
  };

  /* 轻筛选：全部 / 最近研习（按最近研习时间降序）/ 未开卷（进度 0） */
  const filtered = useMemo<HomeCollection[]>(() => {
    if (filter === 'recent') {
      return collections
        .filter((c) => c.lastStudiedAt != null)
        .sort((a, b) => (b.lastStudiedAt ?? 0) - (a.lastStudiedAt ?? 0));
    }
    if (filter === 'fresh') return collections.filter((c) => c.progressPct === 0);
    return collections;
  }, [collections, filter]);

  return (
    /* 页面容器：外边距遵循设计系统 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-10 md:py-10">
      {home.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : home.isError ? (
        /* 查询失败 ≠ 空库：落到空态会误导用户以为数据丢失 */
        <p className="py-16 text-center text-sm text-destructive">
          藏经阁装载失败：{home.error.message}
        </p>
      ) : data ? (
        <>
          {/* ===== 页头（移动版，仿 _12）：竖条标题 + 收录戳记 + 引文 ===== */}
          <header className="mb-5 md:hidden">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {/* 朱砂竖条（书签绦带意象） */}
                <span aria-hidden className="inline-block h-4 w-1.5 rounded-sm bg-primary" />
                <h2 className="font-serif text-2xl tracking-wide">藏经阁</h2>
                <span className="pl-0.5 text-[11px] tracking-widest text-muted-foreground">
                  材料汇聚
                </span>
              </div>
              {/* 朱砂戳记：收录规模 */}
              <span className="flex shrink-0 items-center gap-1 rounded-sm bg-primary/10 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-primary">
                <span className="material-symbols-outlined text-[13px]">history_edu</span>
                已收录 {data.stats.collectionCount} 集 · {data.stats.materialCount} 篇
              </span>
            </div>
            {/* 文人引文 */}
            <p className="mt-2 font-serif text-xl italic tracking-tight text-muted-foreground">
              「墨香生卷帙，语韵入深林。」
            </p>
          </header>

          {/* ===== 页头（桌面版，仿 _10）：卷首抬头 + 快捷动作组 ===== */}
          <header className="mb-10 hidden md:block">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="max-w-2xl">
                {/* 卷首小签 */}
                <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] uppercase tracking-widest text-muted-foreground">
                  藏经阁 · 聚纳百卷
                </span>
                {/* 大标题与引文 */}
                <h2 className="mt-3 font-serif text-4xl tracking-tight">藏经阁 · 材料汇聚文库</h2>
                <p className="mt-2 font-serif text-lg italic text-muted-foreground">
                  「学自己想学的 · 纳四海音视频，化案头研磨卷。」
                </p>
              </div>
              {/* 快捷动作组 */}
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/import"
                  className="deckle flex items-center gap-2 rounded-md border bg-card px-4 py-2.5 text-sm transition-colors hover:bg-accent"
                >
                  <span className="material-symbols-outlined text-lg text-primary">
                    cloud_download
                  </span>
                  导入影音 / 文献
                </Link>
                <button
                  onClick={() => setCreating((v) => !v)}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
                >
                  <span className="material-symbols-outlined text-lg">bookmark_add</span>
                  另辟新案 · 新建材料集
                </button>
              </div>
            </div>
          </header>

          {/* ===== 续研书签（移动，仿 _12）：最近停留 + 即刻续研 ===== */}
          {data.resume ? (
            <section className="deckle mb-4 rounded-md border bg-card p-4 md:hidden">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-secondary">
                  <span className="material-symbols-outlined animate-pulse text-base">
                    timelapse
                  </span>
                  续研书签 · 最近停留
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {fmtRelative(data.resume.updatedAt)}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-serif text-base">{data.resume.materialTitle}</h3>
                  <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">
                    已精读至{' '}
                    <span className="font-semibold text-primary">
                      第 {data.resume.maxCueIndex + 1} 句
                    </span>{' '}
                    / 共 {data.resume.cueCount} 句
                    {data.resume.lastCueText && <> · 「{data.resume.lastCueText}」</>}
                  </p>
                </div>
                {/* 即刻续研：回播放页（播放器自动续播最近停留点） */}
                <Link
                  href={`/material/${data.resume.materialId}`}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs tracking-widest text-primary-foreground"
                >
                  <span className="material-symbols-outlined text-sm">play_arrow</span>
                  即刻续研
                </Link>
              </div>
              {/* 精微进度条 */}
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-secondary"
                  style={{ width: `${data.resume.progressPct}%` }}
                />
              </div>
            </section>
          ) : null}

          {/* ===== 快速导入（移动，仿 _12）：链接就地萃取 ===== */}
          <section className="deckle mb-6 rounded-md border bg-muted/50 p-4 md:hidden">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* 朱砂小印：导入能力标识 */}
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground">
                  <span className="material-symbols-outlined text-base">add_link</span>
                </span>
                <div>
                  <h3 className="text-sm font-semibold leading-tight">导入新音频 / 视频</h3>
                  <p className="text-[11px] text-muted-foreground">
                    解析 YouTube、播客、TED 或本地长篇材料
                  </p>
                </div>
              </div>
              {/* 展开/收起高级项（拟归卷 / 本地文件） */}
              <button
                onClick={() => setImportOpen((v) => !v)}
                aria-label={importOpen ? '收起导入选项' : '展开导入选项'}
                className="p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <span
                  className={`material-symbols-outlined text-xl transition-transform ${
                    importOpen ? 'rotate-180' : ''
                  }`}
                >
                  expand_more
                </span>
              </button>
            </div>
            <div className="flex items-center gap-2">
              {/* 链接输入（带前置链接图标） */}
              <div className="relative flex-1">
                <span className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-lg text-muted-foreground">
                  link
                </span>
                <input
                  value={linkUrl}
                  onChange={(e) => {
                    setLinkUrl(e.target.value);
                    setImportError(null);
                  }}
                  type="url"
                  placeholder="粘贴音视频链接 (Bilibili/YouTube/Podcast)…"
                  className="deckle w-full rounded-sm border border-input bg-background py-2 pl-9 pr-3 text-[13px] placeholder:text-muted-foreground/60"
                />
              </div>
              {/* 萃取按钮：就地提交链接导入 */}
              <button
                onClick={submitQuickImport}
                disabled={quickImport.isPending}
                className="flex shrink-0 items-center gap-1 rounded-sm bg-primary px-3.5 py-2 text-xs tracking-wider text-primary-foreground disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">
                  {quickImport.isPending ? 'hourglass_empty' : 'draw'}
                </span>
                {quickImport.isPending ? '解析中…' : '萃取'}
              </button>
            </div>
            {/* 提交错误（失败可见） */}
            {importError && <p className="mt-2 text-xs text-destructive">{importError}</p>}
            {/* 展开项：拟归卷 + 本地文件引导 */}
            {importOpen && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground">拟归入材料集：</span>
                  {/* 拟归卷选择：默认取第一卷 */}
                  <select
                    value={importCollectionId || collections[0]?.id || 0}
                    onChange={(e) => setImportCollectionId(Number(e.target.value))}
                    className="deckle min-w-0 flex-1 truncate rounded-sm border border-input bg-background px-2.5 py-1 text-xs"
                  >
                    {collections.length === 0 && <option value={0}>尚无卷帙——请先立卷</option>}
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        《{c.name}》
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">本地典籍文件：</span>
                  {/* 本地文件 / 文本走导入向导（表单复杂，不在首页内联） */}
                  <Link href="/import" className="flex items-center gap-1 text-xs text-secondary">
                    <span className="material-symbols-outlined text-[15px]">upload_file</span>
                    前往导入向导（MP3 / MP4 / SRT / 文本）
                  </Link>
                </div>
              </div>
            )}
          </section>

          {/* ===== 统计卡网格（桌面，仿 _10）：四格纸墨韵数 ===== */}
          <section className="mb-8 hidden grid-cols-2 gap-4 md:grid lg:grid-cols-4">
            {[
              {
                icon: 'collections_bookmark',
                label: '收录卷集',
                value: String(data.stats.collectionCount),
                unit: '个材料集',
                sub: `共 ${data.stats.materialCount} 篇材料`,
                subIcon: 'trending_up',
              },
              {
                icon: 'movie',
                label: '入阁音视频材料',
                value: String(data.stats.materialCount),
                unit: '部典籍',
                sub: `累计 ${fmtDuration(data.stats.totalDurationMs)}`,
                subIcon: 'headphones',
              },
              {
                icon: 'history_edu',
                label: '已研句段',
                value: fmtInt(data.stats.studiedSentenceCount),
                unit: '句研磨',
                sub: '双语字幕逐句听过累计',
                subIcon: 'check_circle',
              },
              {
                icon: 'brush',
                label: '研墨生词典藏',
                value: fmtInt(data.stats.wordCount),
                unit: '雅词入册',
                sub: '词藏全部收录',
                subIcon: 'local_fire_department',
              },
            ].map((s) => (
              /* 单张统计卡：纸卡 + 角标圆章 */
              <div key={s.label} className="deckle relative overflow-hidden rounded-md border bg-card p-5">
                <span
                  aria-hidden
                  className="absolute right-3 top-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                  <span className="material-symbols-outlined text-xl">{s.icon}</span>
                </span>
                <span className="text-[11px] uppercase tracking-widest text-ochre">{s.label}</span>
                <p className="mt-2 font-serif text-3xl">
                  {s.value} <span className="text-sm text-muted-foreground">{s.unit}</span>
                </p>
                <p className="mt-3 flex items-center gap-1 text-xs text-secondary">
                  <span className="material-symbols-outlined text-sm">{s.subIcon}</span>
                  {s.sub}
                </p>
              </div>
            ))}
          </section>

          {/* ===== 流转动向（桌面，仿 _10）：最近活跃材料 ===== */}
          <section className="mb-10 hidden md:block">
            <div className="mb-3 flex items-center gap-2">
              {/* 朱砂圆点：区段标识 */}
              <span aria-hidden className="size-2.5 rounded-full bg-primary" />
              <h3 className="font-serif text-xl">流动动向 · 最新入阁文献</h3>
              <span className="text-xs text-ochre">待研读或正在研习中</span>
            </div>
            <div className="deckle flex flex-col gap-1 rounded-md border bg-card p-2">
              {data.recent.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  尚无入阁材料——先导入一篇试试。
                </p>
              ) : (
                data.recent.map((m) => (
                  <Link
                    key={m.materialId}
                    href={`/material/${m.materialId}`}
                    className="flex flex-col justify-between gap-2 rounded-sm p-4 transition-colors hover:bg-accent sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {/* 来源图标块 */}
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-sm bg-muted text-primary">
                        <span className="material-symbols-outlined text-2xl">
                          {SOURCE_ICON[m.sourceType] ?? 'headphones'}
                        </span>
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{m.title}</span>
                          {/* 所属集签 */}
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            所属：《{m.collectionName}》
                          </span>
                        </div>
                        {/* 元数据行：时长 / 句词数 / 校订状态 */}
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ochre">
                          {m.mediaDurationMs != null && (
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-sm">schedule</span>
                              {fmtDuration(m.mediaDurationMs)}
                            </span>
                          )}
                          {m.sentenceCount != null && (
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-sm">
                                record_voice_over
                              </span>
                              {m.sentenceCount} 句
                              {m.uniqueWordCount != null && <> / {fmtInt(m.uniqueWordCount)} 词</>}
                            </span>
                          )}
                          <span
                            className={`flex items-center gap-1 ${
                              m.subtitleStatus === 'ready'
                                ? 'text-secondary'
                                : m.subtitleStatus === 'failed'
                                  ? 'text-destructive'
                                  : 'text-ochre'
                            }`}
                          >
                            <span className="material-symbols-outlined text-sm">
                              {m.subtitleStatus === 'ready' ? 'done_all' : 'autorenew'}
                            </span>
                            {STATUS_TEXT[m.subtitleStatus] ?? m.subtitleStatus}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">
                      {/* 研读进度（移动窄屏隐藏，集卷页可见） */}
                      <span className="hidden flex-col items-end sm:flex">
                        <span className="text-[11px] text-ochre">研读进度</span>
                        <span
                          className={`text-sm font-medium ${
                            m.progressPct > 0 ? 'text-secondary' : 'text-muted-foreground'
                          }`}
                        >
                          {m.progressPct > 0 ? `${m.progressPct}%` : '未开卷'}
                        </span>
                      </span>
                      <span className="flex items-center gap-1 rounded-sm bg-muted px-3 py-1.5 text-sm">
                        <span className="material-symbols-outlined text-base">menu_book</span>
                        进入精读
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>

          {/* ===== 集卷区段头 + 轻筛选药丸 ===== */}
          <section className="mb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[17px] text-primary">shelves</span>
                <h3 className="font-serif text-lg">典籍集卷</h3>
              </div>
              {/* 拟定新集（移动入口；桌面在页头按钮与网格尾卡） */}
              <button
                onClick={() => setCreating((v) => !v)}
                className="flex items-center gap-1 px-1.5 py-1 text-xs text-primary transition-colors hover:text-primary-hover md:hidden"
              >
                <span className="material-symbols-outlined text-[15px]">create_new_folder</span>
                拟定新集
              </button>
            </div>
            {/* 过滤药丸：全部 / 最近研习 / 未开卷（无卷时不渲染） */}
            {collections.length > 0 && (
              <div className="mt-2 flex items-center gap-2 overflow-x-auto py-1">
                {(
                  [
                    { key: 'all', label: `全部卷帙 (${collections.length})` },
                    { key: 'recent', label: `最近研习 (${recentCount})` },
                    { key: 'fresh', label: `未开卷 (${freshCount})` },
                  ] as Array<{ key: Filter; label: string }>
                ).map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setFilter(p.key)}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs tracking-wider transition-colors ${
                      filter === p.key
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* 新建卷内联表单（双端共用；失败提示可见） */}
          {creating && (
            <form
              className="deckle mb-6 flex gap-2 rounded-md border bg-card p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="卷名（如：乔布斯典籍演说）"
                autoFocus
                className="flex-1 rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={!name.trim() || create.isPending}
                className="rounded-sm bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >
                立卷
              </button>
            </form>
          )}
          {createError && <p className="mb-6 text-xs text-destructive">{createError}</p>}

          {/* ===== 集卷卡列表 ===== */}
          {filtered.length === 0 ? (
            collections.length === 0 ? (
              /* 空库引导：立卷起点 */
              <section className="deckle flex flex-col items-center justify-center rounded-md border border-dashed bg-card/50 px-6 py-16 text-center">
                <span className="material-symbols-outlined mb-3 text-4xl text-ochre">
                  library_books
                </span>
                <p className="font-serif text-lg">尚无卷帙，虚位以待</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  先立一卷，再导入音视频自动生成字幕，或导入文本自动生成音频。
                </p>
                <button
                  onClick={() => setCreating(true)}
                  className="mt-4 flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                >
                  <span className="material-symbols-outlined text-lg">create_new_folder</span>
                  另辟新卷
                </button>
              </section>
            ) : (
              /* 筛选档位空态（非空库） */
              <p className="py-10 text-center text-sm text-muted-foreground">
                此档位暂无卷帙。
              </p>
            )
          ) : (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((c) => (
                <CollectionCard key={c.id} c={c} />
              ))}
              {/* 桌面：新建占位卡（仿 _10「另辟新案」） */}
              <button
                onClick={() => setCreating(true)}
                className="hidden flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed border-border p-6 text-center transition-colors hover:border-primary md:flex"
              >
                <span className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-primary">
                  <span className="material-symbols-outlined text-3xl">add</span>
                </span>
                <span className="font-serif text-base">另辟新案 · 创制材料集</span>
                <span className="max-w-xs text-xs text-muted-foreground">
                  归拢专属主题的播客、公开课或影视对白，设立专属生词谱与精读节奏
                </span>
              </button>
            </section>
          )}

          {/* 底部禅意分隔 */}
          <div className="flex items-center justify-center gap-3 pb-4 pt-8 text-ochre/60">
            <span aria-hidden className="h-px w-12 bg-border" />
            <span className="select-none font-serif text-sm">❖ 研精极虑 ❖</span>
            <span aria-hidden className="h-px w-12 bg-border" />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * 集卷卡：移动横排（封面左/信息右，仿 _12）↔ 桌面竖排（封面顶/进度底，仿 _10）
 * @param props.c 集卷聚合数据
 */
function CollectionCard({ c }: { c: HomeCollection }) {
  return (
    <Link
      href={`/collection/${c.id}`}
      className="deckle group flex flex-row gap-3 rounded-md border bg-card p-4 transition-colors hover:bg-accent/60 md:flex-col md:gap-0 md:p-5"
    >
      {/* 封面印模：暂无封面数据，以卷名首字活字代之 */}
      <div className="relative h-24 w-20 shrink-0 overflow-hidden rounded-md bg-muted md:mb-4 md:h-40 md:w-full">
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center font-serif text-4xl text-ochre/70 md:text-5xl"
        >
          {c.name.replace(/^[「《\s]+/, '').slice(0, 1) || '卷'}
        </span>
        {/* 底部卷签：篇数 */}
        <span className="absolute bottom-1 left-1.5 text-[10px] tracking-wide text-muted-foreground">
          {c.materialCount} 篇
        </span>
        {/* CEFR 角标 */}
        {c.cefrLevel && (
          <span className="absolute right-1 top-1 rounded-sm bg-background/80 px-1 py-0.5 text-[10px] text-ochre">
            {c.cefrLevel}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 状态徽章行 */}
        <div className="flex items-center justify-between gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${
              c.progressPct > 0
                ? 'bg-secondary/10 text-secondary'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {c.progressPct > 0 ? `研读中 · ${c.progressPct}%` : '未开卷'}
          </span>
        </div>
        {/* 卷名 */}
        <h3 className="mt-1 truncate font-serif text-base leading-snug transition-colors group-hover:text-primary md:text-lg">
          {c.name}
        </h3>
        {/* 描述（可空） */}
        {c.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
        )}
        {/* 移动底行：篇数 · 句数 · 时长 */}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-ochre md:hidden">
          <span>
            <span className="font-semibold text-foreground">{c.materialCount}</span> 篇材料
            {c.sentenceCount > 0 && (
              <>
                {' '}
                · <span className="font-semibold text-primary">{c.sentenceCount}</span> 句
              </>
            )}
          </span>
          {c.totalDurationMs > 0 && <span>{fmtDuration(c.totalDurationMs)}</span>}
        </div>
        {/* 桌面底区：时长/最近研习 + 进度条 */}
        <div className="mt-auto hidden pt-4 md:block">
          <div className="flex items-center justify-between gap-2 text-[11px] text-ochre">
            <span className="truncate">
              {c.totalDurationMs > 0 ? `总计 ${fmtDuration(c.totalDurationMs)}` : '尚未导入'}
              {c.lastStudiedAt ? ` · 最近研习 ${fmtRelative(c.lastStudiedAt)}` : ''}
            </span>
            {c.progressPct > 0 && (
              <span className="shrink-0 font-medium text-secondary">{c.progressPct}%</span>
            )}
          </div>
          {/* 进度条：未开卷为空槽 */}
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                c.progressPct > 0 ? 'bg-secondary' : ''
              }`}
              style={{ width: `${c.progressPct}%` }}
            />
          </div>
        </div>
      </div>
    </Link>
  );
}
