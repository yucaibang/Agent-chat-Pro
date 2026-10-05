#!/bin/sh
# Agent Chat Pro device-control connect.sh（v3.17.0 IP 追踪钩子版，模板生成勿手改）
# == device-control metadata（机器可读，resolve-ip.sh 单一事实来源，勿动格式）==
# target_user={{TARGET_USER}}
# target_port={{TARGET_PORT}}
# target_ip={{TARGET_IP}}
# 结构：直通 → 连接失败钩子（网络类错误才触发）→ resolve-ip.sh 指纹重定位 → 新 IP 重试一次。
# stdout/stdin 全程直通（SSH 流/PTY 不受影响），stderr 经临时文件回放。正常连接零开销。
DIR='{{DEV_DIR}}'
RESOLVE='{{RESOLVE_PATH}}'
T_USER=$(sed -n 's/^# target_user=//p' "$0" | head -1)
T_PORT=$(sed -n 's/^# target_port=//p' "$0" | head -1)
T_IP=$(sed -n 's/^# target_ip=//p' "$0" | head -1)
if [ -z "$T_USER" ] || [ -z "$T_PORT" ] || [ -z "$T_IP" ]; then
  echo "connect.sh: 配置损坏——metadata 行缺失（target_user/target_port/target_ip）" >&2
  exit 127
fi
ERR_FILE="/tmp/acp-ssh-err.$$"
trap 'rm -f "$ERR_FILE"' EXIT

do_ssh() {
  tgt="$1"; shift
  ssh -p "$T_PORT" -i "$DIR/id_ed25519" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o PasswordAuthentication=no -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$DIR/known_hosts" "$T_USER@$tgt" "$@"
}

do_ssh "$T_IP" "$@" 2>"$ERR_FILE"
rc=$?
[ $rc -eq 0 ] && { cat "$ERR_FILE" >&2; exit 0; }

if grep -qE 'No route to host|Connection timed out|Connection refused|Network is unreachable|Connection reset by peer|HOST IDENTIFICATION' "$ERR_FILE"; then
  newip=$("$RESOLVE" "$DIR")
  resolve_rc=$?
  if [ $resolve_rc -eq 0 ] && [ -n "$newip" ]; then
    do_ssh "$newip" "$@"
    exit $?
  fi
  # resolve 失败原因已在 stderr 报出（exit 10=网段无匹配/exit 20=环境错误），不重试，透传原错误
fi

cat "$ERR_FILE" >&2
exit $rc