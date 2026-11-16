'use client';

/**
 * 录音 Hook（跟读，需求 11）
 *
 * MediaRecorder 封装：权限申请、开始/停止、时长测量、轨道清理。
 * 安全上下文约束：MediaRecorder/getUserMedia 需 HTTPS（或 localhost）——
 * 局域网 IP 访问时提示用户走 ./scripts/dev-https.sh（错误信息直接展示）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 录音器状态 */
export type RecorderState = 'idle' | 'requesting' | 'recording' | 'error';

/** 录音结果（停止后产出） */
export interface RecordingResult {
  blob: Blob;
  durationMs: number;
  mime: string;
}

/**
 * 录音 Hook
 * @param opts.onDone 录音完成回调（含 Blob 与实测时长）
 */
export function useRecorder(opts: { onDone: (r: RecordingResult) => void }) {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // requesting 相位闸：权限弹窗等待期间 recorder/stream 两 ref 均为空，
  // 旧守卫拦不住第二次点击——第二次 getUserMedia 会弹重复授权并孤立轨道
  const startingRef = useRef(false);
  // 回调放 ref：调用方重渲染不中断进行中的录音
  const onDoneRef = useRef(opts.onDone);
  onDoneRef.current = opts.onDone;

  /** 清理（卸载或停止后释放轨道；同时释放 requesting 相位闸） */
  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recorderRef.current = null;
    startingRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** 卸载标记：权限弹窗等待期间组件被卸载（切标签页）时，
   *  await 返回后立即释放刚拿到的轨道（否则麦克风常亮） */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  /** 开始录音 */
  const start = useCallback(async () => {
    // 重入保护：requesting（权限弹窗中，两 ref 均空，靠 startingRef 拦）/
    // recording 期间的重复点击直接忽略，否则第二次 getUserMedia 会孤立
    // 第一次的轨道（麦克风保持打开）
    if (startingRef.current || recorderRef.current !== null || streamRef.current !== null) return;
    startingRef.current = true;
    setError(null);
    setState('requesting');
    // 安全上下文检查：局域网 http 下 getUserMedia 直接不可用
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setState('error');
      setError('录音需要 HTTPS：请通过 ./scripts/dev-https.sh 访问（手机先信任 mkcert 证书）');
      startingRef.current = false;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || recorderRef.current !== null) {
        // 等待期间已卸载或已有新录音：释放本次轨道与相位闸
        stream.getTracks().forEach((t) => t.stop());
        if (!mountedRef.current) startingRef.current = false;
        return;
      }
      streamRef.current = stream;
      // 浏览器兼容偏好：webm/opus 优先，Safari 回退 mp4
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const duration = Date.now() - startedAtRef.current;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        cleanup();
        // 卸载后到达的 onstop（录音中切路由，cleanup 停轨触发）：不再置状态、
        // 不再回调 onDone——否则组件卸载后仍发起上传/评分请求
        if (!mountedRef.current) return;
        setState('idle');
        setElapsedMs(0);
        if (blob.size > 0) {
          onDoneRef.current({ blob, durationMs: duration, mime: rec.mimeType || 'audio/webm' });
        }
      };
      startedAtRef.current = Date.now();
      rec.start();
      setState('recording');
      // 计时器：录音时长实时显示
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
    } catch (err) {
      cleanup();
      setState('error');
      const name = err instanceof Error ? err.name : '';
      setError(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝：请在浏览器设置中允许后重试'
          : `无法启动录音：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [cleanup]);

  /** 停止录音（触发 onstop → onDone） */
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  return { state, error, elapsedMs, start, stop };
}
