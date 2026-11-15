'use client';

/**
 * 设置页 —— AI 服务配置（M1 核心：provider 档案管理 + 引擎状态）
 *
 * - 引擎状态卡：健康、本地引擎可用性、GPU、kokoro 模型落盘状态与下载入口
 * - 六能力档案管理：新增、设默认、编辑、删除、连通性测试
 *   （STT/TTS/对齐/翻译可选本地或云端；LLM 不分本地/云端，按 API 格式区分
 *   OpenAI Compatible/Responses/Anthropic/Gemini；口语评测配腾讯云凭据）
 * - 模型字段为可输入下拉（combobox）：本地按能力给预设（TTS=引擎音色清单，
 *   STT=whisper 规格，对齐=引擎后端 whisperx / MFA），云端可「获取模型」
 *   拉端点 /models 填充选项
 * - TTS 本地档案双引擎：edge-tts（联网微软）/ kokoro（本地离线，
 *   模型与音色存 ~/.pinglc/models/kokoro/，下载先查本地缺啥补啥）
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type EngineInfo, type ProviderDTO } from '@/lib/api';
import { ApiError, type EngineCapabilities, type JobDTO, type TtsVoiceOptions } from '@pinglc/core';
import { parseParamsJson, ttsEngineOf } from '@/lib/providers';
import { resetTtsVersion } from '@/lib/ttsUrl';

/** LLM 的 API 格式（取代 local/cloud 区分；引擎 llm_formats.py 按此分发） */
const API_FORMATS: Array<{ value: string; label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI Compatible（GLM/DeepSeek/vLLM/LM Studio…）' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic（Claude）' },
  { value: 'gemini', label: 'Google（Gemini）' },
];

/** 口语评测服务商（评测凭据：provider/url/appId/secretId/secretKey） */
const SPEECH_EVAL_PROVIDERS: Array<{ value: string; label: string }> = [
  { value: 'tencent', label: '腾讯云智聆口语评测（SOE）' },
];

/** 本地 STT/对齐（faster-whisper 规格）的模型预设（带选型提示；其它规格仍可手输） */
const WHISPER_SPECS: Array<{ value: string; label: string }> = [
  { value: 'tiny', label: '最快 · 精度低（验证链路用）' },
  { value: 'base', label: '快 · 精度低' },
  { value: 'large-v3', label: '最准 · 引擎默认（推荐）' },
];

/**
 * 本地对齐引擎下拉选项（值即档案 model 字段，未来 /align handler 按此分发：
 * whisperx=本机 wav2vec2 强制对齐；mfa:<声学模型名>=pinglc-mfa 镜像内烘焙的模型）
 *
 * 未就绪的后端也列出但标注未安装——能力探测 15s 轮询，装好（uv extra /
 * docker build）后标注自动消失；选中未安装后端属于超前配置，调用时引擎会如实报错
 * @param caps 引擎能力探测结果（null/undefined=引擎离线，按未安装标注）
 */
function alignEngineOptions(caps: EngineCapabilities | null | undefined): ComboOption[] {
  return [
    {
      value: 'whisperx',
      label: caps?.align.whisperx ? '本机 wav2vec2 · GPU 快' : '本机 wav2vec2（未安装：uv sync --extra align）',
    },
    {
      value: 'mfa:english_us_arpa',
      label: caps?.align.mfa_docker ? 'MFA Docker · 经典 GMM · 稳' : 'MFA Docker · 经典 GMM（镜像未构建）',
    },
    {
      value: 'mfa:english_mfa',
      label: caps?.align.mfa_docker ? 'MFA Docker · 现代默认 · 更准（跟读评分首选）' : 'MFA Docker · 现代默认（镜像未构建）',
    },
  ];
}

/** 档案表单状态（有 id=编辑已有档案，无 id=新增） */
interface Draft {
  /** 编辑中的档案 id（undefined=新增） */
  id?: number;
  capability: string;
  name: string;
  /** LLM 不分本地/云端，统一走云端形态（本地 vLLM 等= OpenAI Compatible + 本机地址） */
  kind: 'cloud' | 'local';
  endpointUrl: string;
  apiKey: string;
  model: string;
  /** TTS 本地档案的引擎选择（edge 联网 / kokoro 本地离线） */
  engine: 'edge' | 'kokoro';
  /** LLM 的 API 格式（存 paramsJson.apiFormat，引擎按此分发） */
  apiFormat: string;
  /** 口语评测：服务商（paramsJson.provider） */
  provider: string;
  /** 口语评测：appId（paramsJson.appId） */
  appId: string;
  /** 口语评测：secretId（paramsJson.secretId） */
  secretId: string;
  /** 口语评测：苛刻指数 1.0 宽松~4.0 严格（paramsJson.scoreCoeff） */
  scoreCoeff: string;
  /** STT 云端的接口路径（paramsJson.apiPath）：阿里云等原生 API 的专属路径，
   *  如 /api/v1/services/aigc/multimodal-generation/generation；OpenAI 兼容端点无需填写。
   *  （TTS 云端不存 apiPath——WebSocket 地址由端点 host 推导） */
  apiPath: string;
  /** 云端 TTS 音色（paramsJson.voice）：系统音色清单经 /api/engine/tts-voices 的 cloud 字段
   *  下发（基础音色可手输）；空串=不写 voice，用引擎默认音色 */
  cloudVoice: string;
  /** 编辑时原档案是否已配 Key（Key 只进不出，不回填进表单；留空保存=保持原值） */
  hasKey?: boolean;
}

/** 新增档案的空白表单（能力预选 LLM） */
function blankDraft(): Draft {
  return {
    capability: 'llm',
    name: '',
    kind: 'cloud',
    endpointUrl: '',
    apiKey: '',
    model: '',
    engine: 'edge',
    apiFormat: 'openai-compatible',
    provider: 'tencent',
    appId: '',
    secretId: '',
    scoreCoeff: '2',
    apiPath: '',
    cloudVoice: '',
  };
}

/**
 * 能力表单规则表（单一来源）：能力中文名、是否统一云端形态、档案名示例、
 * 附加参数（paramsJson）构造。此前这些按能力散在 draftParams/namePlaceholder/
 * 能力切换 onChange/编辑回填 startEdit 四处分支里，新增能力要改四处、
 * 漏一处即静默错（如漏掉 params 分支会以 undefined 提交、引擎回退默认值，
 * 用户配置的 apiFormat/appId 从不生效）——现在加能力只需在此加一行。
 * 表单 JSX 中结构迥异的字段组（口语评测凭据组、TTS 引擎+音色双下拉）仍
 * 按能力显式渲染，不强行套字段 schema。
 */
const CAP_RULES: Record<
  string,
  {
    /** 能力中文名（能力下拉与列表分组标题） */
    label: string;
    /** 统一云端形态（本地服务= OpenAI 兼容 + 本机地址，如 LM Studio；不提供 local 选项） */
    cloudOnly: boolean;
    /** 档案名输入示例（local 仅非 cloudOnly 能力使用） */
    nameHint: { local: string; cloud: string };
    /** 表单附加参数构造（存 paramsJson；无附加参数的能力省略此字段；
        返回 undefined 表示该形态下无附加参数，如本地 STT） */
    params?: (d: Draft) => Record<string, unknown> | undefined;
  }
> = {
  stt: {
    label: '语音转写 STT',
    cloudOnly: false,
    nameHint: { local: '如 Faster Whisper', cloud: '如 GLM ASR' },
    // 云端档案可带原生 API 的接口路径（阿里云等），OpenAI 兼容端点留空；
    // params 值一律 trim（服务端只 trim 顶层字段，文档复制常带首尾空格）
    params: (d) => (d.kind === 'cloud' ? { apiPath: d.apiPath.trim() } : undefined),
  },
  tts: {
    label: '语音合成 TTS',
    cloudOnly: false,
    nameHint: { local: '如 Kokoro', cloud: '如 阿里云 TTS' },
    // 本地档案带 engine（edge 联网 / kokoro 离线路由）；云端档案带音色（trim 后
    // 为空则不写——引擎按 DEFAULT_TTS_VOICE 兜底，且空值不污染缓存指纹）
    // （apiPath 已废弃——TTS 走 WebSocket 由端点推地址，历史档案残留无害）
    params: (d) => {
      if (d.kind === 'local') return { engine: d.engine };
      const voice = d.cloudVoice.trim();
      return voice ? { voice } : {};
    },
  },
  align: {
    label: '音素对齐',
    cloudOnly: false,
    nameHint: { local: '如 WhisperX', cloud: '如 云端对齐' },
  },
  translate: {
    label: '翻译',
    cloudOnly: true, // 不分本地/云端（统一 OpenAI 兼容端点，本地模型走 LM Studio 等本机地址）
    nameHint: { local: 'Hy-MT2', cloud: 'Hy-MT2' },
  },
  llm: {
    label: '大语言模型',
    cloudOnly: true, // 不分本地/云端，按 API 格式分发（见 API_FORMATS）
    nameHint: { local: '如 GLM-5.3-Flash', cloud: '如 GLM-5.3-Flash' },
    params: (d) => ({ apiFormat: d.apiFormat }),
  },
  speech_eval: {
    label: '口语评测',
    cloudOnly: true, // 无本地口语评测引擎，必配云端凭据
    nameHint: { local: '如 腾讯云口语评测', cloud: '如 腾讯云口语评测' },
    // 凭据：url→endpointUrl、secretKey→apiKey，其余入 params（一律 trim）
    params: (d) => ({
      provider: d.provider,
      appId: d.appId.trim(),
      secretId: d.secretId.trim(),
      scoreCoeff: Number(d.scoreCoeff),
    }),
  },
};

/** 能力中文名映射（能力下拉与分组标题用；来源于 CAP_RULES 单一来源） */
const CAP_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(CAP_RULES).map(([k, v]) => [k, v.label])
);

/** kind 归一：cloudOnly 能力一律 cloud（能力切换与遗留 local 行编辑共用此规则） */
function normalizedKind(capability: string, kind: 'cloud' | 'local'): 'cloud' | 'local' {
  return CAP_RULES[capability]?.cloudOnly ? 'cloud' : kind;
}

/** 按能力构造档案附加参数（paramsJson；规则见 CAP_RULES 单一来源） */
function draftParams(d: Draft): Record<string, unknown> | undefined {
  return CAP_RULES[d.capability]?.params?.(d);
}

/** 档案名输入提示（按 CAP_RULES 给出本地/云端示例） */
function namePlaceholder(d: { capability: string; kind: 'cloud' | 'local' }): string {
  const rule = CAP_RULES[d.capability];
  if (!rule) return '如 本地引擎';
  return d.kind === 'local' && !rule.cloudOnly ? rule.nameHint.local : rule.nameHint.cloud;
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

  /* 新增档案（params 按能力构造：TTS 本地 engine / LLM apiFormat / 口语评测凭据） */
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
          params: draftParams(d),
        }),
      }),
    onSuccess: (_r, d) => {
      // TTS 档案变更影响朗读音频指纹：失效客户端记忆的版本，下次播放取新指纹
      if (d.capability === 'tts') resetTtsVersion();
      setDraft(null);
      void providers.refetch();
    },
  });

  /* 编辑档案（PATCH 局部更新；apiKey 留空=不传=保持原值，其余字段所见即所得。
     kind 一并提交——旧版 UI 存下的 local LLM/翻译档案在编辑流统一修正为 cloud） */
  const update = useMutation({
    mutationFn: (d: Draft) =>
      api(`/api/providers/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: d.name,
          kind: d.kind,
          endpointUrl: d.endpointUrl,
          apiKey: d.apiKey || undefined,
          model: d.model,
          params: draftParams(d),
        }),
      }),
    onSuccess: (_r, d) => {
      if (d.capability === 'tts') resetTtsVersion();
      setDraft(null);
      void providers.refetch();
    },
  });

  /** 点「编辑」：档案回填进表单（API Key 不回显，留空保存即保持原值；云端模型清单随之失效清空）。
      cloudOnly 能力（LLM/翻译/口语评测）的遗留 local 行归一为 cloud（规则在 CAP_RULES） */
  const startEdit = (p: ProviderDTO) => {
    resetAux();
    const params = parseParamsJson(p.paramsJson);
    setDraft({
      id: p.id,
      capability: p.capability,
      name: p.name,
      kind: normalizedKind(p.capability, p.kind),
      endpointUrl: p.endpointUrl ?? '',
      apiKey: '',
      model: p.model ?? '',
      engine: ttsEngineOf(p),
      apiFormat: typeof params.apiFormat === 'string' ? params.apiFormat : 'openai-compatible',
      provider: typeof params.provider === 'string' ? params.provider : 'tencent',
      appId: typeof params.appId === 'string' ? params.appId : '',
      secretId: typeof params.secretId === 'string' ? params.secretId : '',
      scoreCoeff: params.scoreCoeff != null ? String(params.scoreCoeff) : '2',
      apiPath: typeof params.apiPath === 'string' ? params.apiPath : '',
      cloudVoice: typeof params.voice === 'string' ? params.voice : '',
      hasKey: p.hasKey,
    });
  };

  /* 设默认（切默认档案可能改变 TTS 生效音色 → 失效朗读版本记忆） */
  const setDefault = useMutation({
    mutationFn: (id: number) => api(`/api/providers/${id}?action=default`, { method: 'POST' }),
    onSuccess: () => {
      resetTtsVersion();
      void providers.refetch();
    },
  });

  /* 删除（默认 TTS 档案被删同样可能切换生效音色） */
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      resetTtsVersion();
      void providers.refetch();
    },
  });

  /* 连通性测试（编辑态 Key 兜底：表单留空按 profileId 由服务端回库取已存 Key） */
  const test = useMutation({
    mutationFn: (d: {
      capability: string;
      endpointUrl: string;
      apiKey: string;
      model: string;
      /** 编辑中的档案 id（Key 留空时服务端回库取） */
      profileId?: number;
      /** 表单附加参数（LLM 的 apiFormat 等，测试与实际调用同格式分发） */
      params?: Record<string, unknown>;
    }) =>
      api<{ ok: boolean; detail: string }>('/api/providers/test', {
        method: 'POST',
        body: JSON.stringify(d),
      }),
  });

  /* 云端模型清单（「获取模型」按档案 API 格式拉端点模型列表；表单 Key 留空时服务端按档案 id 回库取） */
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const fetchModels = useMutation({
    mutationFn: (d: Draft) =>
      api<{ models: string[] }>('/api/providers/models', {
        method: 'POST',
        body: JSON.stringify({
          endpointUrl: d.endpointUrl,
          apiKey: d.apiKey || undefined,
          profileId: d.id,
          // LLM 档案按 API 格式分发（anthropic/gemini 的鉴权头与字段名不同）
          apiFormat: d.capability === 'llm' ? d.apiFormat : undefined,
        }),
      }),
    onSuccess: (r) => setFetchedModels(r.models),
  });

  /** 重置表单附属结果（测试结论 + 模型清单）：凡切换档案、变更端点/能力/类型/API 格式、
   *  关闭表单的入口都调用——mutation 状态挂在组件上不随 draft 变，不重置就会残留显示 */
  const resetAux = () => {
    setFetchedModels([]);
    test.reset();
    fetchModels.reset();
  };

  const caps = engine.data?.capabilities;

  /* TTS 音色清单与默认音色（引擎透传；本地/云端 TTS 档案表单展开时才拉取；
     清单与默认值均只在引擎持一份，契约类型在 core） */
  const ttsVoices = useQuery({
    queryKey: ['tts-voices'],
    queryFn: () => api<TtsVoiceOptions>('/api/engine/tts-voices'),
    enabled: draft?.capability === 'tts',
  });

  /* 模型字段下拉选项：本地按能力给预设（TTS=音色清单，STT=whisper 规格，
     对齐=引擎后端：whisperx 本机 / mfa:<声学模型> Docker，含可用性标注；
     其余本地能力无预设——翻译/LLM/口语评测本就统一云端形态，不再误给 whisper 型号）；
     云端=「获取模型」结果 */
  const modelOptions: ComboOption[] =
    draft?.kind === 'local'
      ? draft.capability === 'tts'
        ? ((draft.engine === 'kokoro' ? ttsVoices.data?.kokoro : ttsVoices.data?.edge) ?? [])
        : draft.capability === 'align'
          ? alignEngineOptions(caps)
          : draft.capability === 'stt'
            ? WHISPER_SPECS
            : []
      : fetchedModels.map((m) => ({ value: m }));

  /* kokoro 模型下载任务（走通用 jobs 管线：web 任务行 + 引擎队列执行；
     本地优先，在位文件自动跳过；web/引擎重启由 recovery 续传） */
  const [modelJob, setModelJob] = useState<JobDTO | null>(null);
  const startDownload = useMutation({
    mutationFn: () => api<{ jobId: string }>('/api/engine/models/kokoro', { method: 'POST' }),
    onSuccess: (r) =>
      setModelJob({
        id: r.jobId,
        type: 'model_download',
        status: 'queued',
        progress: 0,
        message: '准备下载…',
        error: null,
        materialId: null,
        cueId: null,
      }),
  });

  /* 下载任务进度轮询（通用 /api/jobs/:id；终态即停；成功后刷新引擎能力翻转「已就绪」徽标。
     404=任务行不存在 → 终态报错引导重试；连续失败超上限也终止，绝不 1Hz 永久空转） */
  useEffect(() => {
    if (!modelJob || (modelJob.status !== 'queued' && modelJob.status !== 'running')) return;
    let misses = 0;
    const timer = setInterval(async () => {
      try {
        const r = await api<{ job: JobDTO }>(`/api/jobs/${modelJob.id}`);
        setModelJob(r.job);
        misses = 0;
        if (r.job.status === 'succeeded') void engine.refetch();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setModelJob({ ...modelJob, status: 'failed', error: '下载任务不存在（数据异常），请重新点击下载' });
          return;
        }
        /* 瞬时抖动：下一轮再试；连续失败达上限即终止（引擎/服务不可达） */
        if (++misses >= 10) {
          setModelJob({ ...modelJob, status: 'failed', error: '进度查询持续失败（服务不可达），请稍后重试' });
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [modelJob, engine]);

  /** 档案表单（新增=列表上方；编辑=在被编辑档案行的原位置就地渲染；同一 JSX 两处复用） */
  const renderProfileForm = () => {
    /* 两处调用点均已由条件保证 draft 存在，此处守卫仅做类型收窄 */
    if (!draft) return null;
    return (
    <form
      className="deckle mb-4 rounded-md border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        // 有 id=编辑（PATCH），无 id=新增（POST）
        if (draft.id) update.mutate(draft);
        else create.mutate(draft);
      }}
    >
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
        {/* 能力（编辑时锁定：换能力=另建档案，PATCH 不支持改能力） */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">能力</span>
          <select
            value={draft.capability}
            onChange={(e) => {
              const cap = e.target.value;
              // cloudOnly 能力（LLM/翻译/口语评测）归一为云端形态，规则在 CAP_RULES
              setDraft({ ...draft, capability: cap, kind: normalizedKind(cap, draft.kind) });
              // 换能力后旧测试结论/模型清单失效
              resetAux();
            }}
            disabled={!!draft.id}
            className="rounded border border-input bg-background px-2 py-1.5 disabled:opacity-60"
          >
            {Object.entries(CAP_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {/* 第二列：LLM=API 格式 / 口语评测=服务商 / 翻译与云端 LLM 同构（无类型列）/ 其余=本地或云端 */}
        {draft.capability === 'translate' ? null : draft.capability === 'llm' ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">API 格式</span>
            <select
              value={draft.apiFormat}
              onChange={(e) => {
                setDraft({ ...draft, apiFormat: e.target.value });
                // 格式切换后旧测试结论失效（测试按格式分发）
                resetAux();
              }}
              className="rounded border border-input bg-background px-2 py-1.5"
            >
              {API_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        ) : draft.capability === 'speech_eval' ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">服务商</span>
            <select
              value={draft.provider}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
              className="rounded border border-input bg-background px-2 py-1.5"
            >
              {SPEECH_EVAL_PROVIDERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">类型</span>
            <select
              value={draft.kind}
              onChange={(e) => {
                setDraft({ ...draft, kind: e.target.value as 'cloud' | 'local' });
                // 类型切换后旧测试结论/模型清单失效
                resetAux();
              }}
              disabled={!!draft.id}
              className="rounded border border-input bg-background px-2 py-1.5 disabled:opacity-60"
            >
              {/* TTS 云端仅走阿里云 WebSocket（引擎路由固定），如实标注防误填 OpenAI 兼容端点 */}
              <option value="cloud">
                {draft.capability === 'tts' ? '云端 API（阿里云 WebSocket）' : '云端 API（OpenAI 兼容）'}
              </option>
              <option value="local">本地引擎</option>
            </select>
          </label>
        )}
        {/* 档案名：本地 STT 给「引擎+规格」预设下拉（亦可手输）；其余按能力给示例提示 */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">档案名</span>
          {draft.capability === 'stt' && draft.kind === 'local' ? (
            <ComboboxInput
              value={draft.name}
              onChange={(v) => setDraft({ ...draft, name: v })}
              options={WHISPER_SPECS.map((s) => ({
                value: `Faster Whisper ${s.value}`,
                label: s.label,
              }))}
              placeholder={namePlaceholder(draft)}
              required
            />
          ) : (
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={namePlaceholder(draft)}
              required
              className="rounded border border-input bg-background px-2 py-1.5"
            />
          )}
        </label>
        {/* 口语评测：专用凭据字段（url→endpointUrl、SecretKey→apiKey、其余入 params） */}
        {draft.capability === 'speech_eval' ? (
          <>
            {/* 服务地址 */}
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs text-muted-foreground">服务地址 URL</span>
              <input
                value={draft.endpointUrl}
                onChange={(e) => setDraft({ ...draft, endpointUrl: e.target.value })}
                placeholder="wss://soe.cloud.tencent.com/soe/api"
                required
                className="rounded border border-input bg-background px-2 py-1.5"
              />
            </label>
            {/* 苛刻指数（1.0 宽松~4.0 严格；随 params.scoreCoeff 传引擎） */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">评分苛刻度</span>
              <select
                value={draft.scoreCoeff}
                onChange={(e) => setDraft({ ...draft, scoreCoeff: e.target.value })}
                className="rounded border border-input bg-background px-2 py-1.5"
              >
                <option value="1">宽松（儿童）</option>
                <option value="2">标准（推荐）</option>
                <option value="3">较严</option>
                <option value="4">严格</option>
              </select>
            </label>
            {/* SecretKey（敏感凭据，走 apiKey 字段：只进不出） */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">SecretKey（只存本机）</span>
              <input
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                type="password"
                placeholder={draft.id && draft.hasKey ? '留空保持原 Key' : '凭据密钥'}
                className="rounded border border-input bg-background px-2 py-1.5"
              />
            </label>
            {/* appId */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">AppId</span>
              <input
                value={draft.appId}
                onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
                required
                className="rounded border border-input bg-background px-2 py-1.5"
              />
            </label>
            {/* secretId */}
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs text-muted-foreground">SecretId</span>
              <input
                value={draft.secretId}
                onChange={(e) => setDraft({ ...draft, secretId: e.target.value })}
                required
                className="rounded border border-input bg-background px-2 py-1.5"
              />
            </label>
          </>
        ) : (
          draft.kind === 'cloud' && (
            <>
              {/* 端点 */}
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-xs text-muted-foreground">端点 URL（…/v1）</span>
                <input
                  value={draft.endpointUrl}
                  onChange={(e) => {
                    setDraft({ ...draft, endpointUrl: e.target.value });
                    // 端点变更后旧清单与旧测试结果失效
                    resetAux();
                  }}
                  placeholder={draft.capability === 'translate' ? 'http://localhost:1234/v1' : 'https://open.bigmodel.cn/api/paas/v4'}
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
                  placeholder={draft.id ? (draft.hasKey ? '留空保持原 Key' : 'sk-…') : 'sk-…'}
                  className="rounded border border-input bg-background px-2 py-1.5"
                />
              </label>
              {/* 端点路径（仅 STT 云端）：阿里云等原生 API 的专属接口路径，OpenAI 兼容端点无需填写。
                  TTS 云端不显示——地址由端点 host 推导（WebSocket），params 不再存 apiPath */}
              {draft.capability === 'stt' && (
                <label className="flex flex-col gap-1 md:col-span-2">
                  <span className="text-xs text-muted-foreground">端点路径（OpenAI 兼容端点留空）</span>
                  <input
                    value={draft.apiPath}
                    onChange={(e) => setDraft({ ...draft, apiPath: e.target.value })}
                    placeholder="/api/v1/services/aigc/multimodal-generation/generation"
                    className="rounded border border-input bg-background px-2 py-1.5"
                  />
                </label>
              )}
            </>
          )
        )}
        {/* 模型/音色：口语评测无模型概念不渲染；TTS 本地档案换「引擎 + 音色」双下拉，其余能力保持文本输入 */}
        {draft.capability === 'speech_eval' ? null : draft.capability === 'tts' && draft.kind === 'local' ? (
          <>
            {/* TTS 引擎（edge 联网微软 / kokoro 本地离线） */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">引擎</span>
              <select
                value={draft.engine}
                onChange={(e) => {
                  const next = e.target.value as 'edge' | 'kokoro';
                  setDraft({
                    ...draft,
                    engine: next,
                    model: next === 'kokoro' ? 'bm_george' : 'en-GB-RyanNeural',
                  });
                }}
                className="rounded border border-input bg-background px-2 py-1.5"
              >
                <option value="edge">edge-tts（联网 · 微软）</option>
                <option value="kokoro">kokoro（本地离线）</option>
              </select>
            </label>
            {/* 音色（可输入下拉：清单与默认值均来自引擎 /tts/voices，亦可手输清单外音色） */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">音色</span>
              <ComboboxInput
                value={draft.model}
                onChange={(v) => setDraft({ ...draft, model: v })}
                options={(draft.engine === 'kokoro' ? ttsVoices.data?.kokoro : ttsVoices.data?.edge) ?? []}
                placeholder={
                  ttsVoices.data
                    ? `${draft.engine === 'kokoro' ? ttsVoices.data.defaults.kokoro : ttsVoices.data.defaults.edge}（默认）`
                    : '默认音色'
                }
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                模型
                {draft.capability === 'stt'
                  ? '（可下拉选规格）'
                  : draft.capability === 'align' && draft.kind === 'local'
                    ? '（可选对齐引擎）'
                    : ''}
              </span>
              {/* 获取模型：拉云端端点 /models 填充下拉（仅云端档案）。
                  新增档案（无 id）且远端端点未填 Key 时禁用——绝大多数 OpenAI 兼容
                  服务列模型要鉴权，空 Key 获取必 401，先提示而不是让用户撞错误；
                  本机地址（LM Studio/vLLM 等）常免鉴权，不限制 */}
              {draft.kind === 'cloud' && (
                <button
                  type="button"
                  onClick={() => fetchModels.mutate(draft)}
                  disabled={
                    fetchModels.isPending ||
                    !draft.endpointUrl ||
                    (!draft.id && !draft.apiKey && !/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/.test(draft.endpointUrl))
                  }
                  title={
                    !draft.id && !draft.apiKey
                      ? '云端端点需要 API Key 才能获取模型，请先填写'
                      : undefined
                  }
                  className="rounded border border-border px-2 py-0.5 text-[10px] hover:text-primary disabled:opacity-40"
                >
                  {fetchModels.isPending ? '获取中…' : '获取模型'}
                </button>
              )}
            </span>
            <ComboboxInput
              value={draft.model}
              onChange={(v) => setDraft({ ...draft, model: v })}
              options={modelOptions}
              placeholder={
                draft.kind === 'local'
                  ? draft.capability === 'align'
                    ? 'whisperx（默认，可下拉换 MFA）'
                    : '留空用引擎默认'
                  : 'glm-5.3-flash / deepseek-chat / gpt-5…'
              }
            />
            {fetchModels.isError && (
              <span className="text-[10px] text-destructive">
                {((fetchModels.error as Error | null)?.message ?? '').slice(0, 80)}
              </span>
            )}
          </label>
        )}
        {/* 云端 TTS 音色（可输入下拉：系统音色清单来自引擎 /tts/voices 的 cloud 字段，
            基础音色可手输；存 paramsJson.voice，留空=引擎默认音色（placeholder 展示）） */}
        {draft.capability === 'tts' && draft.kind === 'cloud' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">音色</span>
            <ComboboxInput
              value={draft.cloudVoice}
              onChange={(v) => setDraft({ ...draft, cloudVoice: v })}
              options={ttsVoices.data?.cloud ?? []}
              placeholder={ttsVoices.data ? `${ttsVoices.data.defaults.cloud}（默认）` : '默认音色'}
            />
          </label>
        )}
      </div>
      {/* 测试 + 提交（仅 llm/translate 有连通性测试通道，其余能力不显示测试按钮） */}
      <div className="mt-3 flex items-center gap-2">
        {(draft.capability === 'llm' || draft.capability === 'translate') && (
          <button
            type="button"
            onClick={() =>
              test.mutate({
                capability: draft.capability,
                endpointUrl: draft.endpointUrl,
                apiKey: draft.apiKey,
                model: draft.model,
                // 编辑态 Key 兜底：表单留空时服务端按档案 id 回库取已存 Key
                profileId: draft.id,
                // 附加参数随表单透传（LLM 的 apiFormat，测试与实际调用同格式分发）
                params: draftParams(draft),
              })
            }
            disabled={draft.kind !== 'cloud' || !draft.endpointUrl || test.isPending}
            title={draft.id && draft.hasKey ? 'API Key 留空时用档案已存 Key 测试' : undefined}
            className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {test.isPending ? '测试中…' : '连通性测试'}
          </button>
        )}
        {test.data && (
          <span className={`text-xs ${test.data.ok ? 'text-secondary' : 'text-destructive'}`}>
            {test.data.detail}
          </span>
        )}
        {/* 测试失败提示（502 抛错走 isError 分支，此前静默无显示） */}
        {test.isError && (
          <span className="text-xs text-destructive">
            {((test.error as Error | null)?.message ?? '测试失败').slice(0, 80)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => {
              resetAux();
              setDraft(null);
            }}
            className="rounded border border-border px-3 py-1.5 text-xs"
          >
            取消
          </button>
          <button
            type="submit"
            className="rounded bg-primary px-4 py-1.5 text-xs text-primary-foreground"
            disabled={create.isPending || update.isPending}
          >
            {create.isPending || update.isPending ? '保存中…' : draft.id ? '保存修改' : '保存档案'}
          </button>
        </div>
      </div>
      {(create.isError || update.isError) && (
        <p className="mt-2 text-xs text-destructive">
          {((update.error ?? create.error) as Error | null)?.message}
        </p>
      )}
    </form>
    );
  };

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
        {/* 引擎在线但能力探测失败：给出原因（EngineInfo.error，此前静默丢弃） */}
        {engine.data?.error && !caps && (
          <p className="mt-2 text-xs text-destructive">能力探测失败：{engine.data.error}</p>
        )}
        {/* kokoro 模型落盘状态：模块已装而文件未下载时给一键入口（先查本地，缺啥补啥）。
            kokoro_models 显式为 false 才提示——仍在跑旧代码的引擎进程不回报该字段，
            undefined 视为未知，不误报「未下载」 */}
        {caps?.tts.kokoro && caps.tts.kokoro_models === false && (
          <div className="mt-3 rounded-md border border-dashed px-3 py-2 text-xs">
            {modelJob && (modelJob.status === 'queued' || modelJob.status === 'running') ? (
              <div>
                {/* 下载进度（引擎任务回传文案 + 百分比） */}
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{modelJob.message ?? '准备下载…'}</span>
                  <span>{Math.round(modelJob.progress * 100)}%</span>
                </div>
                {/* 进度条 */}
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.round(modelJob.progress * 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  kokoro 模型未下载（模型+音色约 336MB，存 ~/.pinglc/models/kokoro/；已在位的文件只补缺失）
                </span>
                <button
                  onClick={() => startDownload.mutate()}
                  disabled={startDownload.isPending}
                  className="rounded bg-primary px-2.5 py-1 text-primary-foreground disabled:opacity-40"
                >
                  {startDownload.isPending ? '提交中…' : '下载模型'}
                </button>
                {modelJob?.status === 'failed' && (
                  <span className="text-destructive">下载失败：{modelJob.error}</span>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 档案管理 */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">AI 服务档案（按能力可配多个，默认档案即时生效）</h3>
          <button
            onClick={() => {
              // 测试结果/获取模型属于上一个表单，随切换重置
              resetAux();
              setDraft(blankDraft());
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
          >
            + 新增档案
          </button>
        </div>

        {/* 新增表单（编辑表单在对应档案行的原位置就地渲染） */}
        {draft && !draft.id && <div className="mb-4">{renderProfileForm()}</div>}

        {/* 档案列表（按能力分组） */}
        {(['llm', 'translate', 'stt', 'tts', 'align', 'speech_eval'] as const).map((cap) => {
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
                        : cap === 'speech_eval'
                          ? '未配置 —— 跟读口语评分不可用'
                          : '未配置 —— 词级时间戳已由 STT 提供；音素对齐供跟读精细评分'}
                </p>
              ) : (
                rows.map((p) =>
                  /* 编辑态：在被编辑档案行的原位置就地渲染表单（替换该行） */
                  draft?.id === p.id ? (
                    <div key={p.id} className="mb-1.5">{renderProfileForm()}</div>
                  ) : (
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
                      <p className="truncate text-xs text-muted-foreground">{sublineOf(p)}</p>
                    </div>
                    {!p.isDefault && (
                      <button onClick={() => setDefault.mutate(p.id)} className="rounded border border-border px-2.5 py-1 text-xs">
                        设为默认
                      </button>
                    )}
                    {/* 编辑：在原位置就地展开表单（PATCH 保存） */}
                    <button
                      onClick={() => startEdit(p)}
                      aria-label="编辑档案"
                      className="text-muted-foreground hover:text-primary"
                    >
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
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
                  )
                )
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
        <p className="mb-1 mt-3 font-medium text-foreground">口语评测（跟读评分）</p>
        <p>
          腾讯云智聆口语评测（新版）：控制台开通服务并购买套餐包（初次接入有 9.9 元调试包）；
          AppId 为账号 AppID，SecretId/SecretKey 在「访问管理 → API 密钥管理」创建；
          服务地址填 wss://soe.cloud.tencent.com/soe/api。未配置时跟读评分自动降级本地近似评分。
        </p>
      </section>
    </div>
  );
}

/** combobox 选项形态 */
interface ComboOption {
  value: string;
  /** 辅助说明（可选；如音色「Ryan · 英音男声 · 沉稳」、模型「最准 · 引擎默认（推荐）」） */
  label?: string;
}

/**
 * 可输入下拉（combobox）：点击输入框或右侧箭头展开全量选项，点击选中；亦可手输清单外值
 *
 * 不用原生 datalist 的原因：浏览器会按输入框当前值做前缀过滤，而表单常态是
 * 「已预填默认音色 / 编辑回填原值」——一展开就只剩当前项自己，全部选项被过滤
 * 掉（上一版实际缺陷）。自绘弹层展开即全量，当前值仅高亮不过滤。
 */
function ComboboxInput({
  value,
  onChange,
  options,
  placeholder,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  /** 表单必填校验（透传给内部 input） */
  required?: boolean;
}) {
  /* 弹层展开状态 */
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /* 点击组件外部时收起弹层 */
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  return (
    /* 相对定位容器（弹层挂在其内） */
    <div ref={rootRef} className="relative">
      {/* 文本输入：聚焦展开，Esc 收起；输入不受选项过滤 */}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={placeholder}
        required={required}
        className="w-full rounded border border-input bg-background px-2 py-1.5 pr-7"
      />
      {/* 展开/收起切换箭头 */}
      <button
        type="button"
        aria-label={open ? '收起选项' : '展开选项'}
        onClick={() => setOpen((o) => !o)}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground"
      >
        <span className={`material-symbols-outlined text-base transition-transform ${open ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>
      {/* 选项弹层（全量列出；当前值高亮；无选项时不渲染） */}
      {open && options.length > 0 && (
        <div
          role="listbox"
          className="deckle absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border bg-card"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`block w-full px-3 py-1.5 text-left text-xs ${
                o.value === value ? 'bg-accent text-primary' : 'hover:bg-accent'
              }`}
            >
              {/* 选项值（实际写入档案的模型名/音色名） */}
              <span className="block truncate">{o.value}</span>
              {/* 辅助说明行（有则显示） */}
              {o.label && <span className="block truncate text-[10px] text-muted-foreground">{o.label}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 本地档案的引擎标签（TTS 从 paramsJson 解析所选引擎，其余能力显示「本地」；解析在 lib/providers 单一来源） */
function localEngineLabel(p: ProviderDTO): string {
  if (p.capability !== 'tts') return '本地';
  return ttsEngineOf(p) === 'kokoro' ? '本地 kokoro' : '本地 edge-tts';
}

/** 档案行副文案（按能力/类型给出端点·模型/凭据/格式摘要） */
function sublineOf(p: ProviderDTO): string {
  // 口语评测：服务地址 · appId（凭据状态以 🔑 示意）
  if (p.capability === 'speech_eval') {
    const params = parseParamsJson(p.paramsJson);
    return `${p.endpointUrl ?? ''} · ${String(params.appId ?? '')}${p.hasKey ? ' · 🔑' : ''}`;
  }
  // LLM：API 格式 · 端点 · 模型（格式标签取下拉 label 的括号前段）
  if (p.capability === 'llm' && p.kind === 'cloud') {
    const fmt = parseParamsJson(p.paramsJson).apiFormat;
    const label = API_FORMATS.find((f) => f.value === fmt)?.label ?? API_FORMATS[0]!.label;
    return `${label.split('（')[0]} · ${p.endpointUrl ?? ''} · ${p.model ?? ''}${p.hasKey ? ' · 🔑' : ' · 无Key'}`;
  }
  if (p.kind === 'cloud') {
    // 云端 TTS：模型 · 音色（音色存 paramsJson.voice，缺省=引擎默认）
    if (p.capability === 'tts') {
      const voice = parseParamsJson(p.paramsJson).voice;
      return `${p.endpointUrl ?? ''} · ${p.model ?? ''} · ${voice ? String(voice) : '默认音色'}${p.hasKey ? ' · 🔑' : ' · 无Key'}`;
    }
    // 云端 STT 配置了端点路径时拼接显示（完整调用地址 = URL + 路径）
    const apiPath = parseParamsJson(p.paramsJson).apiPath;
    const suffix = p.capability === 'stt' && apiPath ? String(apiPath) : '';
    return `${p.endpointUrl ?? ''}${suffix} · ${p.model ?? ''}${p.hasKey ? ' · 🔑' : ' · 无Key'}`;
  }
  return `${localEngineLabel(p)} · ${p.model ?? '默认'}`;
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
