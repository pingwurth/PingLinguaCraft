'use client';

/**
 * Markdown 安全渲染组件（笔记/ AI 解析展示共用）
 *
 * marked 解析 + DOMPurify 消毒（AI 产出的 HTML 一律不可信）；
 * 纸墨风排版：标题衬线、引用块朱砂左边线。
 */

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** 单例解析器（同步模式足够，笔记体量小） */
const parser = marked.setOptions({ gfm: true, breaks: true });

/**
 * Markdown 渲染
 * @param props.source Markdown 源文本（空则渲染占位）
 * @param props.className 附加类名
 */
export function MarkdownView({ source, className }: { source: string | null; className?: string }) {
  const html = useMemo(() => {
    if (!source?.trim()) return '';
    const raw = parser.parse(source) as string;
    // 允许常见富文本标签；禁脚本/事件/iframe
    return DOMPurify.sanitize(raw, { FORBID_TAGS: ['script', 'iframe', 'style', 'form'] });
  }, [source]);

  if (!html) {
    return <p className="text-sm text-muted-foreground">（暂无内容）</p>;
  }
  return (
    // 消毒后的 HTML 直插；排版走 .md-view 样式
    <div
      className={`md-view text-sm leading-relaxed ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
