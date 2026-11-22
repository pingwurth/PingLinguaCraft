'use client';

/**
 * 导入向导页（需求 1/2/3；设计稿 _15 移动 / _14 桌面）
 *
 * 三种导入路径（tab 切换）：
 * - 本地文件：音视频（+可选字幕文件，有字幕免 STT）
 * - 链接：YouTube/Bilibili/TED/RSS（yt-dlp 下载，顺带抓官方英文字幕）
 * - 文本：粘贴英文文本 → 自动分句 → TTS 生成音频
 * 公共：选择目标材料集（或快速新建）
 * 工作流程指引弹窗：首访自动展示三场景流程图与在线 TTS/STT 服务推荐，
 * 页头帮助键可随时重看（localStorage 记忆已读）
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Collection, type JobDTO } from '@/lib/api';
import { FOCUSABLE_SELECTOR } from '@/lib/focus';

/** 导入路径 tab */
type ImportKind = 'file' | 'link' | 'text';

/** 页签元数据（Record 按 ImportKind 穷尽声明：新增 kind 漏配即编译报错；
 *  显示名/图标单源，顶部导航与指引弹窗场景卡共用） */
const TAB_META: Record<ImportKind, { label: string; icon: string }> = {
  file: { label: '本地文件', icon: 'upload_file' },
  link: { label: '链接导入', icon: 'link' },
  text: { label: '文本转音频', icon: 'text_to_speech' },
};

/** 页签渲染顺序（导航条从左到右） */
const TAB_ORDER: ReadonlyArray<ImportKind> = ['file', 'link', 'text'];

/** 指引弹窗已读记忆键（localStorage：关闭过一次即不再自动弹出） */
const GUIDE_SEEN_KEY = 'pinglc.import.guideSeen';

/**
 * 工作流程场景数据：num 为场景序号中文数字（随数据走，不按数组下标取——
 * 增删场景不会出现「场景undefined」）；steps 首=手头素材、末=导入结果（中间为
 * 动作步骤）；hint 为站内/站外做法提示（不交叉引用其他场景序号，防乱序失效）；
 * tab 为对应导入路径页签（显示名从 TAB_META 单源取，弹窗内可一键跳转）
 */
const GUIDE_SCENARIOS: ReadonlyArray<{
  /** 场景序号中文数字（标题「场景X」用） */
  num: string;
  /** 场景图标（Material Symbols 名） */
  icon: string;
  /** 场景名（描述手头素材） */
  title: string;
  /** 流程步骤链（首=素材，末=结果） */
  steps: string[];
  /** 站内/站外做法提示 */
  hint: string;
  /** 对应导入路径 tab（显示名从 TAB_META 取） */
  tab: ImportKind;
}> = [
  {
    num: '一',
    icon: 'text_snippet',
    title: '只有文本',
    steps: ['文本', 'TTS 语音生成', 'STT 语音转写', '导入：音/视频 + 字幕'],
    hint: '「文本转音频」页签粘贴即自动合成并分句（免转写）；也可先在下方语音生成网站做出音频，再按「只有音/视频」场景转写。',
    tab: 'text',
  },
  {
    num: '二',
    icon: 'graphic_eq',
    title: '只有音/视频文件',
    steps: ['音/视频', 'STT 语音转写', '导入：音/视频 + 字幕'],
    hint: '上传后本站自动转写（本地 Whisper 或云端档案）；也可先用下方网站转写导出 SRT，随文件上传免转写。',
    tab: 'file',
  },
  {
    num: '三',
    icon: 'task_alt',
    title: '已有音/视频 + 配套字幕',
    steps: ['音/视频 + 字幕', '直接导入'],
    hint: '同时选择媒体与 .srt / .vtt 字幕文件，跳过转写直接入库。',
    tab: 'file',
  },
];

/** 在线语音生成（TTS）服务推荐：[站点名, 链接] */
const TTS_SITES: ReadonlyArray<readonly [string, string]> = [
  ['Read Aloud', 'https://app.readaloud.net/'],
  ['豆包', 'https://www.doubao.com/chat/'],
];

/** 在线语音转写（STT）服务推荐：[站点名, 链接]（一律公共产品入口，不带租户域名） */
const STT_SITES: ReadonlyArray<readonly [string, string]> = [
  ['阿里云听悟', 'https://tingwu.aliyun.com/home'],
  ['飞书妙记', 'https://www.feishu.cn/product/minutes'],
];

/**
 * 导入页（Suspense 包装 useSearchParams）
 */
export default function ImportPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-muted-foreground">装载中…</div>}>
      <ImportWizard />
    </Suspense>
  );
}

/**
 * 导入向导主体
 */
function ImportWizard() {
  const search = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ImportKind>('file');
  const [collectionId, setCollectionId] = useState<number>(Number(search.get('collectionId')) || 0);
  const [newCollection, setNewCollection] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [wantVideo, setWantVideo] = useState(true);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ materialId: number; jobId: string } | null>(null);

  /* 工作流程指引弹窗：首次进页自动展示（localStorage 记忆已读），页头帮助键可重看 */
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(GUIDE_SEEN_KEY)) setGuideOpen(true);
    } catch {
      /* 无 localStorage（隐私模式等）：不记忆，每次进页都展示 */
      setGuideOpen(true);
    }
  }, []);
  /** 关闭指引弹窗并记忆已读（此后不再自动弹出，仅页头手动重看） */
  const closeGuide = () => {
    setGuideOpen(false);
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, '1');
    } catch {
      /* 记忆失败不影响关闭 */
    }
  };
  /** 从指引弹窗跳到指定导入路径页签（顺带关闭并记忆已读） */
  const goGuide = (k: ImportKind) => {
    setKind(k);
    closeGuide();
  };

  /* 材料集列表 */
  const collections = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: Collection[] }>('/api/collections'),
  });

  /* 任务进度（提交后轮询；完成跳转播放页） */
  const job = useQuery({
    queryKey: ['job', result?.jobId],
    queryFn: () => api<{ job: JobDTO }>(`/api/jobs/${result!.jobId}`),
    enabled: !!result,
    refetchInterval: (q) => {
      const st = q.state.data?.job.status;
      return st === 'succeeded' || st === 'failed' ? false : 1500;
    },
  });

  /* 提交成功后刷新列表 + 成功时跳转 */
  const onSubmitSuccess = (r: { materialId: number; jobId: string }) => {
    setResult(r);
    void qc.invalidateQueries({ queryKey: ['collections'] });
  };

  /* 提交后自动跳转到播放页（任务完成时）——effect 而非渲染期副作用：
   * 渲染期 router.push 在任何一次重渲染（轮询刷新/StrictMode 双渲染）都会
   * 重复执行，可能重复导航/路由闪烁 */
  useEffect(() => {
    if (result && job.data?.job.status === 'succeeded') {
      router.push(`/material/${result.materialId}`);
    }
  }, [result, job.data?.job.status, router]);

  /* 三种提交 */
  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('file', file!);
      if (subtitleFile) fd.set('subtitle', subtitleFile);
      fd.set('collectionId', String(collectionId));
      return fetch('/api/import/upload', { method: 'POST', body: fd }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? '上传失败');
        return data as { materialId: number; jobId: string };
      });
    },
    onSuccess: onSubmitSuccess,
  });
  const link = useMutation({
    mutationFn: () =>
      api<{ materialId: number; jobId: string }>('/api/import/link', {
        method: 'POST',
        body: JSON.stringify({ url: linkUrl, collectionId, wantVideo }),
      }),
    onSuccess: onSubmitSuccess,
  });
  const textImport = useMutation({
    mutationFn: () =>
      api<{ materialId: number; jobId: string }>('/api/import/text', {
        method: 'POST',
        body: JSON.stringify({ text, collectionId }),
      }),
    onSuccess: onSubmitSuccess,
  });

  /* 快速建卷 */
  const createCollection = useMutation({
    mutationFn: () => api<{ id: number }>('/api/collections', { method: 'POST', body: JSON.stringify({ name: newCollection }) }),
    onSuccess: (r) => {
      setCollectionId(r.id);
      setNewCollection('');
      void collections.refetch();
    },
  });

  const pending = upload.isPending || link.isPending || textImport.isPending;
  const errMsg =
    (upload.error ?? link.error ?? textImport.error ?? createCollection.error) instanceof Error
      ? ((upload.error ?? link.error ?? textImport.error ?? createCollection.error) as Error).message
      : null;

  const canSubmit =
    collectionId > 0 &&
    !pending &&
    (kind === 'file' ? !!file : kind === 'link' ? /^https?:\/\//.test(linkUrl) : text.trim().length > 10);

  return (
    /* 向导容器 */
    <div className="mx-auto w-full max-w-2xl px-5 py-6 md:py-10">
      {/* 页头：标题 + 工作流程指引重看入口 */}
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">纳新入卷</h2>
          <p className="mt-1 text-sm text-ochre">导入后自动生成字幕与译文，即可开始精读</p>
        </div>
        {/* 帮助键：随时重看工作流程指引 */}
        <button
          onClick={() => setGuideOpen(true)}
          aria-label="工作流程指引"
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
        >
          <span className="material-symbols-outlined">help</span>
        </button>
      </header>

      {/* 路径 tab（页签元数据 TAB_META 单源，与指引弹窗场景卡共用；顺序按 TAB_ORDER） */}
      <nav className="deckle mb-5 flex rounded-md border bg-card p-1">
        {TAB_ORDER.map((key) => (
          <button
            key={key}
            onClick={() => setKind(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-2 text-sm transition-colors ${
              kind === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <span className="material-symbols-outlined text-lg">{TAB_META[key].icon}</span>
            {TAB_META[key].label}
          </button>
        ))}
      </nav>

      {/* 目标材料集选择（三路共用） */}
      <section className="deckle mb-5 rounded-md border bg-card p-4">
        <label className="mb-2 block text-sm font-medium">归属材料集</label>
        <div className="flex gap-2">
          <select
            value={collectionId || ''}
            onChange={(e) => setCollectionId(Number(e.target.value))}
            className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">选择材料集…</option>
            {(collections.data?.collections ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {/* 快速建卷 */}
        <div className="mt-2 flex gap-2">
          <input
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
            placeholder="或输入新卷名快速立卷"
            className="flex-1 rounded border border-input bg-background px-3 py-1.5 text-xs"
          />
          <button
            onClick={() => newCollection.trim() && createCollection.mutate()}
            disabled={!newCollection.trim() || createCollection.isPending}
            className="rounded border border-secondary px-3 py-1.5 text-xs text-secondary disabled:opacity-40"
          >
            立卷
          </button>
        </div>
      </section>

      {/* 各路径输入区 */}
      {kind === 'file' && (
        <section className="deckle mb-5 rounded-md border bg-card p-4">
          <label className="mb-2 block text-sm font-medium">音视频文件</label>
          <input
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          />
          {file && (
            <p className="mt-2 text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
          <label className="mb-2 mt-4 block text-sm font-medium">
            字幕文件（可选，有英文字幕则跳过 STT）
          </label>
          <input
            type="file"
            accept=".srt,.vtt"
            onChange={(e) => setSubtitleFile(e.target.files?.[0] ?? null)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          />
        </section>
      )}

      {kind === 'link' && (
        <section className="deckle mb-5 rounded-md border bg-card p-4">
          <label className="mb-2 block text-sm font-medium">链接（YouTube / Bilibili / TED / RSS）</label>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://…"
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          />
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={wantVideo} onChange={(e) => setWantVideo(e.target.checked)} className="size-4 accent-primary" />
            下载视频（取消则仅下载音频，更快）
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            若站点提供英文字幕将直接采用（免转写）；否则本地 whisper 转写。
          </p>
        </section>
      )}

      {kind === 'text' && (
        <section className="deckle mb-5 rounded-md border bg-card p-4">
          <label className="mb-2 block text-sm font-medium">英文文本（自动分句并合成英音音频）</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="粘贴文章、演讲稿或任何英文文本…"
            className="min-h-40 w-full rounded border border-input bg-background p-3 font-serif text-sm"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{text.trim().length} 字符</p>
        </section>
      )}

      {/* 错误提示 */}
      {errMsg && <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{errMsg}</p>}

      {/* 提交按钮 / 进度面板 */}
      {!result ? (
        <button
          onClick={() => (kind === 'file' ? upload.mutate() : kind === 'link' ? link.mutate() : textImport.mutate())}
          disabled={!canSubmit}
          className="w-full rounded-md bg-primary py-3 text-sm text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {pending ? '提交中…' : '开始导入'}
        </button>
      ) : (
        /* 提交后：任务进度（页面停留提示 + 完成自动跳转） */
        <div className="deckle rounded-md border bg-card p-5">
          <p className="text-sm">
            {job.data?.job.status === 'failed'
              ? '导入失败'
              : job.data?.job.status === 'succeeded'
                ? '完成，正在进入精读页…'
                : (job.data?.job.message ?? '任务排队中…')}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: `${Math.max(3, (job.data?.job.progress ?? 0) * 100)}%` }}
            />
          </div>
          {job.data?.job.status === 'failed' && (
            <>
              <p className="mt-2 break-all text-xs text-destructive">{job.data?.job.error}</p>
              <button
                onClick={() => {
                  setResult(null);
                  void qc.invalidateQueries({ queryKey: ['collections'] });
                }}
                className="mt-3 rounded-md border border-border px-4 py-2 text-xs"
              >
                返回修改重试
              </button>
            </>
          )}
        </div>
      )}

      {/* 工作流程指引弹窗（首次进页自动展示；Esc / 点遮罩 / 关闭键均等效关闭） */}
      {guideOpen && <FlowGuide onClose={closeGuide} onGo={goGuide} />}
    </div>
  );
}

/**
 * 步骤节点着色：首节点（手头素材）赭褐虚线框 / 中间节点（动作步骤）压印底 /
 * 末节点（导入结果）朱砂实底（拍平为早返回分支，不用嵌套三元）
 * @param i    节点下标
 * @param last 末节点下标（steps.length - 1）
 */
function stepNodeClass(i: number, last: number): string {
  if (i === 0) return 'border border-dashed border-ochre text-ochre';
  if (i === last) return 'bg-primary text-primary-foreground';
  return 'bg-muted text-foreground';
}

/**
 * 流程步骤条：三段着色节点（见 stepNodeClass），节点间箭头衔接，窄屏自动换行
 * @param steps 步骤名数组（≥2 项：首=素材，末=结果）
 */
function FlowChain({ steps }: { steps: string[] }) {
  return (
    /* 步骤链容器：flex 换行适配窄屏 */
    <div className="flex flex-wrap items-center gap-1">
      {steps.map((step, i) => (
        /* 单步骤节点与其后箭头打包（末节点不带箭头） */
        <span key={step} className="flex items-center gap-1">
          {/* 步骤节点：按首（素材）/ 中（动作）/ 末（结果）三段着色 */}
          <span className={`rounded px-2 py-1 text-xs ${stepNodeClass(i, steps.length - 1)}`}>{step}</span>
          {/* 衔接箭头（末节点后不渲染） */}
          {i < steps.length - 1 && (
            <span className="material-symbols-outlined text-sm text-ochre" aria-hidden="true">
              arrow_forward
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * 在线服务推荐行（语音生成/语音转写两组共用：组名 + 站点链接胶囊，外链带标识图标）
 * @param label     组名（如「语音生成」）
 * @param sites     站点清单：[站点名, 链接]
 * @param className 组容器外距（首组离小节标题 mt-2，后续组间 mt-1.5，由使用处给定）
 */
function SiteLinkList({
  label,
  sites,
  className,
}: {
  label: string;
  sites: ReadonlyArray<readonly [string, string]>;
  className: string;
}) {
  return (
    /* 组容器：组名 + 胶囊换行排布 */
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {/* 组名 */}
      <span className="text-xs text-muted-foreground">{label}</span>
      {/* 站点链接胶囊（新窗口打开，带外链图标） */}
      {sites.map(([name, url]) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 rounded border border-input bg-background px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-primary"
        >
          {name}
          <span className="material-symbols-outlined text-xs text-ochre" aria-hidden="true">
            open_in_new
          </span>
        </a>
      ))}
    </div>
  );
}

/**
 * 工作流程指引弹窗：三场景流程图 + 在线 TTS/STT 服务推荐
 *
 * 展示「素材 → 动作 → 导入结果」的全链路，帮用户按手头素材对号入座；
 * 场景卡「去××」按钮关闭弹窗并切到对应导入路径页签。
 * 无障碍：打开即把焦点移入弹窗卡（tabIndex=-1 容器），关闭时还原到触发元素；
 * 弹窗期间锁定背景滚动（role=dialog 不止于视觉模态）。
 * @param onClose 关闭回调（记忆已读由调用方处理）
 * @param onGo 关闭并跳转到指定导入路径 tab
 */
function FlowGuide({ onClose, onGo }: { onClose: () => void; onGo: (kind: ImportKind) => void }) {
  /* 弹窗卡引用（打开时聚焦、承担 tabIndex=-1 焦点容器角色） */
  const cardRef = useRef<HTMLDivElement>(null);
  /* 键盘圈定：Esc 关闭（与点遮罩、关闭键等效）；Tab/Shift+Tab 在弹窗卡内的
     可聚焦元素间循环，焦点不出遮罩——aria-modal 的键盘语义真正落地 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // 弹窗卡内可聚焦元素（首尾两个做循环锚点；FOCUSABLE_SELECTOR 与
      // ConfirmDialog/MobileSearch 两处陷阱共用单源）
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (active !== cardRef.current && !cardRef.current?.contains(active)) {
        // 焦点在卡外：按方向拉回末/首元素
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (active === cardRef.current) {
        // 焦点在卡容器本身（tabIndex=-1 的落焦点位）：Tab 落回首/末元素，
        // 否则 Shift+Tab 会走默认行为逃到卡外背景
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); // 正向到尾 → 回首
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); // 逆向到首 → 回尾
        last.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  /* 焦点管理 + 背景滚动锁定：挂载即聚焦弹窗卡，卸载还原触发元素焦点；
     滚动锁同时压 html 与 body（iOS Safari PWA 只锁 body 不可靠），并按
     滚动条宽度补 padding 防桌面端去滚动条引发的布局跳动 */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevPadRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - html.clientWidth;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.paddingRight = prevPadRight;
      opener?.focus();
    };
  }, []);

  return (
    /* 遮罩层：浓墨半透（scrim token），点空白处关闭 */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      {/* 弹窗卡片：纸卡底 + 书边线；内容超屏时卡片内滚动（移动端友好）；
          tabIndex=-1 使卡片可编程聚焦（焦点圈定的落点） */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="导入工作流程指引"
        tabIndex={-1}
        className="deckle max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-md border bg-card p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头：标题 + 一句话导语 + 关闭键 */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-serif text-xl">导入工作流程</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              精听材料的完整形态是「音/视频 + 带时间戳的字幕」。按手头素材对号入座：
            </p>
          </div>
          {/* 关闭键 */}
          <button
            onClick={onClose}
            aria-label="关闭指引"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* 三场景卡：流程链 + 提示 + 页签跳转 */}
        <div className="mt-4 flex flex-col gap-3">
          {GUIDE_SCENARIOS.map((s) => (
            <section key={s.title} className="rounded-md border border-border bg-background p-3">
              {/* 场景标题行：图标 + 序号 + 名称（序号随场景数据走） */}
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-primary">{s.icon}</span>
                <h4 className="text-sm font-medium">
                  场景{s.num} · {s.title}
                </h4>
              </div>
              {/* 流程步骤链 */}
              <div className="mt-2.5">
                <FlowChain steps={s.steps} />
              </div>
              {/* 做法提示 + 对应页签一键跳转（页签名从 TAB_META 单源取） */}
              <div className="mt-2 flex items-end justify-between gap-2">
                <p className="text-xs leading-relaxed text-muted-foreground">{s.hint}</p>
                <button
                  onClick={() => onGo(s.tab)}
                  className="shrink-0 rounded border border-primary/40 px-2 py-1 text-xs text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                >
                  去「{TAB_META[s.tab].label}」
                </button>
              </div>
            </section>
          ))}
        </div>

        {/* 在线服务推荐小节（两组站点行共用 SiteLinkList） */}
        <div className="mt-4 border-t border-border pt-3">
          {/* 小节标题 */}
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <span className="material-symbols-outlined text-lg text-ochre">public</span>
            在线服务推荐
          </h4>
          {/* 语音生成（TTS）组（首组离小节标题稍远） */}
          <SiteLinkList label="语音生成" sites={TTS_SITES} className="mt-2" />
          {/* 语音转写（STT）组 */}
          <SiteLinkList label="语音转写" sites={STT_SITES} className="mt-1.5" />
          {/* 兼容格式与站内能力提示 */}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            转写请导出 SRT / VTT 字幕，与本站导入直接兼容；本站亦内置本地合成与转写，设置页可配云端档案。
          </p>
        </div>

        {/* 底部确认按钮 */}
        <button
          onClick={onClose}
          className="mt-4 w-full rounded-md bg-primary py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          知道了，开始导入
        </button>
      </div>
    </div>
  );
}
