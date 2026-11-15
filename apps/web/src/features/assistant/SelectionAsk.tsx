'use client';

/**
 * 划词问侍读（需求 15：选中文本询问 AI 学习助手）
 *
 * 监听全局 selectionchange：在播放页内容区选中文本后，
 * 在选区附近弹出「问侍读」小按钮 → 带引用打开抽屉。
 * 仅在存在有效选区时显示；点按/收起即隐。
 */

import { useEffect, useState } from 'react';
import { useAssistant } from './AssistantContext';

/**
 * 划词入口组件（挂在 AppShell，全局生效）
 */
export function SelectionAsk() {
  const { askWithQuote, open } = useAssistant();
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
      // 抽屉打开时不弹（聊天中划词无意义）
      if (open) {
        setSelection(null);
        return;
      }
      // 稍等选区稳定（移动端选择手柄会多次触发）
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? '';
        if (!sel || text.length < 2 || text.length > 600) {
          setSelection(null);
          return;
        }
        // 选区定位：range 的首个矩形
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          setSelection(null);
          return;
        }
        setSelection({ text, x: rect.left + rect.width / 2, y: rect.top });
      }, 250);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [open]);

  if (!selection) return null;

  return (
    /* 「问侍读」气泡：跟随选区上方 */
    <button
      onClick={() => {
        askWithQuote(selection.text);
        window.getSelection()?.removeAllRanges();
        setSelection(null);
      }}
      className="fixed z-[45] flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground"
      style={{
        left: Math.min(Math.max(selection.x, 70), window.innerWidth - 70),
        top: Math.max(selection.y - 8, 40),
      }}
    >
      <span className="material-symbols-outlined text-sm">format_quote</span>
      问侍读
    </button>
  );
}
