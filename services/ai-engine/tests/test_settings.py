"""
引擎设置模块测试：config.json 的合并式读写、原子落盘与默认值兜底

用 tmp 目录隔离（monkeypatch settings 的路径常量，不碰真实 ~/.pinglc）。
"""

import json

import pytest

from app import settings


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """把 settings 的目录/文件路径常量指到临时目录，返回临时 PINGLC_HOME"""
    home = tmp_path / "pinglc-home"
    monkeypatch.setattr(settings, "PINGLC_HOME", home)
    monkeypatch.setattr(settings, "MODELS_DIR", home / "models")
    monkeypatch.setattr(settings, "CACHES_DIR", home / "caches")
    monkeypatch.setattr(settings, "LOGS_DIR", home / "logs")
    monkeypatch.setattr(settings, "CONFIG_PATH", home / "config.json")
    return home


def test_first_load_writes_defaults(isolated):
    """首次读取：落盘默认配置，返回内容含全部默认键"""
    config = settings.load_config()
    assert (isolated / "config.json").exists()
    assert config == settings.DEFAULT_CONFIG


def test_partial_update_preserves_other_keys(isolated):
    """部分更新只改传入键：其他键与 last_profiles 不被物理删除"""
    settings.load_config()
    settings.save_config({"last_profiles": {"stt": "本地 faster-whisper"}})
    merged = settings.save_config({"device": "cpu"})
    assert merged["device"] == "cpu"
    assert merged["last_profiles"] == {"stt": "本地 faster-whisper"}
    assert merged["warm_start"] is True
    # 落盘内容与返回值一致
    on_disk = json.loads(settings.CONFIG_PATH.read_text(encoding="utf-8"))
    assert on_disk["device"] == "cpu"
    assert on_disk["last_profiles"] == {"stt": "本地 faster-whisper"}


def test_last_profiles_merged_per_capability(isolated):
    """last_profiles 按能力逐项合并，不做整体覆盖"""
    settings.save_config({"last_profiles": {"stt": "A", "tts": "B"}})
    merged = settings.save_config({"last_profiles": {"stt": "C"}})
    assert merged["last_profiles"] == {"stt": "C", "tts": "B"}


def test_unknown_update_keys_ignored(isolated):
    """更新中的未知键被忽略，不产生垃圾键"""
    merged = settings.save_config({"device": "cpu", "typo_key": 1})
    assert "typo_key" not in merged


def test_corrupted_file_falls_back_to_defaults(isolated):
    """配置文件损坏：读取回退默认值；损坏原文件挪到 .corrupt 保底（便于人工抢救），主文件自愈为默认配置"""
    settings.ensure_dirs()
    settings.CONFIG_PATH.write_text("{broken json", encoding="utf-8")
    config = settings.load_config()
    assert config["device"] == "auto"
    # 损坏内容被挪到 .corrupt；主文件重写为可用默认配置（下次读取不再走损坏分支）
    assert (isolated / "config.json.corrupt").read_text(encoding="utf-8") == "{broken json"
    assert json.loads(settings.CONFIG_PATH.read_text(encoding="utf-8"))["device"] == "auto"


def test_corrupted_file_backed_up_before_save_overwrite(isolated):
    """损坏后的一次配置写入不再无痕覆盖：先备份 .corrupt 再落盘新配置"""
    settings.ensure_dirs()
    settings.CONFIG_PATH.write_text("[1, 2]", encoding="utf-8")  # 合法 JSON 但非字典，同样视为损坏
    merged = settings.save_config({"device": "cpu"})
    assert merged["device"] == "cpu"
    assert (isolated / "config.json.corrupt").read_text(encoding="utf-8") == "[1, 2]"


def test_returned_config_is_deep_copy(isolated):
    """返回值与模块默认不共享可变对象（防 DEFAULT_CONFIG 被进程内污染）"""
    config = settings.load_config()
    config["last_profiles"]["x"] = "y"
    assert settings.DEFAULT_CONFIG["last_profiles"] == {}


def test_unreadable_file_backed_up_not_silently_replaced(isolated):
    """读失败（权限故障）≠ 不存在：先挪 .corrupt 备份再回退默认，随后的写入不再无痕覆盖"""
    settings.ensure_dirs()
    settings.CONFIG_PATH.write_text(
        '{"device": "cpu", "last_profiles": {"stt": "我的档案"}}', encoding="utf-8"
    )
    # 模拟读权限故障：PermissionError 属 OSError 但非 FileNotFoundError
    settings.CONFIG_PATH.chmod(0o000)
    config = settings.load_config()
    assert config["device"] == "auto"  # 回退默认值
    # 原文件被挪到 .corrupt 保底（os.replace 只需目录写权限，读不到也能挪）
    corrupt = isolated / "config.json.corrupt"
    corrupt.chmod(0o644)
    assert json.loads(corrupt.read_text(encoding="utf-8"))["last_profiles"] == {"stt": "我的档案"}
    # 主文件自愈为默认配置（下次读取不再走故障分支）
    assert json.loads(settings.CONFIG_PATH.read_text(encoding="utf-8"))["device"] == "auto"
