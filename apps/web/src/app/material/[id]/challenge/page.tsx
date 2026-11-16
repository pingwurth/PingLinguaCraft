'use client';

/**
 * 闯关模式页（需求 17：全文听过一遍后解锁）
 *
 * 面板：解锁门（未听过一遍显示进度提示）+ 六玩法卡片（最好成绩）；
 * 进入玩法 = 全材料逐句挑战，完成成绩 POST 回写（同玩法取最高）。
 * 六玩法：grid 九宫格拼句 / dictation 单句听写 / shadow_score 跟读评分 /
 * shadowing 影子跟读 / recite 全文背诵 / scenario 情景实战。
 */

import Link from 'next/link';
import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CueDTO } from '@/lib/api';
import { GridMode } from '@/features/challenge/GridMode';
import { DictationMode } from '@/features/challenge/DictationMode';
import { ShadowMode } from '@/features/challenge/ShadowMode';
import { ReciteMode } from '@/features/challenge/ReciteMode';
import { ScenarioMode } from '@/features/challenge/ScenarioMode';
import { ChallengeAudio } from '@/features/challenge/ChallengeAudio';

/** 玩法标识与文案 */
const MODES = [
  { key: 'grid', label: '九宫格 · 选词拼句', icon: 'grid_view', desc: '逐句打乱词块，按序复原' },
  { key: 'dictation', label: '单句听写', icon: 'hearing', desc: '听句默写全句，词级判分' },
  { key: 'shadow_score', label: '跟读评分', icon: 'record_voice_over', desc: '录音跟读，AI 打分' },
  { key: 'shadowing', label: '影子跟读', icon: 'graphic_eq', desc: '与原声同步朗读打分' },
  { key: 'recite', label: '全文背诵', icon: 'auto_stories', desc: '看提示背原句' },
  { key: 'scenario', label: '情景实战', icon: 'edit_square', desc: '以原文为范，AI 逐句指导仿写' },
] as const;

type ModeKey = (typeof MODES)[number]['key'];

/**
 * 闯关页
 * @param props.params 路由参数（材料 id）
 */
export default function ChallengePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const materialId = Number(id);
  const [activeMode, setActiveMode] = useState<ModeKey | null>(null);

  /* 闯关状态 */
  const state = useQuery({
    queryKey: ['challenge', materialId],
    queryFn: () =>
      api<{ unlocked: boolean; totalCues: number; scores: Record<string, number> }>(
        `/api/materials/${materialId}/challenge`
      ),
  });

  /* 句段（进玩法时装载一次） */
  const cuesQuery = useQuery({
    queryKey: ['cues', materialId],
    queryFn: () => api<{ cues: CueDTO[] }>(`/api/materials/${materialId}/cues`),
    enabled: !!activeMode,
  });

  const onFinished = () => {
    setActiveMode(null);
    void state.refetch();
  };

  /* —— 玩法运行中 —— */
  if (activeMode) {
    // 装载/失败/空句段分支：此前仅当 data 就绪才进玩法视图，装载期回落玩法
    // 面板（点击看似「没反应」），失败或空句段时无退出按钮可离开
    const cues = cuesQuery.data?.cues;
    if (cuesQuery.isLoading) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-8">
          <p className="py-16 text-center text-sm text-muted-foreground">句段装载中…</p>
        </div>
      );
    }
    if (!cues || cues.length === 0) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-8">
          {/* 退出按钮：失败态必须能离开，否则用户被卡死在玩法分支 */}
          <button
            onClick={onFinished}
            className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            退出玩法
          </button>
          <p className="py-16 text-center text-sm text-destructive">
            {cuesQuery.isError ? `句段装载失败：${cuesQuery.error.message}` : '本材料暂无句段，无法闯关'}
          </p>
        </div>
      );
    }
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-8">
        {/* 播放通道：听写/跟读玩法的「听原句」依赖（本页不挂 Player） */}
        <ChallengeAudio materialId={materialId} />
        {/* 退出玩法 */}
        <button
          onClick={onFinished}
          className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          退出玩法
        </button>
        {activeMode === 'grid' && <GridMode cues={cues} materialId={materialId} onExit={onFinished} />}
        {activeMode === 'dictation' && <DictationMode cues={cues} materialId={materialId} onExit={onFinished} />}
        {(activeMode === 'shadow_score' || activeMode === 'shadowing') && (
          <ShadowMode cues={cues} materialId={materialId} mode={activeMode} onExit={onFinished} />
        )}
        {activeMode === 'recite' && <ReciteMode cues={cues} materialId={materialId} onExit={onFinished} />}
        {activeMode === 'scenario' && <ScenarioMode cues={cues} materialId={materialId} onExit={onFinished} />}
      </div>
    );
  }

  /* —— 面板 —— */
  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6 md:px-12 md:py-10">
      <header className="mb-6 flex items-center gap-3">
        <Link href={`/material/${materialId}`} aria-label="返回播放页" className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-primary">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <div>
          <h2 className="font-serif text-2xl">闯关模式</h2>
          <p className="text-xs text-ochre">六关连渡，方得始终</p>
        </div>
      </header>

      {state.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : !state.data?.unlocked ? (
        /* 未解锁：提示听过一遍（需求 17 的门） */
        <div className="deckle flex flex-col items-center rounded-md border border-dashed bg-card/50 px-6 py-16 text-center">
          <span className="material-symbols-outlined mb-3 text-4xl text-ochre">lock</span>
          <p className="font-serif text-lg">尚未解锁</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            完整听过一遍本材料（播放页正常播放即可，逐句自动记位）后解锁六玩法闯关。
          </p>
          <Link href={`/material/${materialId}`} className="mt-5 rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
            去精听
          </Link>
        </div>
      ) : (
        /* 六玩法卡片 */
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODES.map((m, i) => (
            <button
              key={m.key}
              onClick={() => setActiveMode(m.key)}
              className="deckle flex flex-col rounded-md border bg-card p-5 text-left transition-colors hover:bg-accent/60"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="font-serif text-sm text-ochre">第{['一', '二', '三', '四', '五', '六'][i]}关</span>
                <span className="material-symbols-outlined text-xl text-primary">{m.icon}</span>
                {/* 最好成绩角标 */}
                {state.data!.scores[m.key] != null && (
                  <span className="ml-auto rounded-full bg-secondary/10 px-2 py-0.5 text-[10px] text-secondary">
                    最佳 {state.data!.scores[m.key]}
                  </span>
                )}
              </div>
              <p className="font-serif text-base">{m.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{m.desc}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
