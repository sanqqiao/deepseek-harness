#!/bin/bash
# deepseek-harness systemd 用户服务安装/管理脚本
# 将 dsh web 服务与 socat 桥接注册为 systemd 用户服务：
#   dsh-web.service     dsh --profile web（绑 127.0.0.1）
#   dsh-bridge.service  socat 桥接 BRIDGE_IP:3080 -> 127.0.0.1:3080（供反代访问）
# 开启 linger 后开机自启，无需登录会话。
#
# 用法：
#   ./dsh-systemd.sh install       安装并启动服务（迁移旧的 pid/nohup 进程）
#   ./dsh-systemd.sh uninstall     停止并移除服务
#   ./dsh-systemd.sh start|stop|restart|status   服务控制
#   ./dsh-systemd.sh logs [unit]   查看日志（默认 dsh-web，可选 dsh-bridge）
#   ./dsh-systemd.sh token         打印当前启动 token
# 可定制变量（install 前导出或直接改下方默认值）：
#   DSH_TRUSTED_HOSTS  dsh 信任的 authority，空格分隔（默认 dsh.simpleinfo.cn）
#   BRIDGE_IP          桥接绑定的本机 IP（默认 10.8.0.52；VPN 未起时 socat 会重试）
#   BRIDGE_PORT        桥接端口（默认 3080）
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -f $SCRIPT_DIR/dsh.mjs ]]; then
    APP_HOME=$SCRIPT_DIR
else
    APP_HOME=$HOME/deepseek-harness
fi
UNIT_DIR=$HOME/.config/systemd/user
NODE_BIN=$HOME/node24/bin/node
SOCAT_BIN=$(command -v socat || echo /usr/bin/socat)

TRUSTED_HOSTS=${DSH_TRUSTED_HOSTS:-dsh.simpleinfo.cn}
BRIDGE_IP=${BRIDGE_IP:-10.8.0.52}
BRIDGE_PORT=${BRIDGE_PORT:-3080}

log() { echo "[$(date '+%F %T')] $*"; }

trusted_args() {
    local args=()
    local h
    for h in $TRUSTED_HOSTS; do
        args+=(--trusted-host "$h")
    done
    printf '%s\n' "${args[@]}"
}

write_units() {
    mkdir -p "$UNIT_DIR"
    local trusted
    trusted=$(printf '%s ' "$(trusted_args | xargs echo)")
    cat > "$UNIT_DIR/dsh-web.service" <<EOF
[Unit]
Description=DeepSeek Harness web (dsh --profile web, loopback only)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_HOME
ExecStart=$NODE_BIN --import tsx/esm dsh.mjs --profile web $trusted
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    cat > "$UNIT_DIR/dsh-bridge.service" <<EOF
[Unit]
Description=dsh socat bridge ($BRIDGE_IP:$BRIDGE_PORT -> 127.0.0.1:$BRIDGE_PORT)
After=network.target dsh-web.service
Wants=dsh-web.service

[Service]
Type=simple
ExecStart=$SOCAT_BIN TCP-LISTEN:$BRIDGE_PORT,bind=$BRIDGE_IP,fork,reuseaddr TCP:127.0.0.1:$BRIDGE_PORT
# VPN 地址可能晚于服务启动出现，持续重试直到可绑定
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
}

stop_legacy() {
    # 停掉 dsh-server.sh 的 pid 文件进程与手工 nohup 的 socat
    local pid_file=$APP_HOME/dsh-server.pid
    if [[ -f $pid_file ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        log "停止旧 dsh 进程 PID=$(cat "$pid_file")"
        kill "$(cat "$pid_file")" 2>/dev/null || true
        sleep 1
    fi
    rm -f "$pid_file"
    pkill -f "socat TCP-LISTEN:$BRIDGE_PORT,bind=$BRIDGE_IP" 2>/dev/null || true
}

cmd_install() {
    [[ -x $NODE_BIN ]] || { echo "缺少 $NODE_BIN"; exit 1; }
    [[ -x $SOCAT_BIN ]] || { echo "缺少 socat（sudo apt install socat）"; exit 1; }
    stop_legacy
    write_units
    systemctl --user enable --now dsh-web.service dsh-bridge.service
    loginctl enable-linger 2>/dev/null && log "linger 已开启（开机自启）" \
        || log "警告: enable-linger 失败，服务仅在登录会话存活期可用"
    log "安装完成"
    cmd_status
}

cmd_uninstall() {
    systemctl --user disable --now dsh-web.service dsh-bridge.service 2>/dev/null || true
    rm -f "$UNIT_DIR/dsh-web.service" "$UNIT_DIR/dsh-bridge.service"
    systemctl --user daemon-reload
    log "已移除服务（linger 保持开启，如需关闭: loginctl disable-linger）"
}

ctl() {
    systemctl --user "$1" dsh-web.service dsh-bridge.service
}

cmd_status() {
    systemctl --user --no-pager status dsh-web.service dsh-bridge.service | sed -n '1,12p'
}

cmd_logs() {
    journalctl --user -u "${1:-dsh-web.service}" --no-pager -n 50
}

cmd_token() {
    journalctl --user -u dsh-web.service --no-pager -o cat | grep -o "token=[^ ]*" | tail -1
}

case ${1:-} in
    install)   cmd_install ;;
    uninstall) cmd_uninstall ;;
    start)     ctl start ;;
    stop)      ctl stop ;;
    restart)   ctl restart ;;
    status)    cmd_status ;;
    logs)      shift; cmd_logs "${1:-}" ;;
    token)     cmd_token ;;
    *) echo "用法: $0 {install|uninstall|start|stop|restart|status|logs [unit]|token}"; exit 1 ;;
esac
