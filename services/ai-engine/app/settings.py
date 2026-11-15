"""
引擎设置模块：~/.pinglc/ 目录布局与 config.json 运行时配置

一切用户数据（配置/模型/缓存/日志）都收敛在 ~/.pinglc/ 下：
  ~/.pinglc/config.json   引擎运行时配置（设备、热加载、默认模型、各能力上次选用档案）
  ~/.pinglc/models/       模型文件（faster-whisper / kokoro / 对齐模型）
  ~/.pinglc/caches/       内容哈希缓存（tts/stt/translate）
  ~/.pinglc/logs/         引擎日志

写入语义：save_config 为「合并式更新」——只改动传入的键，未传的键保留现值，
避免部分更新（如只改 device）物理删除用户积累的 last_profiles 等配置；
落盘走「同目录临时文件 + os.replace」原子替换，写一半崩溃不会留下半截配置。
"""

import copy
import json
import os
import tempfile
import threading
from pathlib import Path

# 用户数据根目录（可被环境变量 PINGLC_HOME 覆盖，便于测试隔离）
PINGLC_HOME = Path(os.environ.get("PINGLC_HOME", Path.home() / ".pinglc"))

# 各子目录路径常量
MODELS_DIR = PINGLC_HOME / "models"
CACHES_DIR = PINGLC_HOME / "caches"
LOGS_DIR = PINGLC_HOME / "logs"
CONFIG_PATH = PINGLC_HOME / "config.json"

# config.json 的默认内容（首次启动生成）
DEFAULT_CONFIG: dict = {
    # 计算设备：auto 自动探测 CUDA / cpu 强制 CPU
    "device": "auto",
    # 启动时预热默认 STT 模型（显存常驻，首次转写零等待）
    "warm_start": True,
    # 默认 STT 模型规格（faster-whisper）
    "default_stt_model": "large-v3",
    # 各能力上次使用的档案名（与 web 端 provider_profiles 联动的记忆位）
    "last_profiles": {},
}


def ensure_dirs() -> None:
    """确保 ~/.pinglc 及其子目录存在（幂等）"""
    for d in (PINGLC_HOME, MODELS_DIR, CACHES_DIR, LOGS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def _backup_corrupt() -> None:
    """把损坏的 config.json 挪到 config.json.corrupt 保底（尽力而为，失败不阻断）

    save_config 的原子替换会直接覆盖损坏文件——若不先挪开，一次配置 PUT 就会
    永久丢掉用户积累的设置（last_profiles 等仍可能手工部分抢救）。
    用挪动而非复制：损坏文件离位后即不会重复备份。
    """
    try:
        os.replace(CONFIG_PATH, CONFIG_PATH.with_name(CONFIG_PATH.name + ".corrupt"))
    except OSError:
        pass


def _read_raw() -> dict:
    """读取 config.json 原始内容（不触发默认写入）；缺失返回空 dict

    损坏（非法 JSON / 非字典 / 无法解码的二进制内容）与读失败（权限/IO 故障）
    都先把原文件挪到 .corrupt 备份再返回空 dict，避免随后的默认值落盘无痕
    覆盖用户数据——原子替换只需目录写权限，读不到的原文件照样会被覆盖。
    """
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        # 解码失败（撕裂/二进制文件）与语法失败同属「文件损坏」：备份后回退默认
        _backup_corrupt()
        return {}
    except FileNotFoundError:
        return {}
    except OSError:
        # 读失败（权限/IO 故障）≠ 不存在：同样先备份再回退，不能静默返回默认值
        _backup_corrupt()
        return {}
    if not isinstance(data, dict):
        _backup_corrupt()
        return {}
    return data


def _as_dict(value: object) -> dict:
    """把「应为 dict」的配置值规整为 dict（异常值回退空 dict）"""
    return value if isinstance(value, dict) else {}


def _merge(updates: dict) -> dict:
    """合成完整配置：默认值（深拷贝）为底 + 现有文件内容 + 本次更新

    - 文件中缺失的键由默认值补齐（版本升级兼容），文件中的未知键保留（向前兼容）
    - last_profiles 按能力逐项合并（只改传入的能力，其余记忆位保留）
    - 更新中的未知键忽略（防止调用方笔误产生垃圾键）
    """
    merged = copy.deepcopy(DEFAULT_CONFIG)
    merged.update(_read_raw())
    merged["last_profiles"] = _as_dict(merged.get("last_profiles"))

    updates_known = {k: v for k, v in updates.items() if k in DEFAULT_CONFIG}
    profiles_update = _as_dict(updates_known.pop("last_profiles", None))
    merged["last_profiles"].update(profiles_update)
    merged.update(updates_known)
    return merged


def _atomic_write(config: dict) -> None:
    """原子落盘：先写同目录临时文件再 os.replace，崩溃不会留下半截 config.json"""
    fd, tmp_path = tempfile.mkstemp(dir=str(PINGLC_HOME), suffix=".config.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(config, ensure_ascii=False, indent=2))
        os.replace(tmp_path, CONFIG_PATH)
    finally:
        # 正常路径下临时文件已被 replace 消费；异常路径下清理残骸
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


# 读-合-写整段串行化锁：端点已放 FastAPI 线程池并发执行，
# 两个不相交键的 PUT 交叠时后写者会基于旧快照落盘、静默丢掉先写者的键
_config_lock = threading.Lock()


def load_config() -> dict:
    """读取运行时配置；文件缺失时落盘默认配置；返回结果的深拷贝"""
    ensure_dirs()
    with _config_lock:
        merged = _merge({})
        if not CONFIG_PATH.exists():
            _atomic_write(merged)
    return copy.deepcopy(merged)


def save_config(updates: dict) -> dict:
    """合并式写入运行时配置：只更新传入的键，其余键保留现值/默认值

    Args:
        updates: 需要更新的配置键值（部分字典即可，如 {"device": "cpu"}）
    Returns:
        合并后的完整配置（深拷贝，调用方的后续修改不会污染模块状态）
    """
    ensure_dirs()
    with _config_lock:
        merged = _merge(updates)
        _atomic_write(merged)
    return copy.deepcopy(merged)
