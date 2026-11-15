'use client';

/**
 * 情景实战玩法（需求 17 玩法六）
 *
 * 逐句：以原句为范例 → 用户结合自身情况仿写 → AI 点评（结构/纠错/地道改写）→ 下一句。
 * 成绩规则：完成全部仿写即 100（创作型玩法不按对错计分，重在完成与反馈）。
 */

import { useState } from 'react';
import { MarkdownView } from '@/components/MarkdownView';
import { api } from '@/lib/api';
import type { CueDTO } from '@/lib/api';
import { ChallengeShell, useChallengeRun } from './ChallengeShell';

/**
 * 情景实战玩法
 */
export function ScenarioMode({
  cues,
  materialId,
  onExit,
}: {
  cues: CueDTO[];
  materialId: number;
  onExit: () => void;
}) {
  const run = useChallengeRun(cues.length);
  const cue = cues[run.current];
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 提交仿写 → AI 点评 */
  const submit = async () => {
    if (!cue || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ feedback: string }>(`/api/cues/${cue.id}/imitate`, {
        method: 'POST',
        body: JSON.stringify({ userText: text }),
      });
      setFeedback(r.feedback);
    } catch (err) {
      setError(err instanceof Error ? err.message : '点评失败');
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    setText('');
    setFeedback(null);
    run.advance(100); // 完成即满分（创作型）
    if (run.current + 1 >= cues.length) {
      void fetch(`/api/materials/${materialId}/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'scenario', score: 100 }),
      }).catch(() => undefined);
    }
  };

  if (!cue) return null;

  return (
    <ChallengeShell
      cues={cues}
      title="情景实战 · 仿写"
      current={run.current}
      onExit={onExit}
      finished={run.finished}
      finalScore={run.scores.length ? 100 : null}
      onRestart={run.restart}
    >
      {/* 范例句 */}
      <div className="deckle rounded-md border bg-card p-4">
        <p className="mb-1 text-xs text-ochre">范例原句</p>
        <p className="font-serif text-lg leading-relaxed">{cue.textEn}</p>
        {cue.textZh && <p className="mt-1 text-sm text-muted-foreground">{cue.textZh}</p>}
      </div>

      {/* 仿写输入 */}
      {!feedback && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="用这个句式写你自己的情况…（中英混写也行，AI 会纠正英文）"
            className="min-h-28 w-full rounded-md border border-input bg-background p-3 text-sm"
          />
          {error && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
          <button
            onClick={() => void submit()}
            disabled={!text.trim() || busy}
            className="rounded-md bg-primary py-2.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            {busy ? 'AI 批阅中…' : '交 AI 批阅'}
          </button>
        </>
      )}

      {/* AI 点评 */}
      {feedback && (
        <>
          <div className="deckle rounded-md border bg-card p-4">
            <p className="mb-1 text-xs text-ochre">我的仿写</p>
            <p className="text-sm">{text}</p>
          </div>
          <div className="deckle rounded-md border border-secondary/40 bg-secondary/5 p-4">
            <p className="mb-1 text-xs text-secondary">AI 批阅</p>
            <MarkdownView source={feedback} />
          </div>
          <button onClick={next} className="rounded-md bg-primary py-2.5 text-sm text-primary-foreground">
            下一句
          </button>
        </>
      )}
    </ChallengeShell>
  );
}
