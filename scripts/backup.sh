#!/usr/bin/env bash
# backup.sh —— 备份 ~/.pinglc（数据库 + 配置 + 媒体 + 模型缓存可选）
#
# 单用户自托管的学习数据（材料、字幕、生词、笔记、进度）都在 ~/.pinglc/，
# 定期备份到指定目录，防患于未然。媒体与模型体积大，默认排除模型目录。
#
# 数据库一致性（关键设计）：pinglc.db 运行在 WAL 模式，web 进程长期持有连接
# 并持续写 -wal——直接 tar 主库三件套（.db/-wal/-shm）必然撕裂：三个文件是
# 在不同瞬间读到的，恢复时可能 malformed。因此实时库三件套绝不入包，改用
# SQLite 在线一致性快照生成自洽单文件（sqlite3 分支 VACUUM INTO / python3 分支
# backup API——均为写入方无感知的页级复制，不依赖 checkpoint 是否成功），
# quick_check 校验通过后才以 .pinglc/pinglc.db 之名打入归档。无 sqlite3/python3
# 可用时宁可中止也不产出「看似可恢复实则撕裂」的备份。
#
# 落定纪律：归档先写 .tmp、全量解压校验通过后改名——半截备份不占保留位、
# 不会被误恢复；轮转 glob 限定精确时间戳格式，不误删手工放置的非标准文件。
#
# 用法：
#   ./scripts/backup.sh [目标目录]           # 默认 ~/pinglc-backups
#   ./scripts/backup.sh /mnt/backup --full   # --full 连模型一起备份
set -euo pipefail

DEST_DIR="${1:-$HOME/pinglc-backups}"
FULL="${2:-}"
SRC="$HOME/.pinglc"
KEEP=10   # 轮转保留的最近份数

if [[ ! -d "$SRC" ]]; then
  echo "~/.pinglc 不存在，无需备份" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST_DIR/pinglc-$STAMP.tar.gz"
TMP_OUT="$OUT.tmp"   # 先写临时名，校验通过才 mv 落定

# 快照暂存目录放目标盘而非 /tmp（/tmp 常为 tmpfs，大库快照会吃内存）；中断/失败一律清理
STAGE="$(mktemp -d "$DEST_DIR/.pinglc-snap.XXXXXX")"
trap 'rm -rf "$STAGE" "$TMP_OUT"' EXIT

# ---- 生成自洽数据库快照（在线备份；成功后 quick_check 复核）----

# python3 备用快照分支：路径经 argv 传入，不拼接进 Python 源码（路径含引号/
# 反斜杠时既不会语法错误也没有注入面）；在线备份 API 为页级复制，写入方无感知
snapshot_with_python() { # $1=源库 $2=快照目标
  python3 - "$1" "$2" <<'PYEOF'
import sys, sqlite3

src = sqlite3.connect(sys.argv[1])   # 源库（argv 传入，杜绝字符串拼接）
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)                  # 在线备份 API：页级复制，写入方无感知
src.close()
dst.close()
check = sqlite3.connect(sys.argv[2]).execute("PRAGMA quick_check;").fetchone()[0]
sys.exit(0 if check == "ok" else 1)
PYEOF
}

# 快照双重校验：文件非空 + quick_check 为 ok。非空断言必不可少——对不存在
# 的文件跑 quick_check，sqlite3 CLI 会新建空库并返回 ok，假通过会把空 schema
# 库当「可恢复备份」打进归档；无 sqlite3 CLI 的机器（python3 分支）用 python3 复核
snapshot_ok() { # $1=快照文件
  [[ -s "$1" ]] || return 1
  if command -v sqlite3 >/dev/null 2>&1; then
    [[ "$(sqlite3 "$1" 'PRAGMA quick_check;' 2>/dev/null)" == "ok" ]]
  else
    python3 - "$1" <<'PYCHK'
import sys, sqlite3
sys.exit(0 if sqlite3.connect(sys.argv[1]).execute("PRAGMA quick_check;").fetchone()[0] == "ok" else 1)
PYCHK
  fi
}

DB="$SRC/pinglc.db"
HAVE_DB=0
if [[ -f "$DB" ]]; then
  HAVE_DB=1
  SNAP="$STAGE/__snap__.db"
  snap_failed=0
  if command -v sqlite3 >/dev/null 2>&1; then
    # 用 VACUUM INTO 而非 .backup dot-command：dot-command 的引号解析规则不明确，
    # DEST_DIR 路径含引号时会语法错误产出残缺快照；SQL 字符串字面量的转义规则
    # 是确定的（' → ''），语义同样是在线一致性快照（页级复制，写入方无感知）。
    # -cmd '.timeout 5000'：CLI 位置参数只保证处理一个 SQL，dot-command 走选项通道
    # 才不依赖多位置参数的构建差异；CLI 默认 busy_timeout=0，库被瞬时锁住会立刻
    # 失败中止备份，此处对齐 python 分支 connect 的默认 5s 重试窗，两个分支行为一致
    snap_sql="${SNAP//\'/\'\'}"
    if ! sqlite3 -bail -cmd '.timeout 5000' "$DB" "VACUUM INTO '$snap_sql';" \
       || ! snapshot_ok "$SNAP"; then
      # sqlite3 在场但失败（典型：版本 < 3.27 不支持 VACUUM INTO）不是死路：
      # python3 在场就降级重试；提示升级 sqlite3，避免下次每次都走降级路径
      if command -v python3 >/dev/null 2>&1; then
        echo "警告：sqlite3 快照失败（若版本 < 3.27 不支持 VACUUM INTO，建议升级），降级 python3 分支重试" >&2
        rm -f "$SNAP"
        snapshot_with_python "$DB" "$SNAP" && snapshot_ok "$SNAP" || snap_failed=1
      else
        snap_failed=1
      fi
    fi
  elif command -v python3 >/dev/null 2>&1; then
    snapshot_with_python "$DB" "$SNAP" && snapshot_ok "$SNAP" || snap_failed=1
  else
    echo "错误：无 sqlite3/python3 可用，无法生成一致快照，中止备份" >&2
    exit 1
  fi
  if [[ "$snap_failed" == "1" ]]; then
    echo "错误：数据库快照生成/校验失败，中止备份（撕裂备份比没有备份更危险）" >&2
    exit 1
  fi
fi

# ---- 打包：实时库三件套排除，快照经 --transform 顶替 .pinglc/pinglc.db 之名 ----
# 可移植性说明：--transform 是 GNU tar 专属（macOS/Alpine 的 bsdtar 对应能力是
# -s 语法）；快照顶名依赖它，非 GNU tar 时明确报错而非静默产出错误布局的归档
# 版本探测用命令替换读全量输出再匹配：管道接 head/grep -q 会提前关管，tar 在
# pipefail 下收到 SIGPIPE（141）被误判为「非 GNU tar」，GNU 主机上反常中止
if [[ "$HAVE_DB" == "1" ]]; then
  tar_ver="$(tar --version 2>/dev/null || true)"
  if [[ "$tar_ver" != *"GNU tar"* ]]; then
    echo "错误：打包快照需要 GNU tar 的 --transform（当前 tar 非 GNU）；请安装 GNU tar 后重试" >&2
    exit 1
  fi
fi

# 默认排除模型目录（可重新下载）与迁移前快照目录（.pinglc/backups 最多 5 份整库
# 副本，入包会让每份归档体积放大数倍；它们是 premigrate 回退点，与备份归档目的
# 正交）；--full 只放开模型目录，快照目录任何模式都不入包
EXCLUDES=(--exclude '.pinglc/models' --exclude '.pinglc/backups')
if [[ "$FULL" == "--full" ]]; then
  EXCLUDES=(--exclude '.pinglc/backups')
fi

echo "备份 $SRC → $OUT ..."
if [[ "$HAVE_DB" == "1" ]]; then
  # 两个 -C 依次切换目录追加成员；transform 正则只锚定快照临时名，其余成员不受影响
  tar -czf "$TMP_OUT" -C "$HOME" \
    --exclude '.pinglc/pinglc.db' \
    --exclude '.pinglc/pinglc.db-wal' \
    --exclude '.pinglc/pinglc.db-shm' \
    "${EXCLUDES[@]}" .pinglc \
    --transform 's|^__snap__\.db$|.pinglc/pinglc.db|' \
    -C "$STAGE" __snap__.db
else
  tar -czf "$TMP_OUT" -C "$HOME" "${EXCLUDES[@]}" .pinglc
fi

# ---- 校验：全量解压读到底（结构坏/截断在此暴露），且快照成员确实在包内 ----
listing="$(tar -tzf "$TMP_OUT")"
if [[ "$HAVE_DB" == "1" ]] && ! grep -qx '\.pinglc/pinglc\.db' <<<"$listing"; then
  echo "错误：归档中缺少数据库快照成员，中止" >&2
  exit 1
fi

mv "$TMP_OUT" "$OUT"   # 校验通过才占用正式名（保留位里永远是完整备份）

# ---- 保留最近 KEEP 份，滚动清理 ----
# glob 限定精确时间戳格式（8位日期-6位时分秒，数字位宽）：字典序 == 时间序，
# 也不会把 pinglc-manual.tar.gz 之类非标准命名的外来文件算进来误删；
# 数组展开天然容忍路径含空格（解析 ls 输出 + xargs 会按空白切碎路径）
shopt -s nullglob
backups=("$DEST_DIR"/pinglc-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].tar.gz)
if (( ${#backups[@]} > KEEP )); then
  to_remove=("${backups[@]:0:${#backups[@]}-KEEP}")
  rm -- "${to_remove[@]}"
  echo "已清理 ${#to_remove[@]} 份旧备份"
fi
echo "完成：$OUT ($(du -h "$OUT" | cut -f1))"
echo "（仅保留最近 $KEEP 份备份）"
