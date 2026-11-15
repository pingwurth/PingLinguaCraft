#!/usr/bin/env bash
# engine-setup.sh —— 初始化本地 AI 引擎环境（uv 依赖 + 可选引擎 + MFA 镜像）
#
# 分层安装策略（对应计划的「安装痛苦」风险缓解）：
#   核心层   ：fastapi/uvicorn/httpx（任务 API 与云端透传，必装）
#   stt 层   ：faster-whisper + CUDA 运行库（默认 STT 路径）
#   tts 层   ：edge-tts + kokoro-onnx（两套 TTS）
#   align 层 ：whisperx（可选，pip 依赖较重；MFA 走 Docker）
#   MFA     ：Montreal Forced Aligner 固定版本 Docker 镜像
#             （模型在 GitHub Releases：由脚本在宿主侧预下载后 COPY 进
#              镜像——容器内不联网；curl 自动走系统代理，在位文件跳过）
#
# 重要：uv sync 默认是「精确同步」——每次调用都会卸载不在本次目标里的包。
# 多层安装必须在同一条 uv sync 中一次声明全部 extras（逐个 --extra 安装会
# 互相卸载：先 --extra stt 再 --extra tts 会把 faster-whisper 摘掉）。
#
# 用法：
#   ./scripts/engine-setup.sh            # 核心层 + stt + tts（推荐基线）
#   ./scripts/engine-setup.sh --all      # 全量（含 whisperx 与 MFA 镜像）
#   ./scripts/engine-setup.sh --core     # 仅核心层（最轻）
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../services/ai-engine" && pwd)"
MODE="${1:-baseline}"

# 参数白名单校验：未知值直接报用法退出——静默落入 baseline 会装出一套与预期
# 不同的环境（少装/多装重依赖），排查成本极高
case "$MODE" in
  baseline|--all|--core) ;;
  *)
    echo "用法: $0 [--all|--core|无参=baseline]；未知参数: \"$MODE\"" >&2
    exit 2
    ;;
esac

# 按模式组装 extras 参数（一条 uv sync 声明全部所选层，规避精确同步互卸）
EXTRAS=()
if [[ "$MODE" != "--core" ]]; then
  EXTRAS+=(--extra stt --extra tts)
fi
if [[ "$MODE" == "--all" ]]; then
  EXTRAS+=(--extra align)
fi

echo "== 1/3 同步依赖（uv，extras: ${EXTRAS[*]:-无}）=="
uv sync --directory "$ENGINE_DIR" ${EXTRAS[@]+"${EXTRAS[@]}"}

if [[ "$MODE" == "--all" ]]; then
  echo "== 2/3 构建 MFA Docker 镜像 =="
  if command -v docker >/dev/null 2>&1; then
    if [[ -d "$ENGINE_DIR/mfa-docker" ]]; then
      # MFA 模型预下载（宿主侧）：不在容器内下载——GitHub 资产在国内网络
      # 即使走代理也易长传断流；宿主 curl 自动吃系统代理（https_proxy），
      # 可重试/续传，且在位文件跳过（支持手工放置的离线迁移，与 kokoro
      # 模型同策略）。版本由 URL 锁定，升版本改这里即可
      MFA_MODELS_DIR="$ENGINE_DIR/mfa-docker/models"
      MFA_MODEL_URLS=(
        "acoustic/english_us_arpa.zip|https://github.com/MontrealCorpusTools/mfa-models/releases/download/acoustic-english_us_arpa-v3.0.0/english_us_arpa.zip"
        "dictionary/english_us_arpa.dict|https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-english_us_arpa-v3.0.0/english_us_arpa.dict"
        "acoustic/english_mfa.zip|https://github.com/MontrealCorpusTools/mfa-models/releases/download/acoustic-english_mfa-v3.1.0/english_mfa.zip"
        "dictionary/english_mfa.dict|https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-english_mfa-v3.1.0/english_mfa.dict"
      )
      for entry in "${MFA_MODEL_URLS[@]}"; do
        rel="${entry%%|*}"; url="${entry#*|}"
        dest="$MFA_MODELS_DIR/$rel"
        if [[ -s "$dest" ]]; then continue; fi
        mkdir -p "$(dirname "$dest")"
        echo "下载 MFA 模型 $rel …"
        curl -fsSL --retry 3 --retry-delay 2 -C - -o "$dest" "$url"
      done
      docker build -t pinglc-mfa:latest "$ENGINE_DIR/mfa-docker"
    else
      # 目录缺席说明仓库不完整或被裁剪；如实跳过而不是让脚本失败
      echo "跳过：$ENGINE_DIR/mfa-docker 不存在（无法构建 pinglc-mfa 镜像）"
    fi
  else
    echo "未安装 Docker，跳过 MFA 镜像（/system/capabilities 将如实报告不可用）"
  fi
else
  echo "== 2/3 跳过 MFA 镜像（--all 时安装）=="
fi

echo "== 3/3 完成 =="
echo ""
echo "启动引擎："
echo "  uv run --directory $ENGINE_DIR uvicorn app.main:app --port 8765"
echo "验证：curl -s http://127.0.0.1:8765/system/capabilities"
