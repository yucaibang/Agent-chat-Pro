#!/bin/bash
# resolve-ip.sh — Agent Chat Pro 联动控件 IP 追踪（方案一，NAS 侧，2026-10-05 落地）
# 原理：机器 IP 随 DHCP 会飘，但该机 sshd 主机键指纹（known_hosts 首连落下的权威指纹）永不改变。
# 用法: resolve-ip.sh <设备目录>     （目录内须含 connect.sh 与 known_hosts）
# 退出码:
#   0  = 可重试（stdout 输出重定位后的 IP；旧 IP 键指纹匹配确认无需重定位时输出旧 IP）
#   10 = 全网段无匹配（目标机已关机或离开原网络）
#   20 = 用法/环境错误（目录不存在、解析失败、known_hosts 无权威指纹、锁冲突等）
# 安全语义: 「去哪找」可以变，「凭什么进门」永不变 —— 用户公钥/authorized_keys 链路一字不改；
#           known_hosts 更新必须先指纹比对后落笔（禁止盲写）。
# 说明: 人话与日志一律走 stderr；stdout 成功路径只输出一个 IP，供 connect.sh 钩子重试。

set -u

DEV_DIR="${1:-}"

die20() { echo "resolve-ip: $*" >&2; exit 20; }
die10() { echo "resolve-ip: $*" >&2; exit 10; }

[ -n "$DEV_DIR" ] || die20 "用法: resolve-ip.sh <设备目录>"
[ -d "$DEV_DIR" ] || die20 "设备目录不存在: $DEV_DIR"
CONNECT_SH="$DEV_DIR/connect.sh"
KNOWN_HOSTS="$DEV_DIR/known_hosts"
TRACK_LOG="$DEV_DIR/ip-track.log"
[ -f "$CONNECT_SH" ] || die20 "connect.sh 不存在: $CONNECT_SH"
[ -f "$KNOWN_HOSTS" ] || die20 "known_hosts 不存在: $KNOWN_HOSTS"

# ── 并发互斥：同设备/跨设备同时只跑一个追踪实例 ──
BASE_DIR=$(dirname "$DEV_DIR")
exec 9>>"$BASE_DIR/.resolve-ip.lock"
flock -n 9 || die20 "另一个 IP 追踪实例正在执行，跳过"

# ── 1. 解析 connect.sh：提取 user@IP、端口 ──
# 优先机器可读 metadata 注释行（v3.17.0 钩子版单一事实来源）；旧 exec 'user@IP' 格式 fallback 兼容
CUR_HOST=$(sed -n 's/^# target_ip=//p' "$CONNECT_SH" | head -1)
if [ -n "$CUR_HOST" ]; then
  CUR_USER=$(sed -n 's/^# target_user=//p' "$CONNECT_SH" | head -1)
  CUR_PORT=$(sed -n 's/^# target_port=//p' "$CONNECT_SH" | head -1)
  [ -n "$CUR_PORT" ] || CUR_PORT=22
else
  TARGET_LINE=$(grep -oE "'[A-Za-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'" "$CONNECT_SH" | head -1 | tr -d "'")
  CUR_USER=${TARGET_LINE%@*}
  CUR_HOST=${TARGET_LINE#*@}
  CUR_PORT=$(grep -oE '\-p [0-9]+' "$CONNECT_SH" | head -1 | awk '{print $2}')
  [ -n "$CUR_PORT" ] || CUR_PORT=22
fi
[ -n "$CUR_USER" ] && [ -n "$CUR_HOST" ] || die20 "无法从 connect.sh 解析目标 user/IP（metadata 与旧格式均未命中）"
echo "resolve-ip: 设备 $(basename "$DEV_DIR") 当前目标 ${CUR_USER}@${CUR_HOST}:${CUR_PORT}" >&2

# ── 2. 权威指纹集合（known_hosts 即权威，hashed 格式 ssh-keygen -lf 直接可读）──
AUTH_FP=$(ssh-keygen -lf "$KNOWN_HOSTS" 2>/dev/null | awk '{print $2}' | sort -u)
[ -n "$AUTH_FP" ] || die20 "known_hosts 内无可识别主机键指纹，无法比对（历史遗留：需先人工成功连接一次让 ssh 落下首条目）"

# ── 取键工具：对一台机器做 keyscan 并输出 SHA256 指纹列表 ──
probe_fps() {
  local t
  t=$(mktemp) || return 1
  ssh-keyscan -t ed25519,ecdsa,rsa -T 3 -p "$CUR_PORT" "$1" 2>/dev/null >"$t"
  if [ -s "$t" ]; then
    ssh-keygen -lf "$t" 2>/dev/null | awk '{print $2}'
  fi
  rm -f "$t"
}
fp_in_set() { printf '%s\n' "$AUTH_FP" | grep -qxF "$1"; }

# ── 3. 快速预检：旧 IP 上的机器指纹即权威 → 无需重定位（连接失败属瞬时/认证原因）──
for fp in $(probe_fps "$CUR_HOST"); do
  if fp_in_set "$fp"; then
    echo "resolve-ip: 旧 IP $CUR_HOST 主机键指纹匹配（无需重定位，原失败属瞬时故障/其他原因）" >&2
    echo "$CUR_HOST"
    exit 0
  fi
done

# ── 4. 网段扫描：/24 并发 32 路 nc 探 22 端口（跳过旧 IP 与本机 IP）──
NET_PREFIX=$(echo "$CUR_HOST" | cut -d. -f1-3)
LOCAL_IP=$(ip -4 -o addr show 2>/dev/null | awk -v p="$NET_PREFIX." '$4 ~ p {print $4}' | head -1 | cut -d/ -f1)
SCAN_DIR=$(mktemp -d) || die20 "临时目录创建失败"
trap 'rm -rf "$SCAN_DIR"' EXIT

i=0
for last in $(seq 1 254); do
  ip="${NET_PREFIX}.${last}"
  [ "$ip" = "$CUR_HOST" ] && continue
  [ -n "$LOCAL_IP" ] && [ "$ip" = "$LOCAL_IP" ] && continue
  ( nc -z -w 2 "$ip" "$CUR_PORT" 2>/dev/null && echo "$ip" ) >"$SCAN_DIR/$last" &
  i=$((i+1))
  [ $((i % 32)) -eq 0 ] && wait
done
wait
OPEN_IPS=$(cat "$SCAN_DIR"/* 2>/dev/null | sort -t. -k4 -n)
echo "resolve-ip: 网段 ${NET_PREFIX}.0/24 扫描完成，开放 $CUR_PORT 端口: $(echo $OPEN_IPS | tr '\n' ' ')" >&2

# ── 5. 指纹取证：开放机器逐一 keyscan 比对权威指纹 ──
HIT_IP="" ; HIT_FP="" ; HIT_KEYS=""
for ip in $OPEN_IPS; do
  [ -n "$ip" ] || continue
  t=$(mktemp) || continue
  ssh-keyscan -t ed25519,ecdsa,rsa -T 3 -p "$CUR_PORT" "$ip" 2>/dev/null >"$t"
  if [ -s "$t" ]; then
    while read -r fp; do
      if fp_in_set "$fp"; then
        HIT_IP="$ip"; HIT_FP="$fp"; HIT_KEYS="$t"
        break 2
      fi
    done < <(ssh-keygen -lf "$t" 2>/dev/null | awk '{print $2}')
  fi
  rm -f "$t"
done

if [ -z "$HIT_IP" ]; then
  die10 "该网段内没有指纹匹配的机器——目标机已关机或离开原网络（已扫 ${NET_PREFIX}.0/24 全部 22 端口并逐一比对主机键指纹）"
fi

# ── 6. 命中重定位：connect.sh 换 IP（幂等）+ known_hosts 追加（先比对后落笔，防重复）──
if grep -q '^# target_ip=' "$CONNECT_SH"; then
  sed -i "s|^# target_ip=.*|# target_ip=$HIT_IP|" "$CONNECT_SH" || die20 "connect.sh 更新失败（metadata 行）"
else
  sed -i "s|@${CUR_HOST}|@${HIT_IP}|g" "$CONNECT_SH" || die20 "connect.sh 更新失败（旧格式 @IP）"
fi
chmod 700 "$CONNECT_SH" 2>/dev/null || true
touch "$KNOWN_HOSTS" && chmod 600 "$KNOWN_HOSTS"
while read -r h t k; do
  [ -n "${h:-}" ] && [ -n "${k:-}" ] || continue
  grep -qxF "$HIT_IP $t $k" "$KNOWN_HOSTS" || printf '%s %s %s\n' "$HIT_IP" "$t" "$k" >>"$KNOWN_HOSTS"
done <"$HIT_KEYS"
rm -f "$HIT_KEYS"

# ── 7. 追踪日志（JSON 行）+ device.json targetAddress 同步（尽力而为，不阻断）──
{
  printf '{"time":"%s","deviceId":"%s","from":"%s","to":"%s","fingerprint":"%s","detectedBy":"port-scan"}\n' \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" "$(basename "$DEV_DIR")" "$CUR_HOST" "$HIT_IP" "$HIT_FP"
} >>"$TRACK_LOG"
if command -v node >/dev/null 2>&1 && [ -f "$DEV_DIR/device.json" ]; then
  node -e '
    const fs = require("fs");
    const f = process.argv[1], ip = process.argv[2];
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      j.targetAddress = ip;
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    } catch (e) { /* device.json 同步失败不阻断 */ }
  ' "$DEV_DIR/device.json" "$HIT_IP" 2>/dev/null || true
fi

NEW_IP="$HIT_IP"
echo "resolve-ip: ✅ 重定位成功 ${CUR_USER}@${CUR_HOST} → ${CUR_USER}@${NEW_IP}（指纹 ${HIT_FP}），已更新 connect.sh / known_hosts / ip-track.log" >&2
echo "$NEW_IP"
exit 0