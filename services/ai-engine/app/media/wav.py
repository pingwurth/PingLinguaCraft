"""
WAV 字节解析工具（不跑子进程）

供 SOE 转码产物测长（16kHz）与 kokoro 合成分片测长（24kHz）共用：
RIFF 块链走查而非假设固定 44 字节头（ffmpeg 可能写 LIST 等附加块），
按 16bit/单声道的字节速率换算毫秒。
"""


def wav_duration_ms(data: bytes, *, sample_rate: int = 16000) -> int:
    """按 RIFF 块链计算 16bit/单声道 wav 的时长（毫秒）

    Args:
        data:        wav 文件字节（支持含 LIST 等附加块的头）
        sample_rate: 采样率（字节速率 = sample_rate × 2 字节/秒；
                     SOE 转码产物 16000，kokoro 输出 24000）
    Returns:
        data 块声明的时长毫秒数；非 wav 或解析失败返回 0
    """
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return 0
    bytes_per_ms = sample_rate * 2 // 1000  # 16bit × 单声道 ÷ 8 ÷ 1000
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        if chunk_id == b"data":
            return size // bytes_per_ms if bytes_per_ms else 0
        pos += 8 + size + (size & 1)  # 块内容按 2 字节对齐
    return 0
