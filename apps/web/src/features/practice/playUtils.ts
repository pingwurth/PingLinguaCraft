/**
 * 练习模式播放辅助（听写/跟读共用）
 *
 * 通过 window 自定义事件驱动 Player（与工坊跳播同一桥），
 * 保持练习组件与媒体元素解耦。
 */

/**
 * 播放单句一次（到句尾自动暂停）
 * @param startMs 句起始毫秒
 * @param endMs   句结束毫秒
 */
export function playSentenceOnce(startMs: number, endMs: number): void {
  window.dispatchEvent(
    new CustomEvent('pinglc:play-range', { detail: { startMs, endMs } })
  );
}

/**
 * 停止播放
 */
export function stopPlayback(): void {
  window.dispatchEvent(new CustomEvent('pinglc:pause'));
}
