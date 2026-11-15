"""
capabilities API 层纯逻辑测试：_cloud_api_path 端点路径归一与拒绝、
_cloud_stt_payload 响应形状、_reporter 进度闭包工厂映射。

不触网、不碰引擎重模块（只覆盖纯函数；真实链路由端到端冒烟覆盖）。
"""

import pytest
from fastapi import HTTPException

from app.api.capabilities import _cloud_api_path, _cloud_stt_payload, _reporter
from app.jobs.runner import Job


def _job() -> Job:
    """最小任务对象（进度上报断言用）"""
    return Job(id="t", type="echo", params={})


# ---------------- 端点路径归一（阿里云原生 API 专属） ----------------


def test_cloud_api_path_none_when_absent():
    """params 无 apiPath / 空白：返回 None（走 OpenAI 兼容体系）"""
    assert _cloud_api_path({}) is None
    assert _cloud_api_path({"params": {}}) is None
    assert _cloud_api_path({"params": {"apiPath": "  "}}) is None


def test_cloud_api_path_short_form_normalized():
    """/services/… 短形式自动补 /api/v1 前缀（与全形式等效）"""
    p = {"params": {"apiPath": "services/aigc/multimodal-generation/generation"}}
    assert _cloud_api_path(p) == "/api/v1/services/aigc/multimodal-generation/generation"
    p2 = {"params": {"apiPath": "/api/v1/services/x/generation"}}
    assert _cloud_api_path(p2) == "/api/v1/services/x/generation"


def test_cloud_api_path_full_url_tolerated():
    """粘贴完整 URL：取 path 部分归一（两种写法等效）"""
    p = {
        "params": {
            "apiPath": (
                "https://token-plan.cn-beijing.maas.aliyuncs.com"
                "/api/v1/services/aigc/multimodal-generation/generation"
            )
        }
    }
    assert _cloud_api_path(p) == "/api/v1/services/aigc/multimodal-generation/generation"


def test_cloud_api_path_rejects_non_aliyun():
    """非阿里云体系路径（OpenAI 的 /v1/audio/transcriptions 等）：400 报配置错误——
    不再静默拼 /api/v1 前缀造出必 404 的地址（错误只以「云端返回 404」出现，无从定位）"""
    with pytest.raises(HTTPException) as ei:
        _cloud_api_path({"params": {"apiPath": "/v1/audio/transcriptions"}})
    assert ei.value.status_code == 400
    assert "仅支持阿里云" in ei.value.detail
    with pytest.raises(HTTPException):
        _cloud_api_path({"params": {"apiPath": "v2/xxx"}})


# ---------------- 云端 STT 响应构造 ----------------


def test_cloud_stt_payload_shape():
    """统一构造：language 空值归空串、四字段齐（同步/任务两路径共用同一形状）"""
    assert _cloud_stt_payload(None, "hi", []) == {
        "language": "",
        "duration": 0.0,
        "words": [],
        "text": "hi",
    }
    assert _cloud_stt_payload("en", "hi", [{"w": "hi"}]) == {
        "language": "en",
        "duration": 0.0,
        "words": [{"w": "hi"}],
        "text": "hi",
    }


# ---------------- 进度上报闭包工厂 ----------------


def test_reporter_factory_mapping():
    """base+scale 映射与文案：msg 优先，无 msg 用「label N%」"""
    job = _job()
    r = _reporter(job, base=0.25, scale=0.75)
    r(0.5)
    assert job.progress == pytest.approx(0.625)
    assert job.message == "语音合成 50%"
    r(0.5, "下载 kokoro-v1.0.onnx 40%")
    assert job.message == "下载 kokoro-v1.0.onnx 40%"
    # 下载支：占前 1/4（scale=0.25）
    dl = _reporter(job, scale=0.25)
    dl(0.5, "msg")
    assert job.progress == pytest.approx(0.125)
