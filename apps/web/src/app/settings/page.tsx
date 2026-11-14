'use client';

/**
 * 设置页 —— AI 服务配置（M1 核心：provider 档案管理 + 引擎状态）
 *
 * - 引擎状态卡：健康、本地引擎可用性、GPU
 * - 五能力档案管理：新增（local/cloud）、设默认、编辑、删除、连通性测试
 *   （需求：STT/TTS/对齐/翻译均可选择本地或云端 API，可配多个下拉切换）
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type EngineInfo, type ProviderDTO } from '@/lib/api';

/** 能力中文名 */
const CAP_LABEL: Record<string, string> = {
  stt: '语音转写 STT',
  tts: '语音合成 TTS',
  align: '音素对齐',
  translate: '翻译',
  llm: '大语言模型',
};

/** 新建档案表单状态 */
interface Draft {
  capability: string;
  name: string;
  kind: 'cloud' | 'local';
  endpointUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 设置页组件
 */
export default function SettingsPage() {
    const [draft, setDraft] = useState<Draft | null>(null);

  /* 引擎状态 */
  const engine = useQuery({
    queryKey: ['engine'],
    queryFn: () => api<EngineInfo>('/api/engine'),
    refetchInterval: 15000,
  });

  /* 档案列表 */
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ providers: ProviderDTO[] }>('/api/providers'),
  });

  /* 新增档案 */
  const create = useMutation({
    mutationFn: (d: Draft) =>
      api('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          capability: d.capability,
          name: d.name,
          kind: d.kind,
          endpointUrl: d.endpointUrl || undefined,
          apiKey: d.apiKey || undefined,
          model: d.model || undefined,
        }),
      }),
    onSuccess: () => {
      setDraft(null);
      void providers.refetch();
    },
  });

  /* 设默认 */
  const setDefault = useMutation({
    mutationFn: (id: number) => api(`/api/providers/${id}?action=default`, { method: 'POST' }),
    onSuccess: () => void providers.refetch(),
  });

  /* 删除 */
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => void providers.refetch(),
  });

  /* 连通性测试 */
  const test = useMutation({
    mutationFn: (d: { capability: string; endpointUrl: string; apiKey: string; model: string }) =>
      api<{ ok: boolean; detail: string }>('/api/providers/test', {
        method: 'POST',
        body: JSON.stringify(d),
      }),
  });

  const caps = engine.data?.capabilities;

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-4xl px-5 py-6 md:px-12 md:py-10">
      <header className="mb-6">
        <h2 className="font-serif text-2xl md:text-3xl">我的 · 设置</h2>
        <p className="mt-1 text-sm text-ochre">AI 引擎与云端档案 · 数据都在本机 ~/.pinglc/</p>
      </header>

      {/* 引擎状态卡 */}
      <section className="deckle mb-6 rounded-md border bg-card p-4">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-2.5 rounded-full ${engine.data?.healthy ? 'bg-secondary' : 'bg-destructive'}`}
          />
          <h3 className="text-sm font-medium">本地 AI 引擎（127.0.0.1:8765）</h3>
          <span className="ml-auto text-xs text-muted-foreground">
            {engine.data?.healthy ? '运行中' : '未启动（./scripts/start.sh engine）'}
          </span>
        </div>
        {caps && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <Cap ok={caps.stt.faster_whisper} label="faster-whisper" />
            <Cap ok={caps.tts.edge_tts} label="edge-tts" />
            <Cap ok={caps.tts.kokoro} label="kokoro" />
            <Cap ok={caps.align.whisperx} label="whisperx" />
            <Cap ok={caps.align.mfa_docker} label="MFA (Docker)" />
            <Cap ok={caps.cuda} label={`GPU ${caps.cuda ? '（CUDA）' : ''}`} />
          </div>
        )}
      </section>

      {/* 档案管理 */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">AI 服务档案（按能力可配多个，默认档案即时生效）</h3>
          <button
            onClick={() =>
              setDraft({ capability: 'llm', name: '', kind: 'cloud', endpointUrl: '', apiKey: '', model: '' })
            }
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
          >
            + 新增档案
          </button>
        </div>

        {/* 新建表单 */}
        {draft && (
          <form
            className="deckle mb-4 rounded-md border bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(draft);
            }}
          >
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              {/* 能力 */}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">能力</span>
                <select
                  value={draft.capability}
                  onChange={(e) => setDraft({ ...draft, capability: e.target.value })}
                  className="rounded border border-input bg-background px-2 py-1.5"
                >
                  {Object.entries(CAP_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              {/* 类型 */}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">类型</span>
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'cloud' | 'local' })}
                  className="rounded border border-input bg-background px-2 py-1.5"
                >
                  <option value="cloud">云端 API（OpenAI 兼容）</option>
                  <option value="local">本地引擎</option>
                </select>
              </label>
              {/* 档案名 */}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">档案名</span>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="如 GLM-4.7"
                  required
                  className="rounded border border-input bg-background px-2 py-1.5"
                />
              </label>
              {draft.kind === 'cloud' && (
                <>
                  {/* 端点 */}
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-xs text-muted-foreground">端点 URL（…/v1）</span>
                    <input
                      value={draft.endpointUrl}
                      onChange={(e) => setDraft({ ...draft, endpointUrl: e.target.value })}
                      placeholder="https://open.bigmodel.cn/api/paas/v4"
                      required
                      className="rounded border border-input bg-background px-2 py-1.5"
                    />
                  </label>
                  {/* API Key */}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">API Key（只存本机）</span>
                    <input
                      value={draft.apiKey}
                      onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                      type="password"
                      placeholder="sk-…"
                      className="rounded border border-input bg-background px-2 py-1.5"
                    />
                  </label>
                </>
              )}
              {/* 模型 */}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  模型{draft.capability === 'tts' ? '（edge-tts 填音色，如 en-GB-RyanNeural）' : draft.capability === 'stt' ? '（如 large-v3 / small）' : ''}
                </span>
                <input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  placeholder={draft.kind === 'local' ? '留空用引擎默认' : 'glm-4.7 / deepseek-chat / gpt-5…'}
                  className="rounded border border-input bg-background px-2 py-1.5"
                />
              </label>
            </div>
            {/* 测试 + 提交 */}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  test.mutate({
                    capability: draft.capability,
                    endpointUrl: draft.endpointUrl,
                    apiKey: draft.apiKey,
                    model: draft.model,
                  })
                }
                disabled={draft.kind !== 'cloud' || !draft.endpointUrl}
                className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-40"
              >
                连通性测试
              </button>
              {test.data && (
                <span className={`text-xs ${test.data.ok ? 'text-secondary' : 'text-destructive'}`}>
                  {test.data.detail}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={() => setDraft(null)} className="rounded border border-border px-3 py-1.5 text-xs">
                  取消
                </button>
                <button type="submit" className="rounded bg-primary px-4 py-1.5 text-xs text-primary-foreground" disabled={create.isPending}>
                  保存档案
                </button>
              </div>
            </div>
            {create.isError && (
              <p className="mt-2 text-xs text-destructive">{(create.error as Error).message}</p>
            )}
          </form>
        )}

        {/* 档案列表（按能力分组） */}
        {(['llm', 'translate', 'stt', 'tts', 'align'] as const).map((cap) => {
          const rows = (providers.data?.providers ?? []).filter((p) => p.capability === cap);
          return (
            <div key={cap} className="mb-4">
              <h4 className="mb-2 text-xs font-medium text-ochre">{CAP_LABEL[cap]}</h4>
              {rows.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  {cap === 'stt' || cap === 'tts'
                    ? '未配置 —— 引擎内置本地默认将生效'
                    : cap === 'translate'
                      ? '未配置 —— 字幕将不带中文译文（可后补）'
                      : cap === 'llm'
                        ? '未配置 —— AI 解析/笔记不可用（推荐先配 GLM/DeepSeek）'
                        : '未配置 —— 对齐能力将在 M3 使用'}
                </p>
              ) : (
                rows.map((p) => (
                  /* 单档案行 */
                  <div key={p.id} className="deckle mb-1.5 flex items-center gap-3 rounded-md border bg-card px-4 py-2.5 text-sm">
                    <span className="material-symbols-outlined text-lg text-ochre">
                      {p.kind === 'cloud' ? 'cloud' : 'dns'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate">
                        {p.name}
                        {p.isDefault && (
                          <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">默认</span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.kind === 'cloud' ? `${p.endpointUrl ?? ''} · ${p.model ?? ''}${p.hasKey ? ' · 🔑' : ' · 无Key'}` : `本地 · ${p.model ?? '默认'}`}
                      </p>
                    </div>
                    {!p.isDefault && (
                      <button onClick={() => setDefault.mutate(p.id)} className="rounded border border-border px-2.5 py-1 text-xs">
                        设为默认
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm(`删除档案「${p.name}」？`)) remove.mutate(p.id);
                      }}
                      aria-label="删除档案"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </section>

      {/* 使用说明 */}
      <section className="deckle mt-8 rounded-md border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">云端端点示例（OpenAI 兼容 /v1 结尾）</p>
        <p>智谱 GLM：https://open.bigmodel.cn/api/paas/v4 ｜ DeepSeek：https://api.deepseek.com/v1</p>
        <p>本地 hy-MT2（自部署 vLLM/Ollama）：http://127.0.0.1:8000/v1（无需 Key）</p>
      </section>
    </div>
  );
}

/** 能力小徽标（可用绿点/不可用灰点） */
function Cap({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block size-1.5 rounded-full ${ok ? 'bg-secondary' : 'bg-border'}`} />
      {label}
      {!ok && <span className="text-[10px] text-border">（未安装）</span>}
    </span>
  );
}
