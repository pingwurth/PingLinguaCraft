"""
腾讯云智聆口语评测（新版 SOE）适配器 —— 录音文件评测（rec_mode=1）

流程：ffmpeg 转码（浏览器录音 webm/opus、mp4 → 16kHz/16bit/单声道 wav，SOE 不收
webm）→ 拼 HMAC-SHA1 签名连 wss://soe.cloud.tencent.com/soe/api/<AppID> →
整段音频一个 binary 帧发出（录音模式不支持分片，上限 60 秒）→ 收词级+音素级
评分 JSON（result 为序列化字符串，final=1 收尾）→ 归一化为 snake_case 回传 web。

鉴权（区别于 TC3-HMAC-SHA256）：除 signature 外参数按字典序拼「host+path+未编码
query」为签名原文，SecretKey 做 HMAC-SHA1 后 Base64；signature 在真实请求里需
urlencode。参数：secretid / timestamp / expired / nonce（文档 107497）。

文档：https://cloud.tencent.com/document/product/1774/107497
     https://cloud.tencent.com/document/product/1774/107376（音频格式）
"""

import asyncio
import base64
import hmac
import random
import time
import uuid
from urllib.parse import urlencode, urlsplit

import orjson

from ..media import ffmpeg
from ..media.wav import wav_duration_ms
from ..settings import CACHES_DIR
from ..ws_session import WsSession

# SOE 服务地址（档案 endpoint_url 缺省时的兜底；签名原文取其 host+path）
DEFAULT_ENDPOINT = "wss://soe.cloud.tencent.com/soe/api"

# 苛刻指数缺省（1.0 宽松 ~ 4.0 严格，成人学习者取中性）
DEFAULT_SCORE_COEFF = 2.0

# 录音模式一次性上传的时长上限（服务端硬限；前置拦截给出友好提示）
MAX_AUDIO_SEC = 60.0

# 句子/段落模式的词数上限（超过段落上限直接判无效文本）
MAX_SENTENCE_WORDS = 30
MAX_PARAGRAPH_WORDS = 120

# 单条消息等待上限（秒）：60s 音频服务端几秒内出分，30s 足够宽裕
RECV_TIMEOUT_SEC = 30.0


class SoeError(RuntimeError):
    """口语评测失败（凭据/网络/音频/服务端错误统一包装，消息可直接展示）"""


# 常见业务错误码 → 中文提示（完整表见文档「业务错误码」页，未列出的原样透传）
_ERROR_MESSAGES = {
    4002: "鉴权失败：请检查 AppId / SecretId / SecretKey 是否正确",
    4003: "服务未开通：请在腾讯云控制台开通智聆口语评测（新版）",
    4004: "资源包耗尽：请购买口语评测套餐包",
    4005: "账户欠费",
    4006: "并发超限：请稍后重试",
    4007: "音频解码失败：请重录后再试",
    4008: "音频上传等待超时：请重试",
    4014: "音频时长超限（录音模式上限 60 秒）",
    4102: "评测文本为空或无效",
    4103: "评测文本包含无法评测的词汇",
    4104: "评测文本超长",
    4105: "未检测到人声：请靠近麦克风、稍放大音量重读",
    4108: "未识别到有效语音：请重试",
    4115: "评测文本与评测引擎不匹配（英文内容请用 16k_en）",
}


def _error_text(code: int, message: str) -> str:
    """业务错误码 → 展示文案（未收录的码带上原始 message）"""
    known = _ERROR_MESSAGES.get(code)
    return f"口语评测失败（{code}）：{known or message or '服务异常'}"


def sanitize_ref_text(text: str) -> str:
    """清洗评测文本：竖线是 SOE 多分支语法，普通文本里替换为空格；去首尾空白"""
    return text.replace("|", " ").strip()


def pick_eval_mode(ref_text: str) -> int:
    """按词数选评测模式：≤30 词句子模式(1)，否则段落模式(2)；超 120 词报错"""
    words = len(ref_text.split())
    if words == 0:
        raise SoeError("评测文本为空")
    if words > MAX_PARAGRAPH_WORDS:
        raise SoeError(f"评测文本过长（{words} 词，上限 {MAX_PARAGRAPH_WORDS} 词）")
    return 1 if words <= MAX_SENTENCE_WORDS else 2


def parse_score_coeff(value: object) -> float:
    """解析苛刻指数：合法范围 [1.0, 4.0]，非法/缺省回落默认值"""
    try:
        coeff = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_SCORE_COEFF
    return coeff if 1.0 <= coeff <= 4.0 else DEFAULT_SCORE_COEFF


def server_engine_type(language: str) -> str:
    """语言 → 评测引擎型号（本项目主用英文）"""
    return "16k_zh" if language.startswith("zh") else "16k_en"


def build_ws_url(
    endpoint: str,
    app_id: str,
    secret_id: str,
    secret_key: str,
    *,
    ref_text: str,
    score_coeff: float,
    language: str,
    voice_id: str | None = None,
    timestamp: int | None = None,
    nonce: int | None = None,
) -> str:
    """构造带签名的 wss 连接 URL

    签名原文 = host+path+/+appId+?+按字典序拼接的未编码参数（不含 wss:// 前缀）；
    实际请求对全部参数（含 signature）做 urlencode。
    """
    parts = urlsplit(endpoint or DEFAULT_ENDPOINT)
    if not parts.netloc:
        raise SoeError("口语评测服务地址无效（应形如 wss://soe.cloud.tencent.com/soe/api）")
    host_path = f"{parts.netloc}{parts.path.rstrip('/')}"

    ts = timestamp if timestamp is not None else int(time.time())
    params: dict[str, str] = {
        "secretid": secret_id,
        "timestamp": str(ts),
        "expired": str(ts + 3600),
        "nonce": str(nonce if nonce is not None else random.randint(1, 10**10 - 1)),
        "server_engine_type": server_engine_type(language),
        "voice_id": voice_id or uuid.uuid4().hex,
        "voice_format": "1",  # wav
        "ref_text": ref_text,
        "eval_mode": str(pick_eval_mode(ref_text)),
        "score_coeff": f"{score_coeff:g}",
        "rec_mode": "1",  # 录音文件模式：一次性整段发送
        "sentence_info_enabled": "0",  # 录音模式无需中间结果
    }
    # 签名原文：字典序 key=value 用 & 拼接（值保持原文不 urlencode）
    sign_base = f"{host_path}/{app_id}?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    signature = base64.b64encode(
        hmac.new(secret_key.encode("utf-8"), sign_base.encode("utf-8"), "sha1").digest()
    ).decode("ascii")
    query = urlencode({**params, "signature": signature})
    return f"wss://{host_path}/{app_id}?{query}"


def normalize_result(raw: str | bytes | dict) -> dict:
    """SOE PascalCase 结果 → 前端友好的 snake_case

    输入 result 为序列化字符串（或已被解析的 dict），输出：
      {score, accuracy, fluency, completion, status, words:[{word, accuracy,
       match_tag, begin_ms, end_ms, phones:[…]}]}
    """
    data = orjson.loads(raw) if isinstance(raw, (str, bytes)) else dict(raw or {})

    # 流利度标度归一：官方文档（107386 各模式返回示例）的 PronFluency 恒为
    # 0~1 比率（如 0.8466…），PronAccuracy/PronCompletion 才是 0~100——与
    # 2026-11 真机实测一致。据此定规则：≤1 一律按比率放大到百分制（文档口径
    # 下这是唯一合理解释）；>1 仅作防御兼容（中转网关若回百分制原样保留）
    fluency = float(data.get("PronFluency") or 0.0)
    if 0 < fluency <= 1.0:
        fluency *= 100

    words_out: list[dict] = []
    for w in data.get("Words") or []:
        # 音素级明细（PhoneInfos）：phone=实际发音音素，reference_phone=标准音素
        phones = [
            {
                "phone": p.get("Phone", ""),
                "reference_phone": p.get("ReferencePhone", ""),
                "accuracy": float(p.get("PronAccuracy") or 0.0),
                "match_tag": int(p.get("MatchTag") or 0),
                "stress": bool(p.get("Stress")),
                "detected_stress": bool(p.get("DetectedStress")),
            }
            for p in w.get("PhoneInfos") or []
        ]
        words_out.append(
            {
                "word": str(w.get("Word") or w.get("ReferenceWord") or ""),
                "accuracy": float(w.get("PronAccuracy") or 0.0),
                # MatchTag 语义（文档 1774/107384）：0 匹配 / 1 增读 / 2 漏读 / 3 错读 / 4 未录入
                "match_tag": int(w.get("MatchTag") or 0),
                # 词时间字段新版带 Mem 前缀（文档 107384/107386），旧字段名兜底
                "begin_ms": int(w.get("MemBeginTime") or w.get("BeginTime") or 0),
                "end_ms": int(w.get("MemEndTime") or w.get("EndTime") or 0),
                "phones": phones,
            }
        )
    return {
        "score": float(data.get("SuggestedScore") or 0.0),
        "accuracy": float(data.get("PronAccuracy") or 0.0),
        "fluency": fluency,
        "completion": float(data.get("PronCompletion") or 0.0),
        "status": str(data.get("Status") or ""),
        "words": words_out,
    }


async def evaluate(
    audio_path: str,
    ref_text: str,
    *,
    endpoint: str,
    app_id: str,
    secret_id: str,
    secret_key: str,
    score_coeff: object = DEFAULT_SCORE_COEFF,
    language: str = "en",
) -> dict:
    """录音文件口语评测主流程（音频转码/文件 IO 放线程池，WS IO 在事件循环）

    Returns:
        normalize_result 的归一化结果
    Raises:
        SoeError: 转码失败 / 音频超限 / 鉴权或服务端业务错误 / 传输层失败
    """
    text = sanitize_ref_text(ref_text)
    pick_eval_mode(text)  # 前置校验词数（空文本/超长直接抛错，不浪费一次连接）

    # 转码到 SOE 规范的 16k/16bit/单声道 wav（阻塞子进程与文件 IO 均放线程池）
    cache_dir = CACHES_DIR / "soe"
    wav_path = cache_dir / f"{uuid.uuid4().hex}.wav"
    try:
        await asyncio.to_thread(cache_dir.mkdir, parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(ffmpeg.extract_audio, audio_path, str(wav_path))
        except ffmpeg.MediaError as exc:
            # MediaError 尾部带 ffmpeg stderr（500 字符），展示只留要点
            raise SoeError(f"录音转码失败：{str(exc)[-120:]}") from exc
        data = await asyncio.to_thread(wav_path.read_bytes)
        if not data:
            raise SoeError("录音内容为空，请重录")
        # 时长由转码产物算术求得（16k/16bit/单声道 RIFF），省一次 ffprobe 子进程
        duration_ms = wav_duration_ms(data)
        if duration_ms > MAX_AUDIO_SEC * 1000:
            raise SoeError(
                f"录音过长（{duration_ms / 1000:.0f}s，录音评测上限 {MAX_AUDIO_SEC:.0f}s）"
            )

        url = build_ws_url(
            endpoint, app_id, secret_id, secret_key,
            ref_text=text,
            score_coeff=parse_score_coeff(score_coeff),
            language=language,
        )
        return await _run_session(url, data)
    finally:
        # 转码失败时文件未生成，容忍缺失
        await asyncio.to_thread(wav_path.unlink, missing_ok=True)


async def _run_session(url: str, data: bytes) -> dict:
    """单次 WS 会话：握手 → 整段 binary 上传 → end 信号 → 收结果直到 final=1

    消息统一按 JSON 处理（code!=0 抛错；result 保留最后一条；final=1 收尾）。
    建连/限时收发与传输层异常归一走共享的 WsSession（超时策略与异常捕获
    顺序——TimeoutError 须先于 OSError 系——在 ws_session.py 单一维护），
    业务错误仍在本层包装为 SoeError，FastAPI 层不出现裸 500。
    """
    result = None
    async with WsSession(
        url, error=SoeError, label="评测服务", recv_timeout=RECV_TIMEOUT_SEC
    ) as ws:
        await ws.send(data)  # 录音模式：整段音频一个 binary 帧
        await ws.send('{"type": "end"}')  # 结束信号（text 帧）
        while True:
            raw = await ws.recv()
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            try:
                msg = orjson.loads(raw)
            except orjson.JSONDecodeError as exc:
                raise SoeError(f"评测服务返回了无法解析的消息：{str(raw)[:120]}") from exc
            code = int(msg.get("code") or 0)
            if code != 0:
                raise SoeError(_error_text(code, str(msg.get("message") or "")))
            if msg.get("result"):
                result = msg["result"]  # 同一连接可能多条（此处无中间结果，防御保留）
            if msg.get("final") == 1:
                break
    if result is None:
        raise SoeError("评测服务未返回结果，请重试")
    return normalize_result(result)
