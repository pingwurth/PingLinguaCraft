'use client';

/**
 * 「听写」标签页（需求 10：两种模式切换 —— 选词拼句 / 完整句子听写）
 *
 * - 选词拼句：当前句的词块（种子洗牌可复现 + 邻句干扰词）按序点选拼句，即时校验
 * - 全句听写：听句（可重听/慢速）→ 输入 → core.diffSentence 逐词判分（typo 宽容）
 * - 句间导航：上一句/下一句；跳转当前播放句
 */

import { useMemo, useState } from 'react';
import { extractWords, seededShuffle, diffSentence, type SentenceDiff } from '@pinglc/core';
import { usePlayer } from '@/features/player/store';
import { playSentenceOnce } from './playUtils';
import type { CueDTO } from '@/lib/api';

/** 听写模式 */
type DictationMode = 'assembly' | 'full';

/**
 * 听写标签页
 * @param props.cues 全部句段
 */
export function DictationTab({ cues }: { cues: CueDTO[] }) {
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);
  const [mode, setMode] = useState<DictationMode>('assembly');
  // 听写自持进度（不跟随播放切换；从当前句起）
  const [index, setIndex] = useState(() => Math.max(0, activeCueIndex));
  const cue = cues[index];

  /* ---------- 选词拼句 ---------- */
  // 词块 = 当前句全部词 + 邻句抽 2-4 个干扰词；种子 = material-cue-mode（重试/刷新同排列）
  const [seedSalt, setSeedSalt] = useState(0);
  const tiles = useMemo(() => {
    if (!cue) return [];
    const words = extractWords(cue.textEn);
    // 干扰词：从相邻句抽（当前句没有的）
    const neighbors = [cues[index - 1], cues[index + 1]].filter(Boolean) as CueDTO[];
    const pool = new Set<string>();
    for (const n of neighbors) {
      for (const w of extractWords(n.textEn)) {
        const lower = w.toLowerCase();
        if (!words.some((x) => x.toLowerCase() === lower) && pool.size < 3) pool.add(w);
      }
    }
    return seededShuffle([...words, ...pool], `${cue.materialId}-${cue.id}-assembly-${seedSalt}`);
  }, [cue, cues, index, seedSalt]);
  const [picked, setPicked] = useState<number[]>([]);
  const [checked, setChecked] = useState(false);

  /* ---------- 全句听写 ---------- */
  const [typed, setTyped] = useState('');
  const [diff, setDiff] = useState<SentenceDiff | null>(null);

  /** 切句重置 */
  const goto = (i: number) => {
    const clamped = Math.min(cues.length - 1, Math.max(0, i));
    setIndex(clamped);
    setPicked([]);
    setChecked(false);
    setTyped('');
    setDiff(null);
  };

  /** 听当前句 */
  const listen = () => {
    if (cue) playSentenceOnce(cue.startMs, cue.endMs);
  };

  /** 拼句校验（用户已选词序 vs 原文词序，大小写宽容） */
  const assemblyCorrect =
    cue != null &&
    picked.length === extractWords(cue.textEn).length &&
    picked
      .map((ti) => tiles[ti])
      .every((w, i) => w.toLowerCase() === extractWords(cue.textEn)[i]!.toLowerCase());

  if (!cue) {
    return <div className="py-16 text-center text-sm text-muted-foreground">暂无句段</div>;
  }

  return (
    /* 听写容器 */
    <div className="flex flex-col gap-4 py-4">
      {/* 模式切换（需求 10：两种模式） */}
      <div className="deckle flex rounded-md border bg-card p-1 text-sm">
        <button
          onClick={() => setMode('assembly')}
          className={`flex-1 rounded px-3 py-1.5 ${mode === 'assembly' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
        >
          选词拼句
        </button>
        <button
          onClick={() => setMode('full')}
          className={`flex-1 rounded px-3 py-1.5 ${mode === 'full' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
        >
          全句听写
        </button>
      </div>

      {/* 句导航 + 听句 */}
      <div className="flex items-center gap-2 text-sm">
        <button onClick={() => goto(index - 1)} disabled={index === 0} className="deckle rounded-md border px-3 py-1.5 disabled:opacity-40">
          ‹ 上一句
        </button>
        <span className="text-xs text-ochre">
          第 {index + 1}/{cues.length} 句
        </span>
        <button
          onClick={() => goto(activeCueIndex)}
          className="rounded-md border border-ochre/40 px-2.5 py-1.5 text-xs text-ochre"
          title="跳到播放位置"
        >
          回到播放句
        </button>
        <button onClick={() => goto(index + 1)} disabled={index >= cues.length - 1} className="deckle ml-auto rounded-md border px-3 py-1.5 disabled:opacity-40">
          下一句 ›
        </button>
      </div>

      {/* 听句按钮（大目标触控） */}
      <button
        onClick={listen}
        className="deckle flex items-center justify-center gap-2 rounded-md border bg-card py-3.5 text-sm font-medium"
      >
        <span className="material-symbols-outlined text-2xl text-primary">volume_up</span>
        听本句（自动停在句尾）
      </button>

      {mode === 'assembly' ? (
        /* —— 选词拼句 —— */
        <div className="flex flex-col gap-4">
          {/* 拼装槽：已选词序 */}
          <div className="deckle flex min-h-14 flex-wrap items-center gap-1.5 rounded-md border border-dashed bg-card p-2.5">
            {picked.length === 0 && <span className="px-1 text-xs text-muted-foreground">点下方词块，按听到的顺序拼出句子…</span>}
            {picked.map((ti, pos) => (
              <button
                key={`${ti}-${pos}`}
                onClick={() => {
                  if (!checked) setPicked(picked.filter((_, p) => p !== pos));
                }}
                className={`rounded bg-background px-2.5 py-1.5 font-serif text-sm deckle border ${
                  checked
                    ? assemblyCorrect
                      ? 'border-secondary text-secondary'
                      : extractWords(cue.textEn)[pos]?.toLowerCase() === tiles[ti]!.toLowerCase()
                      ? 'border-secondary text-secondary'
                      : 'border-destructive text-destructive'
                    : ''
                }`}
              >
                {tiles[ti]}
              </button>
            ))}
          </div>
          {/* 词块池 */}
          <div className="flex flex-wrap gap-1.5">
            {tiles.map((w, ti) => (
              <button
                key={ti}
                disabled={picked.includes(ti) || checked}
                onClick={() => setPicked([...picked, ti])}
                className="deckle rounded-md border bg-background px-3 py-2 font-serif text-sm transition-colors hover:bg-accent disabled:opacity-25"
              >
                {w}
              </button>
            ))}
          </div>
          {/* 校验结果与操作 */}
          {checked ? (
            <div className={`rounded-md p-3 text-sm ${assemblyCorrect ? 'bg-secondary/10 text-secondary' : 'bg-destructive/10 text-destructive'}`}>
              {assemblyCorrect ? '✓ 拼对了！' : '× 顺序或用词有误（红块位置不对），再试一次'}
            </div>
          ) : null}
          <div className="flex gap-2">
            {!checked ? (
              <button
                onClick={() => setChecked(true)}
                disabled={picked.length === 0}
                className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground disabled:opacity-40"
              >
                校验
              </button>
            ) : (
              <>
                <button
                  onClick={() => {
                    setPicked([]);
                    setChecked(false);
                    setSeedSalt((s) => s + 1); // 重洗（新种子）
                  }}
                  className="flex-1 rounded-md border border-border py-2.5 text-sm"
                >
                  重洗词块
                </button>
                <button onClick={() => goto(index + 1)} className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground">
                  下一句
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        /* —— 全句听写 —— */
        <div className="flex flex-col gap-3">
          <textarea
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setDiff(null);
            }}
            placeholder="听写整句（大小写与标点不判）…"
            className="min-h-24 w-full rounded-md border border-input bg-background p-3 font-serif text-base"
          />
          {diff && (
            /* 逐词判分展示 */
            <div className="flex flex-wrap gap-1.5 rounded-md bg-card p-3">
              {diff.items.map((it, i) => (
                <span
                  key={i}
                  className={
                    it.status === 'correct'
                      ? 'text-secondary'
                      : it.status === 'typo'
                        ? 'text-ochre'
                        : it.status === 'extra'
                          ? 'text-destructive line-through'
                          : 'text-destructive underline decoration-wavy'
                  }
                  title={`${it.status}${it.typed && it.target ? `（你写 ${it.typed}）` : ''}`}
                >
                  {it.target || it.typed}
                </span>
              ))}
              <span className="ml-auto self-center text-xs text-muted-foreground">
                得分 {Math.round(diff.score * 100)}{diff.exact ? ' · 全对！' : ''}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setDiff(diffSentence(cue.textEn, typed))}
              disabled={!typed.trim()}
              className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground disabled:opacity-40"
            >
              判分
            </button>
            <button
              onClick={() => {
                setTyped('');
                setDiff(null);
              }}
              className="rounded-md border border-border px-4 py-2.5 text-sm"
            >
              重写
            </button>
            {diff && (
              <button onClick={() => goto(index + 1)} className="rounded-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                下一句
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
