'use client';

/**
 * 纸墨风确认弹窗（共享）—— 替代原生 confirm() 的统一确认 UI
 *
 * 首个使用场景：删除材料集（藏经阁卷卡 + 集详情页页头）。
 * 版式沿用立卷弹窗骨架（bg-scrim 浓墨遮罩 + 白纸卡 rounded-[8px] + 深朱小印头行）；
 * 危险操作（destructive）时确认钮染破坏性朱砂并印警示底纹正文条。
 * Escape / 点遮罩 / 取消钮均可关闭；打开时聚焦取消钮（安全默认——
 * 键盘 Enter 误触不致直接确认删除）。
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
  /** 确认钮文案（如「确认删除」） */
  confirmLabel: string;
  /** 确认请求进行中：确认钮换沙漏示忙并禁用（防重复提交） */
  pending?: boolean;
  /** 危险操作（删除类）：小印与确认钮染破坏性朱砂；缺省中性深朱 */
  destructive?: boolean;
  /** 确认回调 */
  onConfirm: () => void;
  /** 关闭回调（Escape / 点遮罩 / 取消钮共用路径） */
  onClose: () => void;
}

/**
 * 确认弹窗组件：打开期间监听 Escape 并聚焦取消钮（安全默认）
 * @param props 见 ConfirmDialogProps
 */
export function ConfirmDialog({
  open,
  title,
  icon = 'help',
  body,
  confirmLabel,
  pending = false,
  destructive = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  /* 取消钮引用：打开时聚焦（键盘用户的默认落点落在安全侧） */
  const cancelRef = useRef<HTMLButtonElement>(null);

  /* 打开期间监听 Escape 关闭（与立卷弹窗同一路径），并聚焦取消钮 */
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    /* 遮罩：浓墨半透（bg-scrim 单源 token）；仅点遮罩空白处关闭（表单内点击不触发） */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 弹窗卡：白纸卡 + 8px 圆角 + 轻投影（与立卷弹窗同款，max-w 收窄为确认框体量） */}
      <div className="w-full max-w-sm rounded-[8px] bg-surface-container-lowest p-5 shadow-lg">
        {/* 头行：小印 + 标题 + 关闭钮（危险操作小印染破坏性朱砂） */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-white ${
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
            onClick={onClose}
            className="p-1 text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* 正文槽：卷名强调 / 级联后果等由调用方排版 */}
        <div className="mt-3 text-body-sm leading-relaxed text-on-surface-variant">{body}</div>

        {/* 底行按钮：取消（打开即聚焦）+ 确认（进行中换沙漏示忙并禁用） */}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-sm border bg-surface-container px-4 py-2 text-title-sm text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`flex items-center gap-1.5 rounded-sm px-4 py-2 text-title-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50 ${
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
