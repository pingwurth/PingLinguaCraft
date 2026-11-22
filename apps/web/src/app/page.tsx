'use client';

/**
 * 首页 —— 案头今研（结构参照设计稿 首页/code.html：卷首抬头 + 卷内材料列表）
 *
 * 首页不再是藏经阁全库（移至 /library，由侧栏「藏经阁库」条目进入），而是聚焦
 * 「今研之卷」：优先落座续研书签所在卷（口径恒同卷），无书签再取最近研习
 * （lastStudiedAt 最大）卷，全库未开卷时回落库序首卷，给出一屏可续研的工作台——
 * - 卷首抬头卡：面包屑（藏经阁 / 卷名 + 私享藏本）+ 卷名 + 题记引文 +
 *   韵数徽记（在卷材料 / 卷册总长 / 经卷句藏 / 最近研习）+ 导入/入卷动作 +
 *   卷册修研总度缎带（进度 + 续研书签「第 N 句」即刻续研）；
 *   卡角以卷面印文（或卷名首字）作淡朱水印
 * - 检索与筛选工具栏：卷内标题轻检索 + 研习状态筛选（全部/研习中/已完卷/未开卷，
 *   客户端过滤，不另起请求）
 * - 卷内材料列表：逐篇韵数四格（章回句数 / 去重词藏 / 校订状态 / 研读进度）+
 *   状态动作（继续精读 / 开启首研 / 复读温习 / 查看失败原因）+ 移出本卷（软删）；
 *   处理中材料内联任务进度（轮询 /api/jobs）；研习中/已完卷卡片左缘落色条
 * - 底部研习小笺：语流听席 / 静思复习 / 研习手册快捷入口
 * 入口约定：首页不入导航菜单，统一由左上角品牌区（Logo）进入。
 * 数据：GET /api/home（与壳层共享 ['home'] 查询缓存，零额外聚合请求）+
 * GET /api/collections/[id]/materials（每条材料附位图口径 progress，core 契约）。
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseCollectionCover } from '@pinglc/core';
import { api, type JobDTO, type MaterialListItem } from '@/lib/api';
import { SOURCE_META, subtitleStatusMeta } from '@/lib/material-meta';
import { firstGlyph, fmtDuration, fmtMs, fmtRelative, progressTone } from '@/lib/format';
import { HOME_QUERY_KEY } from '@/features/home/query-keys';
import type { HomeCollection, HomeData, HomeResumePoint } from '@/features/home/types';
import { MATERIAL_PAGE_MAX } from '@/lib/limits';

/** 研习状态档位（材料粒度）：研习中（0<p<100）/ 已完卷（≥100）/ 待启卷（0） */
type StudyState = 'studying' | 'done' | 'fresh';

/** 筛选档位：全部 + 三种研习状态 */
type StudyFilter = 'all' | StudyState;

/**
 * 材料 → 研习状态档位（已完卷以 listenedThrough 判定——服务端按位图逐句复核，
 * 与「已完卷」语义一致；四舍五入的 progressPct 在 199/200→100% 时会误判，
 * 仅作展示。研习中 = 进度 >0，否则待启卷）
 * @param m 材料条目（progress 为 null 即从未研习 → 待启卷）
 */
function studyState(m: MaterialListItem): StudyState {
  const p = m.progress;
  if (!p) return 'fresh';
  if (p.listenedThrough) return 'done';
  return p.progressPct > 0 ? 'studying' : 'fresh';
}

/** 研习状态 → 卷内签文案/色调 + 主动作（样式/文案/图标单表收敛，禁嵌套三元） */
const STATE_META: Record<
  StudyState,
  { label: string; tone: string; actionCls: string; actionLabel: string; actionIcon: string }
> = {
  studying: {
    label: '正在研习',
    tone: 'text-shell-seal',
    actionCls: 'bg-shell-seal text-on-shell-seal shadow-sm hover:bg-primary',
    actionLabel: '继续精读',
    actionIcon: 'menu_book',
  },
  done: {
    label: '已完卷',
    tone: 'text-shell-bamboo',
    actionCls: 'bg-surface-container text-on-surface hover:bg-surface-container-high',
    actionLabel: '复读温习',
    actionIcon: 'replay',
  },
  fresh: {
    label: '待启卷',
    tone: 'text-outline',
    actionCls: 'bg-primary-fixed/60 text-shell-seal hover:bg-shell-seal hover:text-on-shell-seal',
    actionLabel: '开启首研',
    actionIcon: 'menu_book',
  },
};

/** 卷内材料列表页大小（顶格 API 上限：首页定位速览，超量走「入卷查阅」分页） */
const FOCUS_PAGE_SIZE = MATERIAL_PAGE_MAX;

/**
 * 首页组件：案头今研（聚焦最近研习的材料集）
 */
export default function HomePage() {
  const qc = useQueryClient();
  /* 卷内轻检索关键词 + 研习状态筛选档位（均客户端过滤） */
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StudyFilter>('all');

  /* 首页聚合（与壳层共享 ['home'] 缓存：卷列表/统计/续研书签一次到位） */
  const home = useQuery({ queryKey: HOME_QUERY_KEY, queryFn: () => api<HomeData>('/api/home') });
  const collections = useMemo(() => home.data?.collections ?? [], [home.data]);

  /* 今研之卷选取：优先落座续研书签所在卷（resume 的材料口径比 lastStudiedAt 窄：
   * 只取就绪材料且观测到任一句（maxCueIndex≥0）的最新行——按 lastStudiedAt
   * 选卷会出现「卷首说未开卷、同卡进度却 >0」的自相矛盾）；无书签再取
   * lastStudiedAt 最大卷，全库从未开卷时按库序回落首卷 */
  const resumePoint = home.data?.resume ?? null;
  const focus = useMemo(() => {
    if (collections.length === 0) return null;
    const resumeCol = resumePoint
      ? collections.find((c) => c.id === resumePoint.collectionId)
      : undefined;
    if (resumeCol) return resumeCol;
    let best: HomeCollection = collections[0]!;
    for (const c of collections) {
      if ((c.lastStudiedAt ?? 0) > (best.lastStudiedAt ?? 0)) best = c;
    }
    return best;
  }, [collections, resumePoint]);
  const focusId = focus?.id ?? null;

  /* 卷内材料（pageSize 顶格 100：首页定位速览；更多材料由「入卷查阅」分页承接），
   * 处理中存在时轮询刷新字幕状态 */
  const list = useQuery({
    queryKey: ['focus-materials', focusId],
    queryFn: () => {
      if (focusId === null) throw new Error('未选定今研之卷');
      return api<{ materials: MaterialListItem[]; total: number }>(
        `/api/collections/${focusId}/materials?page=1&pageSize=${MATERIAL_PAGE_MAX}`
      );
    },
    enabled: focusId !== null,
    refetchInterval: (q) =>
      q.state.data?.materials.some((m) => m.subtitleStatus === 'processing') ? 2500 : false,
  });
  const materials = useMemo(() => list.data?.materials ?? [], [list.data]);

  /* 续研书签（归属今研之卷时才在缎带展示；卷不符静默降级为「尚未开卷」注记） */
  const resume: HomeResumePoint | null =
    home.data?.resume && home.data.resume.collectionId === focusId ? home.data.resume : null;

  /* 移出本卷（软删除；DELETE /api/materials/[id]）：
   * 成功后失效首页聚合/今研卷列表/集详情（materialCount 等随之刷新）。
   * 确认走共享 ConfirmDialog（与删卷同款，含进行中封路与失败就地展示）；
   * 软删保留库内数据但应用内暂无恢复入口，文案不承诺可恢复 */
  const [removingTarget, setRemovingTarget] = useState<MaterialListItem | null>(null);
  const removeMaterial = useMutation({
    mutationFn: (id: number) => api(`/api/materials/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemovingTarget(null);
      void qc.invalidateQueries({ queryKey: HOME_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['focus-materials'] });
      void qc.invalidateQueries({ queryKey: ['collection'] });
    },
  });

  /**
   * 打开移出确认弹窗
   * @param m 待移出材料
   */
  const confirmRemoveMaterial = (m: MaterialListItem) => {
    setRemovingTarget(m);
  };

  /* 筛选档位计数（基于全量卷内材料，与筛选结果无关，供药丸角标） */
  const counts = useMemo(() => {
    const c: Record<StudyFilter, number> = { all: materials.length, studying: 0, done: 0, fresh: 0 };
    for (const m of materials) c[studyState(m)] += 1;
    return c;
  }, [materials]);

  /* 卷内全量位次表（id → 序号）：行卡「卷内 · NN」取号 O(1)，不逐行 indexOf */
  const indexById = useMemo(() => {
    const map = new Map<number, number>();
    materials.forEach((m, i) => map.set(m.id, i));
    return map;
  }, [materials]);

  /* 卷内轻筛：标题关键词（大小写不敏感）+ 研习状态档位 */
  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return materials.filter((m) => {
      if (kw !== '' && !m.title.toLowerCase().includes(kw)) return false;
      return filter === 'all' || studyState(m) === filter;
    });
  }, [materials, query, filter]);

  /* 水印字：卷面印文优先，未配置则取卷名首字（firstGlyph 与书影活字底共用
     单源——剥「《 前缀、码点级取字；全空兜底「文」） */
  const watermark =
    (focus ? parseCollectionCover(focus.cover)?.seal : '') ||
    (focus ? firstGlyph(focus.name) : '') ||
    '文';

  return (
    /* 页面容器：与藏经阁同款 bg-surface 冷灰页底；移动 px-5，桌面 px-10 */
    <div className="w-full bg-surface px-5 py-6 md:px-10 md:py-10 md:pb-16">
      {home.isLoading ? (
        /* 聚合数据装载中 */
        <p className="py-16 text-center text-body-sm text-on-surface-variant">装载中…</p>
      ) : home.isError ? (
        /* 查询失败 ≠ 空库：落到空态会误导用户以为数据丢失 */
        <p className="py-16 text-center text-body-sm text-destructive">
          首页装载失败：{home.error.message}
        </p>
      ) : !focus ? (
        /* ===== 空库引导：书斋虚位以待（立卷在藏经阁，导入可直达） ===== */
        <section className="flex flex-col items-center justify-center rounded-[8px] border border-dashed border-outline-variant/60 bg-surface-container-lowest/50 px-6 py-16 text-center">
          <span className="material-symbols-outlined mb-3 text-4xl text-outline">local_library</span>
          <p className="font-serif text-lg text-on-surface">书斋虚位以待</p>
          <p className="mt-1 max-w-sm text-body-sm text-on-surface-variant">
            先到藏经阁立一卷，再导入音视频自动生成字幕，或导入文本自动生成音频——案头今研之卷会随研习自动落座于此。
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/library"
              className="flex items-center gap-1.5 rounded-sm bg-shell-seal px-4 py-2 text-title-sm text-on-shell-seal transition-colors hover:bg-primary"
            >
              <span className="material-symbols-outlined text-lg">create_new_folder</span>
              去藏经阁立卷
            </Link>
            <Link
              href="/import"
              className="flex items-center gap-1.5 rounded-sm bg-surface-container px-4 py-2 text-title-sm text-on-surface transition-colors hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-lg">library_add</span>
              直接导入材料
            </Link>
          </div>
        </section>
      ) : (
        <>
          {/* ===== ① 卷首抬头卡：面包屑 + 卷名/题记/韵数徽记 + 动作组 + 修研总度缎带 ===== */}
          <section className="relative mb-6 overflow-hidden rounded-[8px] bg-surface-container-low p-5 shadow-sm md:p-8">
            {/* 淡朱水印：卷面印文/卷名首字（纯装饰，右上沉底，不挡内容） */}
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-10 -right-4 select-none text-shell-seal opacity-[0.05]"
            >
              <span className="font-serif text-[160px] leading-none">{watermark}</span>
            </div>
            {/* 面包屑：藏经阁（/library）→ 今研卷名；「私享藏本」为单用户自托管注记 */}
            <nav
              aria-label="所在位置"
              className="relative mb-4 flex items-center gap-2 text-label-md text-on-surface-variant"
            >
              <Link
                href="/library"
                className="flex items-center gap-1 transition-colors hover:text-shell-seal"
              >
                <span className="material-symbols-outlined text-base">shelves</span>
                <span>藏经阁</span>
              </Link>
              <span aria-hidden className="text-outline/50">/</span>
              <span className="truncate text-title-sm tracking-wide text-on-surface">
                {focus.name}
              </span>
              <span className="shrink-0 rounded-xl bg-surface-container px-2 py-0.5 text-[11px] text-on-surface-variant">
                私享藏本
              </span>
            </nav>
            {/* 主区：左（卷名/题记/徽记）8 栅格 + 右（动作组）4 栅格 */}
            <div className="relative grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
              <div className="flex flex-col gap-2 lg:col-span-8">
                {/* 卷名行：深朱竖条 + 衬线大标（移动 28px / 桌面 36px） */}
                <div className="flex items-center gap-2">
                  <span aria-hidden className="inline-block h-8 w-2.5 shrink-0 rounded-sm bg-shell-seal" />
                  <h1 className="font-serif text-headline-md font-normal tracking-tight text-on-surface md:text-headline-lg">
                    {focus.name}
                  </h1>
                </div>
                {/* 题记引文（可空）：压印底 + 衬线斜体 */}
                {focus.description && (
                  <p className="rounded-sm bg-surface-container-lowest/60 px-3 py-2 font-serif text-base italic leading-relaxed text-on-surface-variant">
                    「{focus.description}」
                  </p>
                )}
                {/* 韵数徽记行：在卷材料 / 卷册总长 / 经卷句藏（带梯级）/ 最近研习 */}
                <div className="flex flex-wrap items-center gap-2 pt-1 text-body-sm text-on-surface-variant">
                  <span className="flex items-center gap-1.5 rounded-sm bg-surface-container px-2 py-1">
                    <span aria-hidden className="material-symbols-outlined text-[18px] text-outline">
                      collections_bookmark
                    </span>
                    <span>
                      在卷材料：
                      <strong className="text-title-sm text-on-surface">{focus.materialCount} 篇</strong>
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 rounded-sm bg-surface-container px-2 py-1">
                    <span aria-hidden className="material-symbols-outlined text-[18px] text-outline">
                      schedule
                    </span>
                    <span>
                      卷册总长：
                      <strong className="text-title-sm text-on-surface">
                        {focus.totalDurationMs > 0 ? fmtDuration(focus.totalDurationMs) : '尚未导入'}
                      </strong>
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 rounded-sm bg-surface-container px-2 py-1">
                    <span aria-hidden className="material-symbols-outlined text-[18px] text-shell-bamboo">
                      translate
                    </span>
                    <span>
                      经卷句藏：
                      <strong className="text-title-sm text-shell-bamboo">{focus.sentenceCount} 句</strong>
                      {focus.cefrLevel && (
                        <span className="text-outline">（梯级 {focus.cefrLevel}）</span>
                      )}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 rounded-sm bg-surface-container px-2 py-1">
                    <span aria-hidden className="material-symbols-outlined text-[18px] text-outline">
                      calendar_today
                    </span>
                    <span>
                      最近研习：
                      <strong className="text-title-sm text-on-surface">
                        {focus.lastStudiedAt ? fmtRelative(focus.lastStudiedAt) : '未开卷'}
                      </strong>
                    </span>
                  </span>
                </div>
              </div>
              {/* 动作组：导入到本卷（主）/ 入卷查阅（次；编辑装帧与删除在详情页页头） */}
              <div className="relative flex flex-col items-stretch justify-end gap-2 lg:col-span-4 lg:items-end">
                <Link
                  href={`/import?collectionId=${focus.id}`}
                  className="flex items-center justify-center gap-1.5 rounded-sm bg-shell-seal px-4 py-2.5 text-label-md text-on-shell-seal shadow-sm transition-colors hover:bg-primary"
                >
                  <span className="material-symbols-outlined text-[18px]">add_box</span>
                  导入新材料到此集
                </Link>
                <Link
                  href={`/collection/${focus.id}`}
                  className="flex items-center justify-center gap-1.5 rounded-sm bg-surface-container px-4 py-2.5 text-label-md text-on-surface transition-colors hover:bg-surface-container-high"
                >
                  <span className="material-symbols-outlined text-[18px]">checklist</span>
                  入卷查阅 · 编辑装帧
                </Link>
              </div>
            </div>
            {/* 修研总度缎带：贴卡底通栏（负 margin 吃掉内边距）+ 半染底 */}
            <div className="relative -mx-5 -mb-5 mt-6 flex flex-col gap-3 bg-surface-container/60 px-5 py-3 sm:flex-row sm:items-center sm:justify-between md:-mx-8 md:-mb-8 md:px-8">
              {/* 左：卷册修研总度进度条 + 百分比 */}
              <div className="flex items-center gap-3">
                <span className="shrink-0 uppercase tracking-wider text-label-sm text-outline">
                  卷册修研总度
                </span>
                <div className="h-2 w-40 overflow-hidden rounded-full bg-surface-container-highest">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      focus.progressPct > 0 ? progressTone(focus.progressPct) : ''
                    }`}
                    style={{ width: `${focus.progressPct}%` }}
                  />
                </div>
                <span className="text-title-sm text-shell-bamboo">{focus.progressPct}%</span>
              </div>
              {/* 右：续研书签（材料/句位/即刻续研）或未开卷注记 */}
              {resume ? (
                <div className="flex items-center gap-3">
                  <span className="min-w-0 text-label-sm text-on-surface-variant">
                    上次研习{' '}
                    <span className="text-on-surface">{resume.materialTitle}</span> · 第{' '}
                    <span className="font-semibold text-shell-seal">{resume.maxCueIndex + 1}</span> 句
                    / 共 {resume.cueCount} 句
                  </span>
                  <Link
                    href={`/material/${resume.materialId}`}
                    className="flex shrink-0 items-center gap-1 rounded-sm bg-shell-seal px-3 py-1.5 text-label-md text-on-shell-seal transition-colors hover:bg-primary"
                  >
                    <span aria-hidden className="material-symbols-outlined text-base">
                      play_arrow
                    </span>
                    即刻续研
                  </Link>
                </div>
              ) : (
                <span className="flex items-center gap-1.5 text-label-sm text-outline">
                  <span aria-hidden className="size-2 rounded-full bg-outline/50" />
                  尚未开卷 · 从第一篇开始
                </span>
              )}
            </div>
          </section>

          {/* ===== ② 检索与筛选工具栏：卷内标题检索 + 研习状态药丸 ===== */}
          <section className="mb-4 flex flex-col gap-3 rounded-[8px] bg-surface-container-lowest p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            {/* 卷内检索输入（客户端过滤，Enter 无表单语义） */}
            <div className="relative max-w-lg flex-1">
              <span
                aria-hidden
                className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-outline"
              >
                search
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="检索卷内材料标题…"
                aria-label="卷内材料检索"
                className="w-full rounded-sm bg-surface-container-low py-2 pl-9 pr-3 text-body-sm text-on-surface placeholder:text-outline focus:bg-surface-container focus:outline-none focus:ring-1 focus:ring-shell-seal"
              />
            </div>
            {/* 研习状态药丸：活动态白底染深朱（计数角标随全量材料实时变化） */}
            <div className="flex items-center gap-1 overflow-x-auto rounded-[8px] bg-surface-container-low p-0.5 text-label-md text-on-surface-variant">
              {(
                [
                  { key: 'all', label: `全部 (${counts.all})` },
                  { key: 'studying', label: `研习中 (${counts.studying})` },
                  { key: 'done', label: `已完卷 (${counts.done})` },
                  { key: 'fresh', label: `待启卷 (${counts.fresh})` },
                ] as Array<{ key: StudyFilter; label: string }>
              ).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setFilter(p.key)}
                  aria-pressed={filter === p.key}
                  className={`shrink-0 rounded-sm px-3 py-1 transition-colors ${
                    filter === p.key
                      ? 'bg-surface-container-lowest font-semibold text-shell-seal shadow-sm'
                      : 'hover:text-on-surface'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          {/* ===== ③ 卷内材料列表：空态三分（装载失败 / 此卷尚空 / 检索无果） ===== */}
          {list.isLoading ? (
            <p className="py-16 text-center text-body-sm text-on-surface-variant">
              卷内材料装载中…
            </p>
          ) : list.isError ? (
            <p className="py-16 text-center text-body-sm text-destructive">
              卷内材料装载失败：{list.error.message}
            </p>
          ) : materials.length === 0 ? (
            <section className="flex flex-col items-center justify-center rounded-[8px] border border-dashed border-outline-variant/60 bg-surface-container-lowest/50 px-6 py-16 text-center">
              <span className="material-symbols-outlined mb-3 text-4xl text-outline">
                import_contacts
              </span>
              <p className="font-serif text-lg text-on-surface">此卷尚空</p>
              <p className="mt-1 max-w-sm text-body-sm text-on-surface-variant">
                导入音视频自动生成双语字幕，或导入文本自动生成音频，开始研习。
              </p>
              <Link
                href={`/import?collectionId=${focus.id}`}
                className="mt-4 flex items-center gap-1.5 rounded-sm bg-shell-seal px-4 py-2 text-title-sm text-on-shell-seal transition-colors hover:bg-primary"
              >
                <span className="material-symbols-outlined text-lg">add_box</span>
                导入新材料到此集
              </Link>
            </section>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-body-sm text-outline">
              未检得相合的材料——换个关键词或筛选档位试试。
            </p>
          ) : (
            <section className="flex flex-col gap-3">
              {filtered.map((m) => (
                <FocusMaterialRow
                  key={m.id}
                  m={m}
                  /* 序号按卷内全量位次（筛选只隐藏不重排，卷内 · NN 稳定） */
                  index={indexById.get(m.id) ?? 0}
                  removing={removeMaterial.isPending && removeMaterial.variables === m.id}
                  onRemove={() => confirmRemoveMaterial(m)}
                />
              ))}
            </section>
          )}

          {/* 超量注记：列表只取首页速览的页大小，超过时明示总量防与「在卷材料 N 篇」打架 */}
          {list.data != null && list.data.total > materials.length && (
            <p className="mt-3 text-center text-label-sm text-outline">
              仅显示前 {FOCUS_PAGE_SIZE} 篇 · 共 {list.data.total} 篇——「入卷查阅」看全部
            </p>
          )}

          {/* ===== 移出材料确认弹窗（共享 ConfirmDialog；软删文案不承诺恢复） ===== */}
          <ConfirmDialog
            open={removingTarget !== null}
            title="移出本卷"
            icon="folder_delete"
            destructive
            pending={removeMaterial.isPending}
            error={removeMaterial.isError ? removeMaterial.error.message : null}
            confirmLabel="确认移出"
            onConfirm={() => {
              if (removingTarget !== null) removeMaterial.mutate(removingTarget.id);
            }}
            onClose={() => {
              setRemovingTarget(null);
              removeMaterial.reset();
            }}
            body={
              removingTarget && (
                <>
                  将「<strong className="text-on-surface">{removingTarget.title}</strong>」移出本卷？
                  <span className="mt-1 block">软删除：媒体与研习进度保留在库中（应用内暂无恢复入口）。</span>
                </>
              )
            }
          />

          {/* ===== ④ 底部研习小笺：研习法门建议 + 三处快捷入口 ===== */}
          <section className="mt-10 flex flex-col items-start justify-between gap-4 rounded-[8px] bg-surface-container-low p-5 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <span aria-hidden className="material-symbols-outlined mt-0.5 text-2xl text-shell-seal">
                auto_stories
              </span>
              <div className="flex flex-col">
                <span className="font-serif text-headline-sm text-on-surface">研习小笺</span>
                <span className="mt-0.5 max-w-2xl text-body-sm text-on-surface-variant">
                  精读逐句研磨之余，不妨以语流听席整篇盲听磨耳，收盘后到静思复习过一遍今日生词；词根词源的深研法门备在研习手册。
                </span>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-4">
              <Link
                href="/stream"
                className="flex items-center gap-1 text-title-sm text-shell-bamboo transition-colors hover:text-on-surface"
              >
                <span>语流听席</span>
                <span aria-hidden className="material-symbols-outlined text-[18px]">
                  arrow_forward
                </span>
              </Link>
              <Link
                href="/review"
                className="flex items-center gap-1 text-title-sm text-shell-bamboo transition-colors hover:text-on-surface"
              >
                <span>静思复习</span>
                <span aria-hidden className="material-symbols-outlined text-[18px]">
                  arrow_forward
                </span>
              </Link>
              <Link
                href="/manual"
                className="flex items-center gap-1 text-title-sm text-shell-bamboo transition-colors hover:text-on-surface"
              >
                <span>研习手册</span>
                <span aria-hidden className="material-symbols-outlined text-[18px]">
                  arrow_forward
                </span>
              </Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * 卷内材料行卡（案头今研视图）
 * @param props.m 材料条目（附位图口径 progress）
 * @param props.index 卷内序号（0 起；展示为「卷内 · NN」，筛选不重排）
 * @param props.removing 移出请求进行中（移出钮禁用防重复提交）
 * @param props.onRemove 移出本卷入口回调（confirm 确认与失败提示在父层统一处理）
 */
function FocusMaterialRow({
  m,
  index,
  removing,
  onRemove,
}: {
  m: MaterialListItem;
  index: number;
  /** 该材料移出请求进行中 */
  removing: boolean;
  /** 移出本卷入口回调 */
  onRemove: () => void;
}) {
  /* 处理中：轮询该材料的活跃任务拿进度文案（与集详情页同一模式） */
  const jobs = useQuery({
    queryKey: ['jobs', m.id],
    queryFn: () => api<{ jobs: JobDTO[] }>(`/api/jobs?materialId=${m.id}`),
    enabled: m.subtitleStatus === 'processing',
    refetchInterval: 2000,
  });
  const job = jobs.data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  /* 展示元单源：来源类型 + 校订状态 + 研习状态 */
  const src = SOURCE_META[m.sourceType] ?? SOURCE_META.audio!;
  const st = subtitleStatusMeta(m.subtitleStatus);
  const state = studyState(m);
  const ready = m.subtitleStatus === 'ready';
  /* 展示进度与档位判定同源：已完卷（listenedThrough，服务端逐句复核）恒显
   * 100——位图为空的存量行 pct 可能是 0，否则一行会同时出现「已完卷」与「未研读」；
   * 未完卷封顶 99——199/200 句四舍五入成 100% 会与「正在研习」同框打架 */
  const pct = m.progress?.listenedThrough ? 100 : Math.min(m.progress?.progressPct ?? 0, 99);

  return (
    /* 行卡：白纸卡 + 悬浮加深投影；研习中/已完卷左缘落色条（进行深朱 / 完卷竹青） */
    <article className="relative overflow-hidden rounded-[8px] bg-surface-container-lowest p-4 shadow-sm transition-shadow hover:shadow-md md:p-5">
      {state !== 'fresh' && (
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 w-1 ${
            state === 'studying' ? 'bg-shell-seal' : 'bg-shell-bamboo'
          }`}
        />
      )}
      <div className="grid grid-cols-1 items-center gap-4 xl:grid-cols-12">
        {/* 左：卷内序号签 + 题名（就绪可入精读）+ 来源/时长注 */}
        <div className="flex min-w-0 flex-col gap-1 xl:col-span-4">
          <span className={`flex items-center gap-1 text-label-sm ${STATE_META[state].tone}`}>
            <span aria-hidden className="material-symbols-outlined text-sm">
              bookmark
            </span>
            卷内 · {String(index + 1).padStart(2, '0')} {STATE_META[state].label}
          </span>
          {ready ? (
            <h3 className="truncate font-serif text-headline-sm leading-snug text-on-surface">
              <Link
                href={`/material/${m.id}`}
                className="transition-colors hover:text-shell-seal"
              >
                {m.title}
              </Link>
            </h3>
          ) : (
            <h3 className="truncate font-serif text-headline-sm leading-snug text-on-surface">
              {m.title}
            </h3>
          )}
          <p className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <span aria-hidden className="material-symbols-outlined text-base text-outline">
              {src.icon}
            </span>
            <span>
              {src.label}
              {m.mediaDurationMs != null && <> · {fmtMs(m.mediaDurationMs)}</>}
            </span>
          </p>
        </div>
        {/* 中：韵数四格（章回句数 / 去重词藏 / 校订状态 / 研读进度） */}
        <div className="grid grid-cols-3 items-center gap-3 rounded-sm bg-surface-container-low/70 px-4 py-2 sm:grid-cols-4 xl:col-span-5">
          {/* 格一：章回句数 */}
          <div className="flex flex-col">
            <span className="text-label-sm text-outline">章回句数</span>
            <p className="mt-0.5 text-title-sm text-on-surface">
              {m.sentenceCount ?? '—'}
              <span className="ml-1 text-body-sm text-outline">句</span>
            </p>
          </div>
          {/* 格二：去重词藏（竹青呼应词藏强调色） */}
          <div className="flex flex-col">
            <span className="text-label-sm text-outline">去重词藏</span>
            <p className="mt-0.5 text-title-sm text-shell-bamboo">
              {m.uniqueWordCount ?? '—'}
              <span className="ml-1 text-body-sm text-outline">词</span>
            </p>
          </div>
          {/* 格三：校订状态（单源映射：就绪竹青 / 解析中赭褐 / 失败破红 / 待处理弱化） */}
          <div className="flex flex-col">
            <span className="text-label-sm text-outline">校订状态</span>
            <span className={`mt-1 flex items-center gap-1 text-label-sm ${st.tone}`}>
              <span aria-hidden className="material-symbols-outlined text-[14px]">
                {st.icon}
              </span>
              {st.label}
            </span>
          </div>
          {/* 格四：研读进度——处理中给任务进度条；就绪给位图进度/句位；其余空槽弱化 */}
          <div className="col-span-3 flex flex-col sm:col-span-1">
            {m.subtitleStatus === 'processing' ? (
              <>
                <span className="flex items-center justify-between text-label-sm text-ochre">
                  <span className="truncate">{job?.message ?? '排队中…'}</span>
                  {job && <span>{Math.round(job.progress * 100)}%</span>}
                </span>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{ width: `${Math.max(3, (job?.progress ?? 0) * 100)}%` }}
                  />
                </div>
              </>
            ) : ready ? (
              <>
                <span className="flex items-center justify-between text-label-sm text-outline">
                  <span>{pct > 0 ? `进度 ${pct}%` : '未研读'}</span>
                  {pct > 0 && m.progress && (
                    <span className="font-semibold text-shell-seal">
                      第 {m.progress.maxCueIndex + 1} 句
                    </span>
                  )}
                </span>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      pct > 0 ? progressTone(pct) : ''
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <span className="text-label-sm text-outline">—</span>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                  <div className="h-full rounded-full bg-outline/20" style={{ width: '0%' }} />
                </div>
              </>
            )}
          </div>
        </div>
        {/* 右：状态动作（就绪三态 / 失败查因 / 制备中占位）+ 移出本卷 */}
        <div className="flex items-center justify-end gap-2 xl:col-span-3">
          {ready ? (
            /* 就绪：按研习状态给三态动作（研习中主按钮 / 待启卷浅朱印 / 已完卷温习；
               样式文案图标全查 STATE_META 单表） */
            <Link
              href={`/material/${m.id}`}
              className={`flex items-center gap-1.5 rounded-sm px-4 py-2 text-label-md transition-colors ${STATE_META[state].actionCls}`}
            >
              <span aria-hidden className="material-symbols-outlined text-base">
                {STATE_META[state].actionIcon}
              </span>
              {STATE_META[state].actionLabel}
            </Link>
          ) : m.subtitleStatus === 'failed' ? (
            /* 失败：破红描边按钮查失败原因（播放页承载） */
            <Link
              href={`/material/${m.id}`}
              className="flex items-center gap-1.5 rounded-sm border border-destructive/40 px-4 py-2 text-label-md text-destructive transition-colors hover:bg-destructive/10"
            >
              <span aria-hidden className="material-symbols-outlined text-base">
                report
              </span>
              查看失败原因
            </Link>
          ) : (
            /* 待处理/解析中占位（进度格已有任务条，此处仅弱化注记不设动作） */
            <span className="flex items-center gap-1.5 rounded-sm bg-surface-container px-4 py-2 text-label-md text-on-surface-variant">
              <span aria-hidden className="material-symbols-outlined text-base">
                hourglass_empty
              </span>
              字幕制备中
            </span>
          )}
          {/* 移出本卷：软删除可恢复；confirm 后执行（删除中换沙漏禁点） */}
          <button
            type="button"
            aria-label={`将「${m.title}」移出本卷`}
            title="移出本卷"
            disabled={removing}
            onClick={onRemove}
            className="flex size-9 shrink-0 items-center justify-center rounded-sm text-outline transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <span aria-hidden className="material-symbols-outlined text-lg">
              {removing ? 'hourglass_empty' : 'folder_delete'}
            </span>
          </button>
        </div>
      </div>
    </article>
  );
}
