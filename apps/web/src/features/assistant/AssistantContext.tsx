'use client';

/**
 * AI 侍读全局上下文（需求 15）
 *
 * 悬浮球存在于所有页面，仅聊天抽屉打开时隐藏；
 * 划词提问：任意页面选中文本 → 弹「问侍读」入口 → 带引用开聊。
 * 抽屉宽度（桌面）记忆在 localStorage（每设备偏好）。
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/** 侍读上下文形态 */
interface AssistantContextValue {
  /** 抽屉是否打开 */
  open: boolean;
  setOpen: (v: boolean) => void;
  /** 待发送的引用与问题（划词入口写入，抽屉消费后清空） */
  pendingAsk: { quote: string; question?: string; nonce: number } | null;
  askWithQuote: (quote: string, question?: string) => void;
  clearPendingAsk: () => void;
  /** 桌面抽屉宽度（px，可拖拽调整，持久化） */
  drawerWidth: number;
  setDrawerWidth: (w: number) => void;
}

const Ctx = createContext<AssistantContextValue | null>(null);

/** 抽屉宽度持久化键 */
const WIDTH_KEY = 'pinglc.assistant.width';

/**
 * 侍读 Provider（挂在根布局，包住 AppShell）
 */
export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<AssistantContextValue['pendingAsk']>(null);
  // 初始给安全占位值；真实宽度（localStorage 记忆或视口 1/6）在挂载后校正——
  // state 初始化器会在 SSR 预渲染执行，不能碰 window/localStorage
  const [drawerWidth, setDrawerWidthState] = useState(320);

  const setDrawerWidth = useCallback((w: number) => {
    const clamped = Math.round(Math.min(640, Math.max(240, w)));
    setDrawerWidthState(clamped);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      /* 忽略 */
    }
  }, []);

  const askWithQuote = useCallback((quote: string, question?: string) => {
    setPendingAsk({ quote, question, nonce: Date.now() });
    setOpen(true);
  }, []);

  const clearPendingAsk = useCallback(() => setPendingAsk(null), []);

  // 挂载后校正宽度：localStorage 记忆优先，否则取视口 1/6（需求 15），钳制在 240~640
  useEffect(() => {
    let w = Math.round(window.innerWidth / 6);
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      if (v >= 240 && v <= 640) w = v;
    } catch {
      /* 无 localStorage 环境 */
    }
    setDrawerWidthState(Math.min(640, Math.max(280, w)));
  }, []);

  return (
    <Ctx.Provider value={{ open, setOpen, pendingAsk, askWithQuote, clearPendingAsk, drawerWidth, setDrawerWidth }}>
      {children}
    </Ctx.Provider>
  );
}

/**
 * 侍读上下文 Hook
 */
export function useAssistant(): AssistantContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAssistant 必须在 AssistantProvider 内使用');
  return v;
}
