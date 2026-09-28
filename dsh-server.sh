#!/bin/bash
# deepseek-harness 服务器部署/运行脚本（192.168.2.230）
# 前置：node24 位于 ~/node24（含 include/ 头文件，用于构建 native addon）
# 用法：
#   ./dsh-server.sh build          一键构建：安装依赖 + 打包全部插件（lib/ 产物 + native addon）
#   ./dsh-server.sh start          后台启动 web 服务（产物缺失时自动先 build）
#   ./dsh-server.sh stop           停止
#   ./dsh-server.sh restart        重启
#   ./dsh-server.sh status         运行状态
#   ./dsh-server.sh logs [N]       最近 N 行日志（默认 50）
#   ./dsh-server.sh ask "任务"     前台一次性执行任务（headless 单次问答）
# 环境变量：
#   DSH_PROFILE  启动的 profile（默认 web；headless 用于单次问答，不适合常驻）
#   DEEPSEEK_API_KEY  LLM 凭证（也可用 credentials 服务持久化）
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -z ${DSH_APP_HOME:-} ]]; then
    if [[ -f $SCRIPT_DIR/dsh.mjs ]]; then
        APP_HOME=$SCRIPT_DIR
    else
        APP_HOME=$HOME/deepseek-harness
    fi
else
    APP_HOME=$DSH_APP_HOME
fi
PROFILE=${DSH_PROFILE:-web}
export PATH="$HOME/node24/bin:$PATH"
PID_FILE=$APP_HOME/dsh-server.pid
LOG_FILE=$APP_HOME/dsh-server.log

log() { echo "[$(date '+%F %T')] $*"; }

is_running() {
    [[ -f $PID_FILE ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cmd_build() {
    cd "$APP_HOME"
    log "安装依赖..."
    pnpm install --frozen-lockfile
    log "编译 host 类型 + 打包插件（host 面）..."
    node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json
    ./node_modules/.bin/tsdown --env.DSH_BUILD_FACE host
    log "编译 client 类型 + 打包插件（client 面）..."
    ./node_modules/typescript/bin/tsc -b tsconfig.client.json
    ./node_modules/.bin/tsdown --env.DSH_BUILD_FACE client
    log "构建 native addon..."
    pnpm run build:native-system
    log "构建 web 前端..."
    pnpm run build:web
    log "构建完成"
}

cmd_start() {
    if is_running; then
        log "已在运行 (PID $(cat "$PID_FILE"))"
        return 0
    fi
    cd "$APP_HOME"
    # 插件产物或 native addon 缺失时自动构建
    if [[ ! -f packages/bundle/headless/lib/index.js || ! -f native/system/packages/linux-x64/bin/glibc/system.node || ! -f apps/web/dist/index.html ]]; then
        cmd_build
    fi
    log "后台启动 profile=$PROFILE"
    nohup "$HOME/node24/bin/node" --import tsx/esm dsh.mjs --profile "$PROFILE" \
        >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
        log "启动成功 PID=$pid 日志=$LOG_FILE"
    else
        log "启动失败，最近日志："
        tail -n 20 "$LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
}

cmd_stop() {
    if ! is_running; then
        log "未在运行"
        rm -f "$PID_FILE"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE")
    log "停止 PID=$pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    log "已停止"
}

cmd_status() {
    if is_running; then
        log "运行中 PID=$(cat "$PID_FILE")"
        ps -o pid,etime,rss,args -p "$(cat "$PID_FILE")" | tail -1 | cut -c1-160
    else
        log "未运行"
        exit 1
    fi
}

cmd_logs() {
    local n=${1:-50}
    tail -n "$n" "$LOG_FILE"
}

cmd_ask() {
    cd "$APP_HOME"
    exec "$HOME/node24/bin/node" --import tsx/esm dsh.mjs --profile "$PROFILE" "$@"
}

case ${1:-} in
    build)   cmd_build ;;
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status)  cmd_status ;;
    logs)    cmd_logs "${2:-50}" ;;
    ask)     shift; cmd_ask "$@" ;;
    *) echo "用法: $0 {build|start|stop|restart|status|logs [N]|ask \"task\"}"; exit 1 ;;
esac
