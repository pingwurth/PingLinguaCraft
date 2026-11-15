"""
TTS 共用逻辑测试：唯一分片工作目录构造、拼装入口的空分片防御

唯一目录是并发批量不互踩的根治点（固定名 .tts-parts 旧实现会串音/互删/
截断硬链接连缓存 inode 一起损坏）；空分片防御保证云端批量路径的非法输入
以领域错误而非 IndexError → 500 暴露。
"""

import pytest

from app.engines import tts_common
from app.media.ffmpeg import MediaError


def test_new_batch_workdir_unique_per_call(tmp_path):
    """每次调用产生独立目录：并发批量不共用工作区；目录落在输出同目录下"""
    out = tmp_path / "a.mp3"
    w1 = tts_common.new_batch_workdir(out)
    w2 = tts_common.new_batch_workdir(out)
    assert w1.parent == tmp_path
    assert w1 != w2
    assert w1.is_dir() and w2.is_dir()
    assert w1.name.startswith(".tts-parts-")


def test_assemble_timeline_empty_parts_raises(tmp_path):
    """空分片列表：领域错误 MediaError（而非 parts[0] 的 IndexError → 500）"""
    with pytest.raises(MediaError):
        tts_common.assemble_timeline([], str(tmp_path / "out.mp3"))
