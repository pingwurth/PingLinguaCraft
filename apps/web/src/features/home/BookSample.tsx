'use client';

/**
 * 书影单源 —— 线装书 mockup 的唯一出处
 *
 * 分三层：
 * - bookCoverCls(texture)：书影宿主完整类名（本体形制 + 质地底色）。宿主元素
 *   由调用方决定——弹窗试样台内是 div，卷卡里是 Link（锚）直接承载，同一份
 *   类名保证「弹窗试样长什么样，架上书影就是什么样」。
 * - BookInner：书影内层全部 JSX（装订线/卷签行/插画窗/题名题记/卷内统计/朱印/
 *   脚注），不含宿主元素，调用方放进自己的锚或 div。
 * - BookSample：案头试样组合 = 案头垫（双氛围晕）+ 书影本体 div，立卷弹窗
 *   「装帧成相 · 案头试样」专用；卷卡不再经由它（直接排布本体，无垫无晕）。
 */

import type { ReactNode } from 'react';
import type { CoverTextureId } from '@pinglc/core';

/**
 * 装帧质地 id → 视觉类（web 端呈现层映射；id 白名单在 core COVER_TEXTURES 单源，
 * 键类型收窄为 CoverTextureId——core 加第五种质体会在此编译报缺键，消费端
 * 的无条件索引（COVER_TEXTURE_BG[texture].book）不会运行时炸 undefined。
 * 类名必须字面量出现在此，Tailwind 才能提取——不可拼接生成。
 * ink: 'light' 标记深色底（深黛靛蓝），书影文字需换白系前景反色）
 */
export const COVER_TEXTURE_BG: Record<
  CoverTextureId,
  { book: string; swatch: string; ink?: 'light' }
> = {
  linen: { book: 'bg-surface-container-lowest', swatch: 'bg-surface-container-high' },
  xuan: { book: 'bg-shell-xuan', swatch: 'bg-shell-xuan' },
  indigo: { book: 'bg-shell-indigo', swatch: 'bg-shell-indigo', ink: 'light' },
  ochre: { book: 'bg-primary-fixed/30', swatch: 'bg-primary-fixed' },
};

/** 书影本体静态类名（不含质地底色与宽度——宽度属宿主：弹窗试样 w-48、
    卷卡 w-full 满轨；竖装帧 4:5 比例、左侧留装订线位） */
const BOOK_CLS =
  'relative flex aspect-[4/5] shrink-0 select-none flex-col justify-between overflow-hidden rounded-md p-2.5 shadow-md';

/**
 * 书影宿主完整类名 = 本体形制 + 质地底色（调用方自带宽度类；可再追加
 * hover/focus 附加类。过渡用 transition-all：卷卡锚 hover 加深投影与质地
 * 切换色变同源生效）
 * @param texture 装帧质地 id（core 白名单）
 */
export function bookCoverCls(texture: CoverTextureId): string {
  return `${BOOK_CLS} transition-all ${COVER_TEXTURE_BG[texture].book}`;
}

/** 书影内容属性（弹窗传表单实时值；卷卡传 cover 列解析值） */
export interface BookInnerProps {
  /** 装帧质地 id（core 白名单；卷卡未配置封面时回退 linen 粗麻布纹） */
  texture: CoverTextureId;
  /** 题名（空 → 「未命名卷帙」；兼作插画窗活字底的首字来源） */
  name: string;
  /** 题记（可空；空不渲染） */
  description?: string | null;
  /** 册序卷签（空不落签——未编排册序的存量卷不渲染误导性卷签） */
  volume?: string;
  /** 卷脊印文单字（空不落印——未配置印文的存量卷不渲染） */
  seal?: string;
  /** 梯级（可空 → 脚注显「未设梯级」） */
  cefr?: string | null;
  /** 卷内材料数（可空 → 不渲染统计行：弹窗试样无数据，仅藏经阁卷卡传实值） */
  materialCount?: number;
  /** 研读进度百分比 0~100（随 materialCount 一并渲染；0 显「未开卷」） */
  progressPct?: number;
  /** 插画窗内容槽：弹窗传 blob 预览 <img>，卷卡传 next/image（API 图源）。
      槽内容以 absolute inset-0 盖在活字底上；加载失败隐藏自身即露出活字 */
  imageSlot?: ReactNode;
}

/**
 * 书影内层全部 JSX（不含宿主元素）：装订线四枚装线点 + 册序卷签行 +
 * 插画窗（卷名首字活字垫底，imageSlot 盖于其上）+ 题名题记与卷内统计 +
 * 卷脊朱印（my-auto 居中落印）+ 典藏脚注。题名块紧贴插画窗下方，朱印独立
 * 悬于余量版心保持原位；印文/册序/题记/统计均按「有值才渲染」处理，
 * 未配置不留空占位。
 */
export function BookInner({
  texture,
  name,
  description,
  volume,
  seal,
  cefr,
  materialCount,
  progressPct,
  imageSlot,
}: BookInnerProps) {
  /* 深色质地（深黛靛蓝）：书影文字换白系前景反色 */
  const inkLight = COVER_TEXTURE_BG[texture].ink === 'light';
  /* 插画窗活字底：卷名首字（剥引号书名号前缀；空名回退「卷」） */
  const glyph = name.replace(/^[「《\s]+/, '').slice(0, 1) || '卷';
  return (
    <>
      {/* 左侧装订线（四枚装线点） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-20 flex w-6 flex-col items-center justify-between bg-on-surface/10 py-4"
      >
        <span className="h-3 w-1 rounded-full bg-surface-container-lowest/80 shadow-sm" />
        <span className="h-3 w-1 rounded-full bg-surface-container-lowest/80 shadow-sm" />
        <span className="h-3 w-1 rounded-full bg-surface-container-lowest/80 shadow-sm" />
        <span className="h-3 w-1 rounded-full bg-surface-container-lowest/80 shadow-sm" />
      </div>
      {/* 卷签行：册序徽签 + 微字坊号 */}
      <div className="relative z-10 flex items-center justify-between gap-1 pl-6">
        {volume && (
          <span className="truncate rounded-sm bg-surface-container-highest px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-on-surface">
            {volume}
          </span>
        )}
        <span
          className={`shrink-0 font-mono text-[8px] tracking-widest ${
            inkLight ? 'text-on-shell-seal/70' : 'text-on-surface-variant/70'
          }`}
        >
          LINGUA·CRAFT
        </span>
      </div>
      {/* 封面插画窗（3:2 横幅，与弹窗试样原稿 148×96 同比例，宽驱动等比缩放）：
          卷名首字活字垫底，插画槽（若有）absolute 盖于其上 */}
      <div className="relative z-10 ml-6 mt-1 aspect-[3/2] overflow-hidden rounded-sm bg-surface-container shadow-inner">
        <span
          aria-hidden
          className="flex h-full w-full items-center justify-center font-serif text-3xl text-outline/50"
        >
          {glyph}
        </span>
        {imageSlot}
      </div>
      {/* 题名题记 + 卷内统计（mt-1.5 紧贴插画窗下方，不再垂直居中悬空） */}
      <div className="relative z-10 mt-1.5 pl-6">
        <div className="flex min-w-0 flex-col">
          <span
            className={`line-clamp-2 font-serif text-lg font-bold leading-tight ${
              inkLight ? 'text-on-shell-seal' : 'text-on-surface'
            }`}
          >
            {name.trim() || '未命名卷帙'}
          </span>
          {description?.trim() && (
            <span
              className={`mt-0.5 line-clamp-1 text-[10px] italic ${
                inkLight ? 'text-on-shell-seal/70' : 'text-on-surface-variant'
              }`}
            >
              {description.trim()}
            </span>
          )}
          {/* 卷内统计行：材料篇数 + 研读进度（仅卷卡传实值时渲染；0 进度显「未开卷」） */}
          {materialCount !== undefined && (
            <span
              className={`mt-1 text-[10px] ${
                inkLight ? 'text-on-shell-seal/70' : 'text-on-surface-variant'
              }`}
            >
              {materialCount} 篇材料 · {progressPct != null && progressPct > 0 ? `已研 ${progressPct}%` : '未开卷'}
            </span>
          )}
        </div>
      </div>
      {/* 卷脊朱印：印文单字 + 精校微注（仿设计稿 rotate 落印；未配置不落印）。
          独立于题名块：my-auto 悬于插画窗与脚注间的余量内，保持原版心落印位 */}
      {seal && (
        <div className="relative z-10 my-auto flex justify-end">
          <span className="flex size-8 shrink-0 rotate-[-2deg] flex-col items-center justify-center rounded-sm bg-shell-seal text-on-shell-seal shadow-sm">
            <span className="font-serif text-sm leading-none">{seal}</span>
            <span className="scale-75 text-[6px] tracking-widest opacity-90">精校</span>
          </span>
        </div>
      )}
      {/* 脚注：典藏注记（随 CEFR 联动；mt-auto 与朱印 my-auto 分摊余量——朱印居中落印、
          脚注贴底；质地名不在书面展示——质地由底色自明） */}
      <div
        className={`relative z-10 mt-auto flex items-center gap-1 pl-6 pt-1 text-[10px] ${
          inkLight ? 'text-on-shell-seal/70' : 'text-on-surface-variant'
        }`}
      >
        <span className="truncate">文墨典藏 · {cefr ?? '未设梯级'}</span>
      </div>
    </>
  );
}

/** 案头试样属性（弹窗装帧成相专用；书影内容属性 + 试样垫附加类名。
 *  排除 materialCount/progressPct：试样台永远无卷内统计，类型层面封死
 *  「调用方照类型传值被静默丢弃」的口子） */
export interface BookSampleProps extends Omit<BookInnerProps, 'materialCount' | 'progressPct'> {
  /** 试样垫附加类名（可空） */
  className?: string;
}

/** 案头试样：冷灰试样垫（双氛围晕）+ 书影本体 div（立卷弹窗「装帧成相」专用） */
export function BookSample({
  texture,
  name,
  description,
  volume,
  seal,
  cefr,
  imageSlot,
  className,
}: BookSampleProps) {
  return (
    /* 案头垫：冷灰台面（书影衬底，令粗麻布纹白书在白卡上仍有轮廓） */
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-[8px] bg-surface-container-highest/60 p-5 ${
        className ?? ''
      }`}
    >
      {/* 氛围光斑（仿设计稿朱印/赭石双晕，纯装饰） */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-5 -top-5 size-28 rounded-full bg-primary-fixed/20 blur-xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-6 -right-6 size-32 rounded-full bg-ochre/30 blur-2xl"
      />
      {/* 书影本体：底色随质地切换（试样原尺寸 w-48，4:5 竖装帧） */}
      <div className={`${bookCoverCls(texture)} w-48`}>
        <BookInner
          texture={texture}
          name={name}
          description={description}
          volume={volume}
          seal={seal}
          cefr={cefr}
          imageSlot={imageSlot}
        />
      </div>
    </div>
  );
}
