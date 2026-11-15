/**
 * AI 侍读对话 API（需求 15，流式）
 *
 * POST /api/ai/tutor  Body: { threadId?, content, quote? }
 * → SSE 流：event data 里依次 {threadId} → {delta}×N → [DONE]（或 {error}）
 * 会话与消息持久化到 ai_threads / ai_messages；历史随请求拼多轮上下文。
 */

import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiMessages, aiThreads } from '@/lib/db/schema';
import { resolveProfile, toEngineProfile } from '@/lib/server/providers';

export const runtime = 'nodejs';

/** 侍读人设（呼应设计稿 ai_90 语匠：结构化三段式 + 自然对话） */
const TUTOR_SYSTEM =
  '你是「语匠」，PingLinguaCraft 的 AI 英语侍读。用中文回答，必要时引用英文原文。' +
  '风格：儒雅、克制、鼓励。涉及句子讲解时优先给结构：壹 句法骨架、贰 典籍拾珠（词源/搭配）、叁 情景实战（如何仿说）。' +
  '用户引用了原文时优先围绕该句讲解。回答保持精炼，多用短段落。';

/** 纳入上下文的历史条数上限（控制 token） */
const HISTORY_LIMIT = 20;

/**
 * POST —— 流式对话（SSE）
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    threadId?: number | null;
    content?: string;
    quote?: string | null;
  };
  const content = body.content?.trim();
  if (!content) return new Response(JSON.stringify({ error: '内容为空' }), { status: 400 });

  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    return new Response(JSON.stringify({ error: '未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）' }), { status: 400 });
  }

  const db = getDb();
  const now = new Date();

  // 线程：复用或新建
  let threadId = body.threadId ?? null;
  if (threadId) {
    const exist = db.select({ id: aiThreads.id }).from(aiThreads).where(eq(aiThreads.id, threadId)).all()[0];
    if (!exist) threadId = null;
  }
  if (!threadId) {
    const r = db
      .insert(aiThreads)
      .values({ userId: 1, title: content.slice(0, 24), createdAt: now, updatedAt: now })
      .returning({ id: aiThreads.id })
      .all();
    threadId = r[0]!.id;
  }

  // 用户消息落库（划词引用前缀）
  const userText = body.quote ? `【引用】${body.quote}\n\n${content}` : content;
  db.insert(aiMessages).values({ threadId, role: 'user', contentMd: userText, createdAt: now }).run();

  // 历史（含刚落库的这条；取最近 N 条，按时间正序拼装）
  const history = db
    .select({ role: aiMessages.role, contentMd: aiMessages.contentMd })
    .from(aiMessages)
    .where(eq(aiMessages.threadId, threadId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(HISTORY_LIMIT)
    .all()
    .reverse();
  const messages = [
    { role: 'system', content: TUTOR_SYSTEM },
    ...history.map((m) => ({ role: m.role, content: m.contentMd })),
  ];

  const encoder = new TextEncoder();
  const finalThreadId = threadId;
  // 客户端断开（关抽屉/导航）时中止上游生成：AbortController 在流外创建，
  // start 与 cancel 闭包共用
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 流可能已被取消（cancel 先于 start 完成）：enqueue 前判 closed，守卫发送
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 流已关闭（客户端断开）：静默丢弃 */
        }
      };
      send({ threadId: finalThreadId });
      let full = '';
      /** 落库助手消息（含断开时的部分内容——用户已见即应留档） */
      const persist = () => {
        if (!full) return;
        db.insert(aiMessages)
          .values({ threadId: finalThreadId, role: 'assistant', contentMd: full, createdAt: new Date() })
          .run();
        db.update(aiThreads)
          .set({ updatedAt: new Date() })
          .where(eq(aiThreads.id, finalThreadId))
          .run();
      };
      try {
        const engineResp = await fetch(
          `${process.env.PINGLC_ENGINE_URL ?? 'http://127.0.0.1:8765'}/llm/chat/stream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              profile: toEngineProfile(profile),
              messages,
              temperature: 0.6,
            }),
            signal: abort.signal,
          }
        );
        if (!engineResp.ok || !engineResp.body) {
          const text = await engineResp.text().catch(() => '');
          throw new Error(`引擎错误 ${engineResp.status}：${text.slice(0, 200)}`);
        }
        // 逐行解析引擎 SSE
        const reader = engineResp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
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
            // 引擎事件是 JSON；解析失败（意外格式）跳过该行，错误事件外抛
            let evt: { delta?: string; error?: string };
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            if (evt.error) throw new Error(evt.error);
            if (evt.delta) {
              full += evt.delta;
              send({ delta: evt.delta });
            }
          }
        }
        // 助手消息落库
        persist();
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        // 客户端断开（AbortError）：已收到的部分内容照常落档，不再向死流发事件
        persist();
        if (!(err instanceof Error && err.name === 'AbortError')) {
          send({ error: err instanceof Error ? err.message : '对话失败' });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel() {
      // 客户端断开：中止上游生成（引擎侧 httpx 流随之结束）
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
