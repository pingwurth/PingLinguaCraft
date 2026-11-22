'use client';

/**
 * 藏经阁页（/library —— 材料汇聚文库；双端同构，完全参照设计稿 linguacraft_10）
 *
 * 首页（/）已让位给「案头今研」聚焦视图（见 app/page.tsx）：本页退居侧栏
 * 「藏经阁库」条目，不再作为首页；入口 = 左上角品牌区（Logo）→ /，藏经阁 → /library。
 * - 双端同一案头视觉（bg-surface 冷灰页底 + surface-container 容器族 + 深朱/竹青强调）：
 *   卷首抬头 + 四格统计卡 + 案头近况（桌面专属，移动端由续研书签承担"最近"）+ 筛选药丸 + 集卷卡 + 底部分页栏；
 *   移动端仅做响应式收缩（headline 28px、统计卡两列、集卷单列、条目纵排）
 * - 续研书签（移动）：最近停留的材料 + 停留句引文 + 进度 + 即刻续研（桌面无此卡，
 *   由侧栏研墨造诣卡与流动动向承担续研入口；功能卡冷灰化以与整体一致）
 * - 导入/建卷不在本页设内联入口：统一走顶栏导入按钮与「另辟新案」占位卡（/import 向导承接全部导入形态）
 * - 集卷卡：卡即书影本体（bookCoverCls + BookInner 单源，Link 直接承载
 *   书影类名在网格内直接排布，无卡壳/案头垫包裹）+ 轻筛选（全部/最近研习/
 *   未开卷；现库无分类维度，设计稿的分类 pills 降级为基于进度数据的三档）；
 *   卡右上角编辑/删除钮组（悬浮卡片淡入、键盘聚焦显形；触屏彻底隐藏——
 *   移动端编辑/删除入口由详情页页头承担）：删除经纸墨风确认弹窗（ConfirmDialog
 *   共享组件）交代级联后果后物理删卷与卷内材料/媒体，编辑走立卷弹窗的编辑模式
 *   （预填现值 PATCH）
 * - 另辟新卷：弹窗式建卷表单（仿「创建材料集」设计稿双栏排版：左「装帧成相」——
 *   书影实时试样 + 装帧质地 + 封面插画 + 卷脊印文 + 册序编排；右「基础案目」——
 *   题名计数输入 / 题记 textarea / CEFR 梯级五段选择；封面配置契约见
 *   @pinglc/core collection-cover；册序即真排序——卷签 rank 映射 sortOrder，
 *   书影左上落册序卷签；Escape/遮罩/取消可关，失败提示弹窗内可见）
 * 数据：GET /api/home 一次聚合（类型见 features/home/types.ts）
 */

import Link from 'next/link';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COVER_IMAGE_EXT_MIME,
  COVER_IMAGE_MAX_BYTES,
  COVER_SEAL_CHARS,
  COVER_TEXTURES,
  COVER_VOLUMES,
  coverVolumeRank,
  parseCollectionCover,
  type CoverTextureId,
} from '@pinglc/core';
import { api } from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Pagination } from '@/components/Pagination';
import { SOURCE_META, subtitleStatusMeta } from '@/lib/material-meta';
import { fmtDuration, fmtInt, fmtRelative } from '@/lib/format';
import {
  bookCoverCls,
  BookInner,
  BookSample,
  COVER_TEXTURE_BG,
} from '@/features/home/BookSample';
import type { HomeCollection, HomeData } from '@/features/home/types';

/** 轻筛选档位：全部卷帙 / 最近研习 / 未开卷 */
type Filter = 'all' | 'recent' | 'fresh';

/** 集卷分页每页卷数（桌面 4 列 × 3 行一屏的书架量） */
const PAGE_SIZE = 12;

/** 立卷弹窗卷名长度上限（仿「创建材料集」设计稿 40 字计数器） */
const NAME_MAX = 40;

/** CEFR 梯级选项（值落库 A2~C2；别称小注仿「创建材料集」设计稿梯级注解） */
const CEFR_OPTIONS = [
  { value: 'A2', alias: '启蒙发轫' },
  { value: 'B1', alias: '登堂渐进' },
  { value: 'B2', alias: '沉潜熟稔' },
  { value: 'C1', alias: '文采雅致' },
  { value: 'C2', alias: '神会通达' },
] as const;

/* 封面插画闸（core 单源：MIME 集合自扩展名↔MIME 对照表、体积上限常量，
 * 与上传服务端闸同源——两侧各自手写字面量会静默漂移） */
const COVER_IMAGE_TYPES = new Set(Object.values(COVER_IMAGE_EXT_MIME));
const COVER_IMAGE_MAX = COVER_IMAGE_MAX_BYTES;

/**
 * 印文清洗：去首尾空白后取最后一个字符（Unicode 码点计，与 core 单字清洗一致）。
 * 取「最后一个」而非第一个：已有单字再键入新字时新键入胜出，符合单字输入直觉
 * @param v 输入框原始值（可能超长或含空白）
 */
function sanitizeSeal(v: string): string {
  return Array.from(v.trim()).pop() ?? '';
}

/**
 * 藏经阁页组件：全库集卷卡网格/列表 + 立卷/编辑弹窗
 */
export default function LibraryPage() {
  const qc = useQueryClient();
  /* 建卷/编辑共用弹窗：creating 控制开闭，editing 非空即编辑模式（预填该卷现值） */
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HomeCollection | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cefr, setCefr] = useState<string | null>(null);
  const [texture, setTexture] = useState<CoverTextureId>('linen');
  /* 卷脊印文（非必选：默认不落印；候选预设 + 自定义） */
  const [seal, setSeal] = useState<string>('');
  /* 自定义印文（会话级候选：预设外的历史印文与「+」新增都进这里，去重后附在预设后） */
  const [customSeals, setCustomSeals] = useState<string[]>([]);
  /* 「+」新增印文的内联输入态（开合 + 草稿；组字中不清洗以免打断 IME） */
  const [addingSeal, setAddingSeal] = useState(false);
  const [sealDraft, setSealDraft] = useState('');
  const sealComposingRef = useRef(false);
  /* Esc 取消标记：抑制随后（若浏览器派发）的 blur 误提交 */
  const sealCancelRef = useRef(false);
  /* 册序编排（''=未编排：存量卷不因编辑被静默安上「卷壹」卷签与跳序） */
  const [volume, setVolume] = useState<string>('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverUrl, setCoverUrl] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  /* 已上传插画缓存：立卷失败重试时复用同一张图，避免每次重试都落一份无主图 */
  const uploadedCoverRef = useRef<{ file: File; path: string } | null>(null);
  /* 轻筛选档位 */
  const [filter, setFilter] = useState<Filter>('all');
  /* 集卷分页页码（1 起）：筛选换档回第一页；数据已在客户端全量在手，纯前端切片 */
  const [page, setPage] = useState(1);
  /* 集卷网格引用（翻页后滚回列表首，避免停在长列表页底） */
  const gridRef = useRef<HTMLElement | null>(null);

  /* 印文候选：预设 + 会话内自定义（Set 去重，自定义印文与预设重合时预设优先） */
  const sealOptions = useMemo(() => [...new Set([...COVER_SEAL_CHARS, ...customSeals])], [customSeals]);

  /** 表单全量复位（openCreate 与建卷成功共用同一份字段清单，防两处各自
   *  维护漂移——此前 onSuccess 少清了质地/印文/册序等六项） */
  const resetForm = () => {
    setName('');
    setDescription('');
    setCefr(null);
    setTexture('linen');
    setSeal('');
    /* 从零开始：自定义印文候选与「+」输入态一并复位 */
    setCustomSeals([]);
    setAddingSeal(false);
    setSealDraft('');
    setVolume('');
    setCoverFile(null);
    setCoverUrl('');
    uploadedCoverRef.current = null;
  };

  /** 打开立卷弹窗（从零开始：清编辑态与全部表单字段） */
  const openCreate = () => {
    setEditing(null);
    resetForm();
    setCreateError(null);
    setCreating(true);
  };

  /** 打开编辑弹窗（预填库中现值：题名/题记/梯级 + 封面四维；插画以库内 URL 预览） */
  const openEdit = useCallback((c: HomeCollection) => {
    const cover = parseCollectionCover(c.cover);
    setEditing(c);
    setName(c.name);
    setDescription(c.description ?? '');
    setCefr(c.cefrLevel ?? null);
    /* 质地经白名单收窄（parseCollectionCover 类型宽出 string，state 需 CoverTextureId） */
    setTexture(COVER_TEXTURES.find((t) => t.id === cover?.texture)?.id ?? 'linen');
    setSeal(cover?.seal ?? '');
    /* 预设外的历史印文（此前「+」新增落库）并入候选，否则选中态无处显示 */
    if (cover?.seal && !(COVER_SEAL_CHARS as readonly string[]).includes(cover.seal)) {
      setCustomSeals((prev) => (prev.includes(cover.seal!) ? prev : [...prev, cover.seal!]));
    }
    /* 未编排册序的存量卷保持未编排（''），不静默安上卷壹 */
    setVolume(cover?.volume ?? '');
    setCoverFile(null);
    /* 库内插画预览 URL 带内容版本参数：封面路由按 URL 长缓存，换图后
       同一路径会命中旧缓存（?v= 换图即换 URL，缓存自然失效） */
    setCoverUrl(cover?.image ? `/api/collections/${c.id}/cover?v=${encodeURIComponent(cover.image)}` : '');
    uploadedCoverRef.current = null;
    setCreateError(null);
    setCreating(true);
  }, []);

  /** 提交「+」印文草稿：清洗取单字入候选并选中；空白草稿视为取消（Esc 打过取消标记则直接忽略） */
  const commitSealDraft = () => {
    if (sealCancelRef.current) {
      sealCancelRef.current = false;
      return;
    }
    const ch = sanitizeSeal(sealDraft);
    setAddingSeal(false);
    setSealDraft('');
    if (!ch) return;
    setCustomSeals((prev) => (prev.includes(ch) ? prev : [...prev, ch]));
    setSeal(ch);
  };

  /** 取消「+」印文输入（丢弃草稿；打标记抑制输入框卸载后可能派发的 blur 误提交） */
  const cancelSealDraft = () => {
    sealCancelRef.current = true;
    setAddingSeal(false);
    setSealDraft('');
  };

  /**
   * 删除自定义印文（仅会话候选，不触库：已落库卷的印文编辑时会重新并入候选；
   * 预设两印不可删）。正被选中的删除后回落为空（不落印）
   * @param ch 待删印文字符
   */
  const removeSeal = (ch: string) => {
    setCustomSeals((prev) => prev.filter((c) => c !== ch));
    if (seal === ch) setSeal('');
  };

  /**
   * 选取/拖入/移除封面插画：类型与体积前置校验（与服务端闸一致），
   * 同时产出本地预览 objectURL；传 null 即移除
   */
  const pickCover = (file: File | null) => {
    if (!file) {
      setCoverFile(null);
      setCoverUrl('');
      return;
    }
    if (!COVER_IMAGE_TYPES.has(file.type)) {
      setCreateError('封面插画仅支持 PNG / JPG / WebP');
      return;
    }
    if (file.size > COVER_IMAGE_MAX) {
      setCreateError('封面插画超过 5MB');
      return;
    }
    setCreateError(null);
    setCoverFile(file);
    setCoverUrl(URL.createObjectURL(file));
  };

  /* 封面预览 objectURL 生命周期：换图/卸载时释放旧的（二次 revoke 无害） */
  useEffect(() => {
    return () => {
      if (coverUrl) URL.revokeObjectURL(coverUrl);
    };
  }, [coverUrl]);

  /* 首页聚合数据（一次请求供全页） */
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/api/home') });

  const data = home.data;
  // memo 兜底空数组：保证 useMemo(筛选) 依赖引用稳定（未加载时不产生新数组）
  const collections = useMemo(() => data?.collections ?? [], [data]);

  /* 深链编辑：/library?edit=<id>（详情页编辑入口跳转而来）——数据到位后自动打开
     该卷编辑弹窗，随即清参防刷新重开；卷不存在（参数过期）静默忽略 */
  useEffect(() => {
    if (collections.length === 0) return;
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (!editId) return;
    const target = collections.find((c) => c.id === Number(editId));
    if (target) openEdit(target);
    window.history.replaceState(null, '', window.location.pathname);
  }, [collections, openEdit]);
  const recentCount = collections.filter((c) => c.lastStudiedAt != null).length;
  const freshCount = collections.filter((c) => c.progressPct === 0).length;

  /* 新选封面上传（同一张图重试只传一次：服务端 201 回库内路径 covers/<uuid>.<ext>；
     未选新图返回 undefined）——立卷与编辑共用 */
  const uploadCoverIfNeeded = async (): Promise<string | undefined> => {
    if (!coverFile) return undefined;
    if (uploadedCoverRef.current?.file === coverFile) return uploadedCoverRef.current.path;
    const fd = new FormData();
    fd.append('file', coverFile);
    const up = await api<{ path: string }>('/api/collections/cover-image', {
      method: 'POST',
      body: fd,
    });
    uploadedCoverRef.current = { file: coverFile, path: up.path };
    return up.path;
  };

  /* 建卷（有插画先上传落盘换取库内路径，再连同封面配置立卷；成功后失效首页聚合缓存） */
  const create = useMutation({
    mutationFn: async () => {
      const image = await uploadCoverIfNeeded();
      return api<{ id: number }>('/api/collections', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          cefrLevel: cefr,
          cover: { texture, seal, volume, ...(image ? { image } : {}) },
        }),
      });
    },
    onSuccess: () => {
      setCreating(false);
      resetForm();
      setCreateError(null);
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
    // 创建失败必须可见（静默复位会让用户无从得知失败原因）
    onError: (err) => setCreateError(err.message),
  });

  /* 存卷（编辑模式提交：PATCH 全量字段；未换插画且未移除时沿用库中原路径） */
  const update = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error('无编辑目标');
      const uploaded = await uploadCoverIfNeeded();
      /* coverUrl 非空且无新选文件 = 预填的原有插画未动（pickCover(null) 会清空 coverUrl） */
      const original = parseCollectionCover(editing.cover)?.image;
      const image = uploaded ?? (coverUrl && original ? original : undefined);
      return api(`/api/collections/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          description,
          cefrLevel: cefr,
          cover: { texture, seal, volume, ...(image ? { image } : {}) },
          /* 册序即真排序：卷签 rank 同步写入 sortOrder（select 恒出白名单值） */
          sortOrder: coverVolumeRank(volume) ?? 0,
        }),
      });
    },
    onSuccess: () => {
      setCreating(false);
      setEditing(null);
      setCreateError(null);
      void qc.invalidateQueries({ queryKey: ['home'] });
      /* 详情页缓存同步刷新（浏览器返回详情时看到新卷名） */
      if (editing) void qc.invalidateQueries({ queryKey: ['collection', editing.id] });
    },
    // 保存失败必须可见且不关弹窗（字段保留可改后重试）
    onError: (err) => setCreateError(err.message),
  });

  /** 关闭立卷弹窗：清错误、保留已填字段（编辑模式重开时按库值重新预填）。
   *  提交进行中不关：关了的话失败错误会写进已关闭的弹窗，下一次 openCreate
   *  又把它清掉——失败对用户不可见（useCallback：Escape 监听 effect 依赖它） */
  const closeCreate = useCallback(() => {
    if (create.isPending || update.isPending) return;
    setCreating(false);
    setCreateError(null);
  }, [create.isPending, update.isPending]);

  /* 立卷弹窗打开期间监听 Escape 关闭（与点遮罩 / 取消钮同一路径） */
  useEffect(() => {
    if (!creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCreate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating, closeCreate]);

  /* 删除材料集（物理删：级联清卷内材料/字幕与媒体目录；DELETE /api/collections/[id]） */
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/collections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['home'] });
      /* 删除成功关确认弹窗（失败保持打开：用户可改主意取消或重试） */
      setDeleting(null);
    },
    // 删除失败经确认弹窗 error 槽就地展示（弹窗保持打开可取消/重试，
    // 不弹阻塞线程的原生 alert）
  });

  /* 待删集卷（非空即删除确认弹窗开着；存整卷对象供弹窗取卷名与篇数） */
  const [deleting, setDeleting] = useState<HomeCollection | null>(null);

  /**
   * 打开删除确认弹窗（级联后果与不可恢复在弹窗正文交代）
   * @param c 目标集卷
   */
  const confirmRemove = (c: HomeCollection) => {
    setDeleting(c);
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

  /* 分页总页数与有效页码：筛选变少后页码越界时钳到末页（渲染期收敛，免空页） */
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  /* 当前页卷帙切片（另辟新案占位卡不占页宽：恒随当前页渲染在队尾） */
  const paged = useMemo(
    () => filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE),
    [filtered, curPage],
  );

  /**
   * 翻页：更新页码并把集卷网格滚回视口（scroll-mt 让开移动端吸顶头）
   * @param p 目标页码（1 起）
   */
  const changePage = (p: number) => {
    setPage(p);
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    /* 页面容器：双端同款 bg-surface 冷灰页底；移动 px-5 收缩，桌面 px-10 同 _10 */
    <div className="w-full bg-surface px-5 py-6 md:px-10 md:py-10 md:pb-16">
      {home.isLoading ? (
        <p className="py-16 text-center text-body-sm text-on-surface-variant">装载中…</p>
      ) : home.isError ? (
        /* 查询失败 ≠ 空库：落到空态会误导用户以为数据丢失 */
        <p className="py-16 text-center text-body-sm text-destructive">
          藏经阁装载失败：{home.error.message}
        </p>
      ) : data ? (
        <>
          {/* ===== 续研书签（移动专属功能卡，冷灰化）：最近停留 + 即刻续研 ===== */}
          {data.resume ? (
            <section className="mb-4 flex flex-col gap-2 rounded-[8px] bg-surface-container-lowest p-4 shadow-sm md:hidden">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-label-sm text-shell-bamboo">
                  <span className="material-symbols-outlined animate-pulse text-base">
                    timelapse
                  </span>
                  续研书签 · 最近停留
                </span>
                <span className="text-label-sm text-outline">
                  {fmtRelative(data.resume.updatedAt)}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-serif text-base leading-snug text-on-surface">
                    {data.resume.materialTitle}
                  </h3>
                  <p className="mt-0.5 line-clamp-1 text-body-sm text-on-surface-variant">
                    已精读至{' '}
                    <span className="font-semibold text-shell-seal">
                      第 {data.resume.maxCueIndex + 1} 句
                    </span>{' '}
                    / 共 {data.resume.cueCount} 句
                    {data.resume.lastCueText && <> · 「{data.resume.lastCueText}」</>}
                  </p>
                </div>
                {/* 即刻续研：回播放页（播放器自动续播最近停留点） */}
                <Link
                  href={`/material/${data.resume.materialId}`}
                  className="flex shrink-0 items-center gap-1 rounded-sm bg-shell-seal px-3 py-1.5 text-label-md text-on-shell-seal"
                >
                  <span className="material-symbols-outlined text-sm">play_arrow</span>
                  即刻续研
                </Link>
              </div>
              {/* 进度条：container-high 槽 + 竹青填充 */}
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high">
                <div
                  className="h-full rounded-full bg-shell-bamboo transition-all"
                  style={{ width: `${data.resume.progressPct}%` }}
                />
              </div>
            </section>
          ) : null}

          {/* ===== 页头 + 统计卡（双端同构，_10）：卷首抬头 + 四格韵数 ===== */}
          <section className="flex flex-col gap-2">
            {/* 卷首抬头：小签 + 大标题 + 引文（快捷动作组已移除：导入/建卷入口由顶栏、快速导入卡与「另辟新案」卡承担） */}
            <div className="flex max-w-2xl flex-col gap-1">
                {/* 卷首小签 + 在库注脚 */}
                <div className="flex flex-wrap items-center gap-1">
                  {/* 圆角 12px（参考稿 rounded-full=0.75rem 的圆角矩形，非正圆胶囊） */}
                  <span className="rounded-xl bg-surface-container-high px-2 py-0.5 text-label-sm uppercase tracking-widest text-on-surface-variant">
                    藏经阁 · 聚纳百卷
                  </span>
                  <span className="text-label-sm text-outline">
                    已藏 {data.stats.collectionCount} 卷 · {data.stats.materialCount} 篇
                  </span>
                </div>
                {/* 大标题（移动 28px / 桌面 48px 衬线；引文已删，抬头只留小签 + 大标题） */}
                <h1 className="font-serif text-headline-md font-normal tracking-tight text-on-surface md:text-headline-xl">
                  藏经阁 · 材料汇聚文库
                </h1>
            </div>
            {/* 统计卡网格：白纸卡 + 角标圆章 + 韵数（移动两列 / lg 四列；与抬头的间距由父级 gap-2 单源控制） */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {(
                [
                  {
                    icon: 'collections_bookmark',
                    label: '收录卷集',
                    value: String(data.stats.collectionCount),
                    unit: '个材料集',
                    sub: `共 ${data.stats.materialCount} 篇材料`,
                    subIcon: 'trending_up',
                    subTone: 'text-shell-bamboo',
                    accent: false,
                  },
                  {
                    icon: 'movie',
                    label: '入阁音视频材料',
                    value: String(data.stats.materialCount),
                    unit: '部典籍',
                    sub: `累计 ${fmtDuration(data.stats.totalDurationMs)}`,
                    subIcon: 'headphones',
                    subTone: 'text-on-surface-variant',
                    accent: false,
                  },
                  {
                    icon: 'history_edu',
                    label: '已研句段',
                    value: fmtInt(data.stats.studiedSentenceCount),
                    unit: '句研磨',
                    sub: '双语字幕逐句听过累计',
                    subIcon: 'check_circle',
                    subTone: 'text-shell-bamboo',
                    accent: false,
                  },
                  {
                    icon: 'brush',
                    label: '研墨生词典藏',
                    value: fmtInt(data.stats.wordCount),
                    unit: '雅词入册',
                    sub: '词藏全部收录',
                    subIcon: 'local_fire_department',
                    subTone: 'text-on-surface-variant',
                    accent: true,
                  },
                ] as Array<{
                  icon: string;
                  label: string;
                  value: string;
                  unit: string;
                  sub: string;
                  subIcon: string;
                  subTone: string;
                  accent: boolean;
                }>
              ).map((s) => (
                /* 单张统计卡：白底 + 右上圆章（悬停转深朱）+ 弱化标签 + 韵数 + 注脚 */
                <div
                  key={s.label}
                  className="group relative flex flex-col justify-between overflow-hidden rounded-sm bg-surface-container-lowest p-4 shadow-sm md:p-6"
                >
                  <span
                    aria-hidden
                    className="absolute right-3 top-3 flex size-10 items-center justify-center rounded-full bg-surface-container text-outline transition-colors group-hover:text-shell-seal"
                  >
                    <span className="material-symbols-outlined text-[20px]">{s.icon}</span>
                  </span>
                  <div className="flex flex-col">
                    <span className="text-label-sm uppercase tracking-wider text-outline">
                      {s.label}
                    </span>
                    <p
                      className={`mt-1 font-normal text-headline-md md:text-headline-lg ${
                        s.accent ? 'text-shell-seal' : 'text-on-surface'
                      }`}
                    >
                      {s.value}{' '}
                      <span className="text-body-sm text-on-surface-variant">{s.unit}</span>
                    </p>
                  </div>
                  <p className={`mt-4 flex items-center gap-1 text-label-sm ${s.subTone}`}>
                    <span className="material-symbols-outlined text-sm">{s.subIcon}</span>
                    {s.sub}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* ===== 案头近况（桌面专属，_10；移动端隐藏——最近动态由续研书签承担，避免同屏重复）：最近活跃材料（排序=最近学习时间与导入时间取大；lg 起横排） ===== */}
          <section className="mt-10 hidden flex-col gap-4 md:flex">
            {/* 区段头：深朱圆点 + 衬线小标 + 注脚（右侧「查阅全部」链接不入稿：应用无流水页） */}
            <div className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 rounded-full bg-shell-seal" />
              <h2 className="font-serif text-headline-sm font-normal text-on-surface">
                案头近况 · 研读与入阁
              </h2>
              <span className="text-label-sm text-outline">最近所习与最新所藏</span>
            </div>
            {/* 白纸横条容器：条目悬停染 container-low */}
            <div className="flex flex-col gap-1 rounded-[8px] bg-surface-container-lowest p-1 shadow-sm">
              {data.recent.length === 0 ? (
                <p className="p-6 text-center text-body-sm text-on-surface-variant">
                  尚无入阁材料——先导入一篇试试。
                </p>
              ) : (
                data.recent.map((m) => {
                  /* 展示元单源：来源类型 + 校订状态（未知回退，不写散落三元） */
                  const src = SOURCE_META[m.sourceType] ?? SOURCE_META.audio!;
                  const st = subtitleStatusMeta(m.subtitleStatus);
                  return (
                  <Link
                    key={m.materialId}
                    href={`/material/${m.materialId}`}
                    className="flex flex-col justify-between gap-4 rounded-sm p-4 transition-colors hover:bg-surface-container-low lg:flex-row lg:items-center"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      {/* 来源图标块（映射与集详情页共用单源） */}
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-sm bg-surface-container text-shell-seal">
                        <span className="material-symbols-outlined text-[26px]">
                          {src.icon}
                        </span>
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="truncate text-title-sm text-on-surface">
                            {m.title}
                          </span>
                          {/* 所属集签（12px 圆角，仿参考稿 rounded-full 重定义） */}
                          <span className="shrink-0 rounded-xl bg-surface-container-high px-2 py-0.5 text-label-sm text-on-surface-variant">
                            所属：《{m.collectionName}》
                          </span>
                        </div>
                        {/* 元数据行：时长 / 句词数 / 校订状态（outline 注脚；就绪竹青） */}
                        <div className="mt-1 flex flex-wrap items-center gap-4 text-body-sm text-outline">
                          {m.mediaDurationMs != null && (
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-base">
                                schedule
                              </span>
                              {fmtDuration(m.mediaDurationMs)}
                            </span>
                          )}
                          {m.sentenceCount != null && (
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-base">
                                record_voice_over
                              </span>
                              {m.sentenceCount} 句
                              {m.uniqueWordCount != null && <> / {fmtInt(m.uniqueWordCount)} 词</>}
                            </span>
                          )}
                          <span className={`flex items-center gap-1 ${st.tone}`}>
                            <span className="material-symbols-outlined text-base">
                              {st.icon}
                            </span>
                            {st.label}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end lg:self-center">
                      {/* 研读进度（窄屏隐藏，与参考稿响应行为一致） */}
                      <span className="mr-1 hidden flex-col items-end sm:flex">
                        <span className="text-label-sm text-outline">研读进度</span>
                        <span
                          className={`font-medium text-title-sm ${
                            m.progressPct > 0 ? 'text-shell-bamboo' : 'text-on-surface-variant'
                          }`}
                        >
                          {m.progressPct > 0 ? `${m.progressPct}%` : '未开卷'}
                        </span>
                      </span>
                      {/* 进入精读按钮形态（整行皆链接，按钮仅为视觉形态） */}
                      <span className="flex items-center gap-1 rounded-sm bg-surface-container px-4 py-1 text-title-sm text-on-surface">
                        <span className="material-symbols-outlined text-lg">menu_book</span>
                        精读 Reader
                      </span>
                    </div>
                  </Link>
                  );
                  })
              )}
            </div>
          </section>

          {/* ===== 集卷控制栏：筛选药丸（卷面恒为方格卷展，原视图切换已移除） ===== */}
          {collections.length > 0 && (
            <div className="mb-6 mt-10 flex items-center gap-2 overflow-x-auto py-1">
              {(
                [
                  { key: 'all', label: `全部卷帙 (${collections.length})` },
                  { key: 'recent', label: `最近研习 (${recentCount})` },
                  { key: 'fresh', label: `未开卷 (${freshCount})` },
                ] as Array<{ key: Filter; label: string }>
              ).map((p) => (
                <button
                  key={p.key}
                  onClick={() => {
                    setFilter(p.key);
                    /* 换筛选档回第一页（各档卷数不同，沿用旧页码易落空页） */
                    setPage(1);
                  }}
                  className={`shrink-0 rounded-xl px-4 py-1.5 transition-colors ${
                    filter === p.key
                      ? 'bg-surface-container-highest text-title-sm text-on-surface'
                      : 'text-body-sm text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {/* ===== 集卷卡列表（空态两分支收敛在 ListEmptyState，主流程不嵌套三元） ===== */}
          {filtered.length === 0 ? (
            <ListEmptyState isEmptyLibrary={collections.length === 0} onOpen={openCreate} />
          ) : (
            <section
              ref={gridRef}
              className="grid scroll-mt-20 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-center gap-4 md:gap-6"
            >
              {paged.map((c) => (
                <CollectionCard
                  key={c.id}
                  c={c}
                  onEdit={() => openEdit(c)}
                  onDelete={() => confirmRemove(c)}
                  removing={remove.isPending && remove.variables === c.id}
                />
              ))}
              {/* 新建占位卡（仿 _10「另辟新案」虚线卡；双端同款）：宽随轨道拉伸、
                  高按 4:5 比例，与书影卡同宽同高（书架上的空书位）；内距/行距
                  收紧以保内容不撑破比例盒；分页下恒随当前页队尾渲染——
                  建卷入口不因翻页缺席 */}
              <button
                onClick={openCreate}
                className="group flex aspect-[4/5] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[8px] border-2 border-dashed border-outline-variant/60 bg-surface-container-lowest/50 p-4 text-center transition-colors hover:border-shell-seal hover:bg-surface-container-lowest"
              >
                {/* 悬停转浅朱印圆 */}
                <span className="flex size-14 items-center justify-center rounded-full bg-surface-container text-outline transition-all group-hover:bg-primary-fixed group-hover:text-shell-seal">
                  <span className="material-symbols-outlined text-[28px]">add</span>
                </span>
                <span className="font-serif text-headline-sm text-on-surface transition-colors group-hover:text-shell-seal">
                  另辟新案
                </span>
                <span className="mt-1 max-w-xs text-body-sm text-outline">
                  归拢专属主题的播客、公开课或影视对白，设立专属生词谱与精读节奏
                </span>
                <span className="mt-2 rounded-sm bg-primary-fixed/50 px-4 py-1 text-label-md text-shell-seal">
                  点击即刻开启新卷
                </span>
              </button>
            </section>
          )}

          {/* ===== 底部分页栏（_10 分页栏位）：集卷分页控件（单页自动不出） ===== */}
          {totalPages > 1 && (
            <div className="mt-16 flex justify-center">
              <Pagination page={curPage} totalPages={totalPages} onChange={changePage} label="集卷分页" />
            </div>
          )}

          {/* ===== 立卷弹窗（仿「创建材料集」设计稿双栏：左「装帧成相」书影试样 +
               质地/插画/印文/册序，右「基础案目」题名/题记/CEFR；标题沿用
               「另辟新卷 · 新建材料集」；Escape / 点遮罩 / 取消均可关） ===== */}
          {creating && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={editing ? '编辑材料集' : '新建材料集'}
              className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-5"
              onClick={(e) => {
                /* 仅点遮罩空白处关闭（表单内点击 target 非遮罩自身，不触发） */
                if (e.target === e.currentTarget) closeCreate();
              }}
            >
              {/* 弹窗卡：白纸卡 + 8px 圆角 + 轻投影；窄屏单列纵排，md 起仿设计稿左右双栏 */}
              <form
                className="grid max-h-full w-full max-w-3xl grid-cols-1 gap-5 overflow-y-auto rounded-[8px] bg-surface-container-lowest p-5 shadow-lg md:grid-cols-2 md:gap-6 md:p-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  /* 编辑模式存卷（PATCH），否则立卷（POST） */
                  if (editing) update.mutate();
                  else create.mutate();
                }}
              >
                {/* 头行：深朱小印 + 标题 + 关闭钮（双栏通栏） */}
                <div className="flex items-center justify-between md:col-span-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-shell-seal text-on-shell-seal">
                      <span className="material-symbols-outlined text-base">
                        {editing ? 'edit' : 'bookmark_add'}
                      </span>
                    </span>
                    <h3 className="text-title-sm text-on-surface">
                      {editing ? '校订卷帙 · 编辑材料集' : '另辟新卷 · 新建材料集'}
                    </h3>
                  </div>
                  <button
                    type="button"
                    aria-label={editing ? '取消编辑' : '取消新建'}
                    onClick={closeCreate}
                    disabled={create.isPending || update.isPending}
                    className="p-1 text-on-surface-variant transition-colors hover:text-on-surface disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-xl">close</span>
                  </button>
                </div>

                {/* ===== 左栏：装帧成相（仿设计稿装帧试样卡；区段标题按需求不入页面） ===== */}
                <div className="flex flex-col gap-4">
                  {/* 书影试样台：案头试样共享组件（与藏经阁卷卡封面单源同款——
                      双氛围晕 + 线装书 mockup 均在 BookSample 内渲染） */}
                  <BookSample
                    texture={texture}
                    name={name}
                    description={description}
                    volume={volume}
                    seal={seal}
                    cefr={cefr}
                    imageSlot={
                      coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- blob: 本地预览对象 URL，next/image 优化器无法接管
                        <img
                          src={coverUrl}
                          alt="封面插画预览"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : undefined
                    }
                  />
                  {/* 装帧质地选择（仿设计稿四质地格：色板圆 + 质地名 + 副注） */}
                  <div className="flex flex-col gap-1.5">
                    <div className="grid grid-cols-2 gap-2">
                      {COVER_TEXTURES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          aria-pressed={texture === t.id}
                          onClick={() => setTexture(t.id)}
                          className={`flex items-center gap-2 rounded-sm p-2 text-left transition-colors ${
                            texture === t.id
                              ? 'bg-surface-container-highest'
                              : 'bg-surface-container hover:bg-surface-container-high'
                          }`}
                        >
                          {/* 质地色板圆 */}
                          <span
                            aria-hidden
                            className={`size-5 shrink-0 rounded-full shadow-inner ${COVER_TEXTURE_BG[t.id].swatch}`}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-body-sm font-semibold text-on-surface">
                              {t.label}
                            </span>
                            <span className="truncate text-[10px] text-on-surface-variant">{t.sub}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 封面插画拾取（整行 label 热区 + 拖放；设计稿「AI 文心绘卷」不入——
                      引擎无图像生成能力，不造假入口） */}
                  <div className="flex flex-col gap-1.5">
                    <label
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-sm bg-surface-container px-3 py-2 transition-colors hover:bg-surface-container-high"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        pickCover(e.dataTransfer.files[0] ?? null);
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-surface-container-highest text-on-surface-variant">
                          <span aria-hidden className="material-symbols-outlined text-lg">
                            add_photo_alternate
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-body-sm font-medium text-on-surface">
                            {coverFile ? coverFile.name : '拖拽版画或点击自选配图'}
                          </span>
                          <span className="text-label-sm text-on-surface-variant">
                            PNG / JPG / WebP · ≤5MB
                          </span>
                        </span>
                      </span>
                      <span className="shrink-0 rounded-sm bg-surface-container-highest px-2.5 py-1 text-label-sm text-on-surface">
                        {coverFile ? '已选' : '浏览'}
                      </span>
                      {/* 隐藏文件选择器（label 即拾取热区；读值后清空 value，
                          否则重选同一文件不派发 change，拾取静默失效） */}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          pickCover(e.target.files?.[0] ?? null);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {/* 已选图/编辑预填的原有插画移除（连带释放本地预览） */}
                    {(coverFile || coverUrl) && (
                      <button
                        type="button"
                        onClick={() => pickCover(null)}
                        className="self-start text-label-sm text-on-surface-variant underline-offset-2 transition-colors hover:text-destructive hover:underline"
                      >
                        移除插画
                      </button>
                    )}
                  </div>
                  {/* 印文与册序（仿设计稿卷脊印文 / 册序编排双格） */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-title-sm text-on-surface">卷脊印文</span>
                      {/* 印文候选（预设 + 自定义，去重；非必选——再点已选项即清除，
                          仿 CEFR 选择器）；「+」展开内联单字输入：Enter/失焦提交，Esc 取消；
                          自定义印文右上角「×」可删（预设不可删），正选中删除后回落不落印 */}
                      <div className="grid grid-cols-4 gap-1.5">
                        {sealOptions.map((ch) => (
                          /* 外层 div 承载选中钮与删除角标（按钮不可嵌套） */
                          <div key={ch} className="relative">
                            <button
                              type="button"
                              aria-pressed={seal === ch}
                              onClick={() => setSeal(seal === ch ? '' : ch)}
                              className={`w-full rounded-xs py-1.5 text-center font-serif text-sm font-bold transition-colors ${
                                seal === ch
                                  ? 'bg-shell-seal text-on-shell-seal'
                                  : 'bg-surface-container text-on-surface hover:bg-surface-container-high'
                              }`}
                            >
                              {ch}
                            </button>
                            {/* 删除角标：仅自定义印文（预设两印固定常驻） */}
                            {!(COVER_SEAL_CHARS as readonly string[]).includes(ch) && (
                              <button
                                type="button"
                                aria-label={`删除印文「${ch}」`}
                                title="从候选移除"
                                onClick={() => removeSeal(ch)}
                                className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-surface text-outline transition-colors hover:text-destructive"
                              >
                                <span aria-hidden className="material-symbols-outlined text-[10px] leading-none">
                                  close
                                </span>
                              </button>
                            )}
                          </div>
                        ))}
                        {addingSeal ? (
                          /* 单字输入格：组字中不清洗（IME 拼音暂存超长是常态），组字结束再截单字 */
                          <input
                            autoFocus
                            value={sealDraft}
                            aria-label="自定义印文（单个字）"
                            placeholder="字"
                            onChange={(e) => {
                              if (sealComposingRef.current) {
                                setSealDraft(e.target.value);
                                return;
                              }
                              setSealDraft(sanitizeSeal(e.target.value));
                            }}
                            onCompositionStart={() => {
                              sealComposingRef.current = true;
                            }}
                            onCompositionEnd={(e) => {
                              sealComposingRef.current = false;
                              setSealDraft(sanitizeSeal(e.currentTarget.value));
                            }}
                            onKeyDown={(e) => {
                              /* IME 组字中的 Enter 是选词确认，不作提交 */
                              if (e.nativeEvent.isComposing) return;
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitSealDraft();
                              } else if (e.key === 'Escape') {
                                /* 只取消这个单字输入：阻断冒泡，否则会触发
                                   弹窗级 Escape 监听把整个立卷弹窗关掉 */
                                e.stopPropagation();
                                cancelSealDraft();
                              }
                            }}
                            onBlur={commitSealDraft}
                            className="rounded-xs bg-surface-container py-1.5 text-center font-serif text-sm font-bold text-on-surface outline-none placeholder:text-outline-variant focus:bg-surface-container-high"
                          />
                        ) : (
                          <button
                            type="button"
                            aria-label="新增印文"
                            title="新增印文（限单字）"
                            onClick={() => {
                              sealCancelRef.current = false;
                              sealComposingRef.current = false;
                              setSealDraft('');
                              setAddingSeal(true);
                            }}
                            className="flex items-center justify-center rounded-xs bg-surface-container py-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                          >
                            {/* 加号新增印文（仅图形示意见 aria-hidden） */}
                            <span aria-hidden className="material-symbols-outlined text-base leading-none">
                              add
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="create-volume" className="text-title-sm text-on-surface">
                        册序编排
                      </label>
                      {/* 原生 select（样式仿设计稿；候选集 core COVER_VOLUMES 单源 +
                          「未编排」档——存量卷不编排也不被静默安签；册序即真排序，
                          rank 映射 sortOrder 随立卷/存卷写入，未编排 rank=0 排最前） */}
                      <select
                        id="create-volume"
                        value={volume}
                        onChange={(e) => setVolume(e.target.value)}
                        className="w-full cursor-pointer rounded-sm bg-surface-container px-2 py-2.5 text-body-sm text-on-surface outline-none"
                      >
                        <option value="">未编排</option>
                        {COVER_VOLUMES.map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.value}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* ===== 右栏：基础案目（题名/题记/CEFR） ===== */}
                <div className="flex flex-col gap-4">
                  {/* 题名字段：标签 + 必填星 + 字数计数（计数器仿设计稿 15/40 行） */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="create-name" className="text-title-sm text-on-surface">
                        材料集题名 <span className="text-shell-seal">*</span>
                      </label>
                      <span className="text-label-sm text-on-surface-variant">
                        {name.length}/{NAME_MAX}
                      </span>
                    </div>
                    {/* 输入行：container 槽底 + menu_book 引导印 + 聚焦转纸白轻投影（仿设计稿输入行） */}
                    <div className="flex items-center gap-2 rounded-sm bg-surface-container px-3 py-2 transition-all focus-within:bg-surface-container-lowest focus-within:shadow-sm">
                      <span aria-hidden className="material-symbols-outlined text-xl text-outline">
                        menu_book
                      </span>
                      <input
                        id="create-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={NAME_MAX}
                        placeholder="例如：《经济学人·社论精读》"
                        autoFocus
                        className="w-full border-none bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant"
                      />
                    </div>
                  </div>
                  {/* 题记字段：可选副标与导言 */}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="create-desc" className="text-title-sm text-on-surface">
                      卷帙副标与题记
                    </label>
                    {/* 输入区：同题名聚焦语义；两行起步、禁手拖变形 */}
                    <div className="rounded-sm bg-surface-container px-3 py-2 transition-all focus-within:bg-surface-container-lowest focus-within:shadow-sm">
                      <textarea
                        id="create-desc"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={2}
                        placeholder="撰写本卷的导言、研习心法或启发名句…"
                        className="w-full resize-none border-none bg-transparent text-body-md leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
                      />
                    </div>
                  </div>
                  {/* CEFR 梯级字段：可选五段选择器（再点已选项即清除，落库 A2~C2） */}
                  <div className="flex flex-col gap-1.5">
                    {/* 五段槽：container 槽底 + 选中段深朱白字轻投影（仿设计稿 cefr-btn 组） */}
                    <div className="grid grid-cols-5 gap-1 rounded-sm bg-surface-container p-1">
                      {CEFR_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          aria-pressed={cefr === opt.value}
                          onClick={() => setCefr(cefr === opt.value ? null : opt.value)}
                          className={`rounded-xs py-1.5 text-center transition-colors ${
                            cefr === opt.value
                              ? 'bg-shell-seal text-on-shell-seal shadow-sm'
                              : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                          }`}
                        >
                          {/* 梯级大字 + 别称小注（两行纵排，仿设计稿） */}
                          <span className="block text-title-sm">{opt.value}</span>
                          <span className="block text-[10px] opacity-80">{opt.alias}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 失败提示（弹窗内可见；双栏通栏） */}
                {createError && <p className="text-xs text-destructive md:col-span-2">{createError}</p>}
                {/* 动作行：取消（弱化）+ 立卷（深朱主按钮带卷印图标，仿设计稿 active 缩压） */}
                <div className="flex items-center justify-end gap-2 md:col-span-2">
                  <button
                    type="button"
                    onClick={closeCreate}
                    disabled={create.isPending || update.isPending}
                    className="rounded-sm px-4 py-2 text-title-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!name.trim() || create.isPending || update.isPending}
                    className="flex items-center gap-1.5 rounded-sm bg-shell-seal px-4 py-2 text-title-sm text-on-shell-seal transition-all hover:bg-primary active:scale-[0.99] disabled:opacity-50"
                  >
                    <span aria-hidden className="material-symbols-outlined text-lg">
                      {editing ? 'save' : 'history_edu'}
                    </span>
                    {/* 提交键文案（顺序判断不嵌套：进行中示忙 → 编辑存卷 / 建卷立卷） */}
                    {editing
                      ? update.isPending ? '存卷中…' : '存卷'
                      : create.isPending ? '立卷中…' : '立卷'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 删除确认弹窗（纸墨风共享 ConfirmDialog，替代原生 confirm）：卷名衬线强调 +
              级联后果警示条；确认进行中封死关闭路径，失败经 error 槽就地展示、弹窗保持打开可取消/重试 */}
          <ConfirmDialog
            open={deleting !== null}
            title="删除材料集"
            icon="delete_forever"
            confirmLabel="确认删除"
            destructive
            pending={remove.isPending}
            error={remove.isError ? remove.error.message : null}
            onConfirm={() => deleting && remove.mutate(deleting.id)}
            onClose={() => {
              setDeleting(null);
              remove.reset();
            }}
            body={
              <>
                <p>
                  将删除材料集
                  <span className="mx-1 font-serif text-title-sm font-bold text-on-surface">
                    「{deleting?.name ?? ''}」
                  </span>
                </p>
                {(deleting?.materialCount ?? 0) > 0 && (
                  <p className="mt-2 rounded-sm bg-muted px-3 py-2">
                    卷内 {deleting?.materialCount} 篇材料，字幕与媒体文件将一并永久删除，
                    <span className="font-semibold text-destructive">不可恢复</span>。
                  </p>
                )}
              </>
            }
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * 集卷卡（双端同构）：卡即书影本体——Link 直接承载书影类名（bookCoverCls
 * 单源，与立卷弹窗「案头试样」同一 mockup），在集卷网格内直接排布，无卡壳/
 * 案头垫包裹层；题名/题记/卷内统计（篇数·研读进度）/册序卷签/朱印/CEFR 脚注
 * 全在书面上，未配置封面回退 linen 质地
 * @param props.c 集卷聚合数据
 * @param props.onEdit 编辑入口回调（父层打开编辑弹窗并预填本卷现值）
 * @param props.onDelete 删除入口回调（确认弹窗与失败提示在父层统一处理）
 * @param props.removing 该卷删除请求进行中（删除钮禁用防重复提交）
 */
function CollectionCard({
  c,
  onEdit,
  onDelete,
  removing,
}: {
  c: HomeCollection;
  /** 编辑入口回调（父层打开编辑弹窗并预填本卷现值） */
  onEdit: () => void;
  /** 删除入口回调（confirm 确认与失败提示在父层 LibraryPage 统一处理） */
  onDelete: () => void;
  /** 该卷删除请求进行中（删除钮禁用防重复提交） */
  removing: boolean;
}) {
  /* 封面配置解析（cover 列 JSON 契约见 @pinglc/core；空/非法 → 按「未配置封面」
     回退 linen 粗麻布纹，仍走书影同一 mockup） */
  const cover = parseCollectionCover(c.cover);
  return (
    /* 卡即书影本体：锚直接承载书影类名（bookCoverCls 单源），w-full 撑满
       网格轨道（高度按 4:5 比例随宽走）；hover 投影加深示意可点 */
    <Link
      href={`/collection/${c.id}`}
      className={`group w-full hover:shadow-lg ${bookCoverCls(
        (cover?.texture ?? 'linen') as CoverTextureId,
      )}`}
    >
      {/* 书影内层（BookInner 单源）：装订线/卷签行/插画窗/题名题记/卷内统计/朱印/脚注 */}
      <BookInner
        texture={(cover?.texture ?? 'linen') as CoverTextureId}
        name={c.name}
        description={c.description}
        volume={cover?.volume ?? ''}
        seal={cover?.seal ?? ''}
        cefr={c.cefrLevel}
        materialCount={c.materialCount}
        progressPct={c.progressPct}
        imageSlot={
          cover?.image ? (
            /* 插画层：next/image 经优化器接 API 路由图源（fill 铺满插画窗）；
               URL 带 ?v= 内容版本（路由按 URL 长缓存，换图即换 URL）；
               文件缺失时隐藏本层露出卷名首字活字底（不整卡报错） */
            <Image
              src={`/api/collections/${c.id}/cover?v=${encodeURIComponent(cover.image)}`}
              alt={`卷面插画：《${c.name}》`}
              fill
              sizes="(min-width: 768px) 230px, 100vw"
              className="object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : undefined
        }
      />
      {/* 编辑/删除钮组：浮于书影右上角，悬浮/聚焦显形；触屏彻底隐藏禁点
          （移动端入口由详情页页头承担）。按钮置于锚内是「容器内直接排布
          书影、无包裹层」的结构代价：onClick 必须 preventDefault 阻断锚的
          默认跳转，否则点编辑/删除会先触发进卷 */}
      <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:pointer-events-none">
        {/* 编辑：打开编辑弹窗（hover 深朱呼应卷名悬停色） */}
        <button
          type="button"
          aria-label={`编辑材料集「${c.name}」`}
          title="编辑材料集"
          onClick={(e) => {
            e.preventDefault();
            onEdit();
          }}
          className="flex size-8 items-center justify-center rounded-sm bg-surface/85 text-outline backdrop-blur-sm transition-colors hover:bg-surface hover:text-shell-seal"
        >
          <span aria-hidden className="material-symbols-outlined text-lg">
            edit
          </span>
        </button>
        {/* 删除：删除中换沙漏示忙并禁用（提示请求已在途，防重复点击） */}
        <button
          type="button"
          aria-label={`删除材料集「${c.name}」`}
          title="删除材料集"
          disabled={removing}
          onClick={(e) => {
            e.preventDefault();
            onDelete();
          }}
          className="flex size-8 items-center justify-center rounded-sm bg-surface/85 text-outline backdrop-blur-sm transition-colors hover:bg-surface hover:text-destructive disabled:opacity-50"
        >
          <span aria-hidden className="material-symbols-outlined text-lg">
            {removing ? 'hourglass_empty' : 'delete'}
          </span>
        </button>
      </div>
    </Link>
  );
}

/**
 * 集卷列表空态（if/else 顺序判断，不嵌套三元）：空库引导立卷 / 筛选档位空态
 * @param props.isEmptyLibrary 是否全库无卷（true=空库引导，false=档位无命中）
 * @param props.onOpen 立卷入口回调
 */
function ListEmptyState({ isEmptyLibrary, onOpen }: { isEmptyLibrary: boolean; onOpen: () => void }) {
  if (!isEmptyLibrary) {
    /* 筛选档位空态（非空库） */
    return <p className="py-10 text-center text-body-sm text-outline">此档位暂无卷帙。</p>;
  }
  /* 空库引导：立卷起点 */
  return (
    <section className="flex flex-col items-center justify-center rounded-[8px] border border-dashed border-outline-variant/60 bg-surface-container-lowest/50 px-6 py-16 text-center">
      <span className="material-symbols-outlined mb-3 text-4xl text-outline">
        library_books
      </span>
      <p className="font-serif text-lg text-on-surface">尚无卷帙，虚位以待</p>
      <p className="mt-1 max-w-sm text-body-sm text-on-surface-variant">
        先立一卷，再导入音视频自动生成字幕，或导入文本自动生成音频。
      </p>
      <button
        onClick={onOpen}
        className="mt-4 flex items-center gap-1.5 rounded-sm bg-shell-seal px-4 py-2 text-title-sm text-on-shell-seal transition-colors hover:bg-primary"
      >
        <span className="material-symbols-outlined text-lg">create_new_folder</span>
        另辟新卷
      </button>
    </section>
  );
}
