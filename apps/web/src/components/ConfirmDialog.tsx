'use client';

/**
 * 纸墨风确认弹窗（共享）—— 替代原生 confirm() 的统一确认 UI
 *
 * 首个使用场景：删除材料集（藏经阁卷卡 + 集详情页页头 + 案头今研移出材料）。
 * 版式沿用立卷弹窗骨架（bg-scrim 浓墨遮罩 + 白纸卡 rounded-[8px] + 深朱小印头行）；
 * 危险操作（destructive）时确认钮染破坏性朱砂并印警示底纹正文条。
 * Escape / 点遮罩 / 取消钮均可关闭（确认请求进行中三条路径全部封死，防
 * 弹窗关了请求还在飞 / 重复提交）；打开时聚焦取消钮（安全默认——键盘
 * Enter 误触不致直接确认删除），Tab 在卡内环绕，关闭后焦点还原触发钮。
 */

import { useEffect, useRef, type ReactNode } from 'react';

/** 确认弹窗属性 */
export interface ConfirmDialogProps {
  /** 弹窗开关（false 不渲染） */
  open: boolean;
  /** 头行标题（如「删除材料集」） */
  title: string;
  /** 头行小印图标名（Material Symbols ligature，如 delete_forever；缺省 help） */
  icon?: string;
  /** 正文（调用方给富文本：卷名强调 / 级联后果警示条等） */
  body: ReactNode;
  /** 确认失败提示（调用方传错误文本：弹窗保持打开、错误就地展示而非 alert） */
  error?: string | null;
  /** 确认钮文案（如「确认删除」） */
  confirmLabel: string;
  /** 确认请求进行中：确认钮换沙漏示忙并禁用（防重复提交，同时封死全部关闭路径） */
  pending?: boolean;
  /** 危险操作（删除类）：小印与确认钮染破坏性朱砂；缺省中性深朱 */
  destructive?: boolean;
  /** 确认回调 */
  onConfirm: () => void;
  /** 关闭回调（Escape / 点遮罩 / 取消钮共用路径） */
  onClose: () => void;
}

/**
 * 确认弹窗组件：打开期间监听 Escape、聚焦取消钮并约束 Tab 焦点在卡内环绕
 * @param props 见 ConfirmDialogProps
 */
export function ConfirmDialog({
  open,
  title,
  icon = 'help',
  body,
  error = null,
  confirmLabel,
  pending = false,
  destructive = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  /* 取消钮引用：打开时聚焦（键盘用户的默认落点落在安全侧） */
  const cancelRef = useRef<HTMLButtonElement>(null);
  /* 卡片引用：Tab 焦点陷阱容器 */
  const cardRef = useRef<HTMLDivElement>(null);
  /* 打开前的焦点元素：关闭时还原（键盘用户不丢位置） */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /* 最新值经 ref 入监听闭包：effect 依赖只挂 open——onClose 是调用方内联
     箭头、pending 随提交翻转，挂进依赖会每次父渲染重跑 effect，cleanup 的
     「还原焦点」会在弹窗仍开着时把焦点拽回遮罩后的触发钮（HIGH 缺陷根源） */
  const pendingRef = useRef(pending);
  const onCloseRef = useRef(onClose);
  /* 提交后再同步最新值（无依赖 effect）：渲染期赋值在并发渲染下被丢弃的
     渲染会把未提交的 pending 留在 ref 里 */
  useEffect(() => {
    pendingRef.current = pending;
    onCloseRef.current = onClose;
  });

  /* 打开/关闭生命周期（依赖只挂 open） */
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!pendingRef.current) onCloseRef.current();
        return;
      }
      /* Tab 焦点陷阱：在卡内可聚焦元素间环绕，不落到被遮罩挡住的背景上。
         pending 期间按钮全禁用、可聚焦集为空——把焦点锚在卡片自身，Tab 不外逃 */
      if (e.key === 'Tab' && cardRef.current) {
        const card = cardRef.current;
        const focusables = card.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) {
          e.preventDefault();
          card.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        /* 焦点已在卡外（body/被禁用钮）：无条件拉回 */
        if (active !== card && !card.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
        /* 焦点在卡身（点了正文等非交互区）：Tab 落回首/末元素 */
        if (active === card) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
        if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      /* 还原前判存续：确认成功可能已卸载触发钮（删行/跳转） */
      const target = restoreFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    /* 遮罩：浓墨半透（bg-scrim 单源 token）；仅点遮罩空白处关闭（表单内点击
       不触发）；确认进行中点遮罩不关闭（请求结果未定，弹窗不能先飞） */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      {/* 弹窗卡：白纸卡 + 8px 圆角 + 轻投影（与立卷弹窗同款，max-w 收窄为确认框体量） */}
      <div ref={cardRef} tabIndex={-1} className="w-full max-w-sm rounded-[8px] bg-surface-container-lowest p-5 shadow-lg">
        {/* 头行：小印 + 标题 + 关闭钮（危险操作小印染破坏性朱砂） */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-on-shell-seal ${
                destructive ? 'bg-destructive' : 'bg-shell-seal'
              }`}
            >
              <span className="material-symbols-outlined text-base">{icon}</span>
            </span>
            <h3 className="text-title-sm text-on-surface">{title}</h3>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => {
              if (!pending) onClose();
            }}
            disabled={pending}
            className="p-1 text-on-surface-variant transition-colors hover:text-on-surface disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* 正文槽：卷名强调 / 级联后果等由调用方排版 */}
        <div className="mt-3 text-body-sm leading-relaxed text-on-surface-variant">{body}</div>

        {/* 确认失败就地展示（弹窗保持打开可重试/取消，不弹原生 alert） */}
        {error && (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {error}
          </p>
        )}

        {/* 底行按钮：取消（打开即聚焦）+ 确认（进行中换沙漏示忙并禁用） */}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => {
              if (!pending) onClose();
            }}
            disabled={pending}
            className="rounded-sm border bg-surface-container px-4 py-2 text-title-sm text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`flex items-center gap-1.5 rounded-sm px-4 py-2 text-title-sm text-on-shell-seal transition-colors hover:bg-primary-hover disabled:opacity-50 ${
              destructive ? 'bg-destructive' : 'bg-primary'
            }`}
          >
            {/* 删除中换沙漏示忙（防误以为没点上重复点，与卷卡删除钮同一隐喻） */}
            {pending && (
              <span aria-hidden className="material-symbols-outlined text-base">
                hourglass_empty
              </span>
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
