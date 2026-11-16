'use client';

/**
 * AI 侍读悬浮球与聊天抽屉（需求 15）
 *
 * - 悬浮球：所有页面右下角（避开底部导航安全区），抽屉打开时隐藏
 * - 抽屉：移动端 = 底部抽屉高 90dvh；桌面 = 右侧抽屉，宽度 1/6 视口起、可拖拽调整（持久化）
 * - 对话：SSE 流式（fetch + ReadableStream 读 text/event-stream）
 * - 会话：列表切换、新对话、删除；划词引用自动带上
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { api } from '@/lib/api';
import { useAssistant } from './AssistantContext';

/** 消息形态 */
interface Msg {
  id: number | string;
  role: string;
  contentMd: string;
}

/** 会话列表项 */
interface ThreadDTO {
  id: number;
  title: string;
  updatedAt: string;
  preview: string;
}

/**
 * 侍读整套 UI（球 + 抽屉）；由 AssistantHost 挂在 AppShell 之外层
 */
export function Assistant() {
  const { open } = useAssistant();
  return (
    <>
      {/* 悬浮球（抽屉打开时隐藏——需求 15） */}
      {!open && <AssistantBall />}
      {/* 抽屉（球与抽屉互斥出现） */}
      <AssistantDrawer />
    </>
  );
}

/**
 * 悬浮球：右下角朱砂印章样式，点击开抽屉
 */
function AssistantBall() {
  const { setOpen } = useAssistant();
  return (
    <button
      onClick={() => setOpen(true)}
      aria-label="问侍读"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-40 flex size-14 flex-col items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95 md:bottom-6 md:size-16"
    >
      {/* 印章「问」字意象 */}
      <span className="font-serif text-lg leading-none md:text-xl">问</span>
      <span className="mt-0.5 text-[9px] leading-none opacity-80">侍读</span>
    </button>
  );
}

/**
 * 聊天抽屉：移动底部 90dvh / 桌面右侧可调宽
 */
function AssistantDrawer() {
  const { open, setOpen, pendingAsk, clearPendingAsk, drawerWidth, setDrawerWidth } = useAssistant();
  const qc = useQueryClient();
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [showThreads, setShowThreads] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  /* 流式中止器：组件真正卸载（应用拆链）时中止在飞请求，防卸载后 setState */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  /* 在飞 reader 引用：异常跳出读取循环时在 finally 里释放底层连接 */
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  /* 桌面判定：matchMedia 在渲染期读会产生服务端/客户端水合不一致，
   * 改为挂载后订阅（顺带响应视口跨断点变化） */
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  /* 会话列表 */
  const threads = useQuery({
    queryKey: ['ai-threads'],
    queryFn: () => api<{ threads: ThreadDTO[] }>('/api/ai/threads'),
    enabled: open && showThreads,
  });

  /* 会话消息装载（失败就地可见——调用方全是 void，抛出即未处理 rejection） */
  const loadThread = async (id: number | null) => {
    setThreadId(id);
    setMessages([]);
    setShowThreads(false);
    if (id) {
      try {
        const r = await api<{ messages: Msg[] }>(`/api/ai/threads/${id}`);
        setMessages(r.messages);
      } catch (err) {
        setMessages([
          { id: `e-${Date.now()}`, role: 'assistant', contentMd: `⚠️ 会话装载失败：${err instanceof Error ? err.message : '未知错误'}` },
        ]);
      }
    }
  };

  /* 划词待发：抽屉打开且有 pendingAsk 时自动带入 */
  useEffect(() => {
    if (open && pendingAsk) {
      setQuote(pendingAsk.quote);
      setThreadId((cur) => cur); // 保留当前会话
      if (pendingAsk.question) {
        setInput(pendingAsk.question);
      } else {
        setInput('');
        // 无预设问题时聚焦输入框由用户提问
      }
      clearPendingAsk();
    }
  }, [open, pendingAsk, clearPendingAsk]);

  /* 流式发送 */
  const send = async () => {
    const content = input.trim();
    if (!content || streaming) return;
    setInput('');
    setStreaming(true);
    setStreamText('');
    const userMsg: Msg = { id: `u-${Date.now()}`, role: 'user', contentMd: quote ? `【引用】${quote}\n\n${content}` : content };
    setMessages((prev) => [...prev, userMsg]);
    const activeQuote = quote;
    setQuote(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const resp = await fetch('/api/ai/tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, content, quote: activeQuote }),
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        const data = await resp.json().catch(() => ({ error: '请求失败' }));
        throw new Error((data as { error?: string }).error ?? '请求失败');
      }
      const reader = resp.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buf = '';
      let assistant = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.error) throw new Error(evt.error);
            if (evt.threadId) setThreadId(evt.threadId);
            if (evt.delta) {
              assistant += evt.delta;
              setStreamText(assistant);
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && !(parseErr instanceof SyntaxError)) throw parseErr;
          }
        }
      }
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', contentMd: assistant || '（空回复）' }]);
    } catch (err) {
      // 中止（组件卸载）不算失败：部分已收到的内容照常成条，不再向已卸载组件置态
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'assistant', contentMd: `⚠️ ${err instanceof Error ? err.message : '对话失败'}` },
      ]);
    } finally {
      // 异常路径释放 reader（服务端 evt.error 直接 throw 跳出循环，底层连接悬到 GC）
      void readerRef.current?.cancel().catch(() => undefined);
      readerRef.current = null;
      setStreaming(false);
      setStreamText('');
      void qc.invalidateQueries({ queryKey: ['ai-threads'] });
    }
  };

  /* 删除会话 */
  const removeThread = useMutation({
    mutationFn: (id: number) => api(`/api/ai/threads/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      if (id === threadId) void loadThread(null);
      void qc.invalidateQueries({ queryKey: ['ai-threads'] });
    },
  });

  /* 自动滚底 */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamText]);

  /* 桌面抽屉拖宽（左缘把手）：宽度 = 起始宽度 +（起点 - 当前点），右移拖窄左移拖宽 */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizeRef.current) return;
      const { startX, startW } = resizeRef.current;
      setDrawerWidth(startW + (startX - e.clientX));
    };
    const onUp = () => {
      resizeRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setDrawerWidth]);

  if (!open) return null;

  return (
    /* 遮罩（移动端点遮罩关；桌面点击输入区外不强制关） */
    <div className="fixed inset-0 z-50" onClick={() => setOpen(false)}>
      {/* 抽屉主体：移动底部 / 桌面右侧 */}
      <div
        className={`deckle absolute flex flex-col border bg-background ${
          'inset-x-0 bottom-0 h-[90dvh] rounded-t-xl' /* 需求 15：移动 90% 屏高 */
        } max-md:pb-safe md:inset-y-0 md:right-0 md:left-auto md:h-dvh md:w-px md:rounded-none md:border-l-2 md:border-r-0 md:border-t-0 md:border-b-0`}
        style={isDesktop ? { width: drawerWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 桌面拖宽把手 */}
        <div
          className="absolute inset-y-0 left-0 hidden w-1.5 cursor-col-resize bg-transparent hover:bg-primary/20 md:block"
          onPointerDown={(e) => {
            e.preventDefault();
            resizeRef.current = { startX: e.clientX, startW: drawerWidth };
          }}
        />
        {/* 头部：标题 + 会话操作 */}
        <header className="flex items-center gap-2 border-b border-border px-4 py-3 pt-safe">
          <h3 className="font-serif text-base">语匠 · AI 侍读</h3>
          <div className="ml-auto flex items-center gap-1 text-xs">
            <button onClick={() => void loadThread(null)} className="rounded border border-border px-2 py-1">
              新对话
            </button>
            <button onClick={() => setShowThreads((v) => !v)} className="rounded border border-border px-2 py-1">
              会话
            </button>
            <button onClick={() => setOpen(false)} aria-label="关闭" className="flex size-8 items-center justify-center rounded">
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        </header>

        {/* 会话列表（下拉面板） */}
        {showThreads && (
          <div className="max-h-48 overflow-y-auto border-b border-border bg-card">
            {(threads.data?.threads ?? []).length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">还没有会话</p>
            ) : (
              (threads.data?.threads ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent">
                  <button
                    onClick={() => void loadThread(t.id)}
                    className={`min-w-0 flex-1 text-left ${t.id === threadId ? 'text-primary' : ''}`}
                  >
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{t.preview}</p>
                  </button>
                  <button onClick={() => removeThread.mutate(t.id)} aria-label="删除会话" className="text-muted-foreground hover:text-destructive">
                    <span className="material-symbols-outlined text-base">delete</span>
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* 消息区 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && !streaming && (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
              <span className="mb-2 font-serif text-3xl text-ochre">匠</span>
              <p className="text-sm">问句法、问词源、问仿说——</p>
              <p className="mt-1 text-xs">在播放页划词可直接带引用提问</p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`mb-3 flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[92%] rounded-md px-3 py-2 text-sm ${
                  m.role === 'user' ? 'bg-primary/10 text-foreground' : 'bg-card deckle border'
                }`}
              >
                <MarkdownView source={m.contentMd} />
              </div>
            </div>
          ))}
          {/* 流式气泡 */}
          {streaming && (
            <div className="mb-3 flex flex-col items-start">
              <div className="max-w-[92%] rounded-md border border-border bg-card px-3 py-2 text-sm">
                {streamText ? <MarkdownView source={streamText} /> : <span className="text-xs text-muted-foreground">运思中…</span>}
              </div>
            </div>
          )}
        </div>

        {/* 引用条（划词带入） */}
        {quote && (
          <div className="mx-4 mb-1 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs">
            <span className="material-symbols-outlined text-base text-ochre">format_quote</span>
            <p className="line-clamp-2 flex-1 italic text-muted-foreground">{quote}</p>
            <button onClick={() => setQuote(null)} aria-label="移除引用" className="text-muted-foreground">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        )}

        {/* 输入区 */}
        <div className="flex items-end gap-2 border-t border-border px-3 py-2 pb-safe">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法合成中的 Enter 是「确认候选词」，不是发送（中文输入高频路径）
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="问点什么…（Enter 发送）"
            rows={1}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={() => void send()}
            disabled={streaming || !input.trim()}
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
            aria-label="发送"
          >
            <span className="material-symbols-outlined">{streaming ? 'hourglass_top' : 'send'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
