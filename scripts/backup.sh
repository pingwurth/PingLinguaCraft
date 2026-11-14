#!/usr/bin/env bash
# backup.sh —— 备份 ~/.pinglc（数据库 + 配置 + 媒体 + 模型缓存可选）
#
# 单用户自托管的学习数据（材料、字幕、生词、笔记、进度）都在 ~/.pinglc/，
# 定期备份到指定目录，防患于未然。媒体与模型体积大，默认排除模型目录。
#
# 数据库一致性（关键设计）：pinglc.db 运行在 WAL 模式，web 进程长期持有连接
# 并持续写 -wal——直接 tar 主库三件套（.db/-wal/-shm）必然撕裂：三个文件是
# 在不同瞬间读到的，恢复时可能 malformed。因此实时库三件套绝不入包，改用
# SQLite 在线备份 API 生成自洽单文件快照（写入方无感知、页级复制自带一致性，
# 不依赖 checkpoint 是否成功），quick_check 校验通过后才以 .pinglc/pinglc.db
# 之名打入归档。无 sqlite3/python3 可用时宁可中止也不产出「看似可恢复实则
# 撕裂」的备份。
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

# ---- 生成自洽数据库快照（在线备份 API；成功后 quick_check 复核）----
DB="$SRC/pinglc.db"
HAVE_DB=0
if [[ -f "$DB" ]]; then
  HAVE_DB=1
  SNAP="$STAGE/__snap__.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    # .timeout 5000：CLI 默认 busy_timeout=0，库被瞬时锁住会立刻失败中止备份；
    # 对齐 python 分支 connect 的默认 5s 重试窗，两个分支行为一致
    if ! sqlite3 "$DB" ".timeout 5000
.backup '$SNAP'" \
       || [[ "$(sqlite3 "$SNAP" 'PRAGMA quick_check;' 2>/dev/null)" != "ok" ]]; then
      echo "错误：数据库快照生成/校验失败，中止备份（撕裂备份比没有备份更危险）" >&2
      exit 1
    fi
  elif command -v python3 >/dev/null 2>&1; then
    # 路径经 argv 传入，不拼接进 Python 源码（路径含引号/反斜杠时既不会语法错误也没有注入面）
    if ! python3 - "$DB" "$SNAP" <<'PYEOF'
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
    then
      echo "错误：数据库快照生成/校验失败，中止备份（撕裂备份比没有备份更危险）" >&2
      exit 1
    fi
  else
    echo "错误：无 sqlite3/python3 可用，无法生成一致快照，中止备份" >&2
    exit 1
  fi
fi

# ---- 打包：实时库三件套排除，快照经 --transform 顶替 .pinglc/pinglc.db 之名 ----
# 默认排除模型目录（可重新下载）；--full 全量
EXCLUDES=(--exclude '.pinglc/models')
if [[ "$FULL" == "--full" ]]; then
  EXCLUDES=()
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
