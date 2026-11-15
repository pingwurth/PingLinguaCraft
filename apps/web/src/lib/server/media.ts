/**
 * 媒体文件路径与导入辅助（服务端）
 *
 * 媒体目录布局：~/.pinglc/media/{collectionId}/{materialId}/
 *   original.{ext}   上传/下载的原始媒体（或 tts.mp3 文本合成产物）
 *   stt.wav          16kHz 单声道抽取音频（STT 与单句切片复用）
 *   peaks.json       波形峰值
 */

import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { MEDIA_ROOT } from '@/lib/db';

/**
 * 取材料媒体目录（绝对路径；自动创建）
 * @param collectionId 材料集 id
 * @param materialId   材料 id
 */
export function materialDir(collectionId: number, materialId: number): string {
  const dir = join(MEDIA_ROOT, String(collectionId), String(materialId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 绝对路径 → 相对 MEDIA_ROOT 的库内路径（media_path 字段存储形态）
 * @param absPath 绝对路径
 * @returns 越界（符号链接/调用方拼错目录）返回 null——'../..' 形态的路径写进
 *          DB 只会产生死材料（/api/media 的收窄检查会拒发），调用方应失败而非落库
 */
export function relMediaPath(absPath: string): string | null {
  const rel = relative(resolve(MEDIA_ROOT), resolve(absPath));
  if (rel.startsWith('..') || rel === '') return null;
  return rel;
}

/**
 * 媒体 MIME → 扩展名（上传文件命名用）
 * @param mime MIME 类型
 * @param fallback 原始文件名的扩展名（未知 mime 时兜底）
 */
export function extFromMime(mime: string, fallback?: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
  };
  return map[mime] ?? (fallback && /^\w{2,5}$/.test(fallback) ? fallback : 'bin');
}

/** 引擎允许读写的白名单扩展（媒体与抽取产物） */
export const MEDIA_EXTS = new Set([
  'mp4', 'webm', 'mkv', 'mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'json', 'vtt', 'srt',
]);
