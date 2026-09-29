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
#   DSH_HOST     监听地址（默认 127.0.0.1 仅本机；0.0.0.0 被服务端安全策略禁止）
#   DSH_TRUSTED_HOSTS  额外信任的 authority（空格分隔 host 或 host:port），供反代/局域网访问 /api
#   DSH_PATCH          额外的 --patch overlay（如 ./dsh-cmis-agent/cordis.yml 加载 cmis 插件）
#   DEEPSEEK_API_KEY   LLM 凭证（也可用 credentials 服务持久化）
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
# node 探测：优先 ~/node24（服务器），其次 nvm 当前版本（本机），最后系统 PATH（需 >=22）
if [[ -x $HOME/node24/bin/node ]]; then
    NODE_BIN=$HOME/node24/bin/node
elif [[ -n ${NVM_BIN:-} && -x $NVM_BIN/node ]]; then
    NODE_BIN=$NVM_BIN/node
elif [[ -x $HOME/node22/bin/node ]]; then
    NODE_BIN=$HOME/node22/bin/node
elif command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
else
    echo "错误: 未找到 node（需 >=22）"; exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
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
    # DSH_PATCH 指定的 overlay 存在才附加
    local patch_args=()
    if [[ -n ${DSH_PATCH:-} ]]; then
        for p in $DSH_PATCH; do
            [[ -f $APP_HOME/$p || -f $p ]] || { log "错误: patch 不存在: $p"; exit 1; }
            patch_args+=(--patch "$p")
        done
    fi
    log "后台启动 profile=$PROFILE host=${DSH_HOST:-127.0.0.1} patch=${DSH_PATCH:-none}"
    # 注意参数顺序：--patch 是 launcher 层 flag，必须放在 app 层 flag（--host/--trusted-host）之前，
    # launcher 使用 passThroughOptions，遇到 app 层 flag 后不再解析后续 launcher flag
    nohup "$NODE_BIN" --import tsx/esm dsh.mjs --profile "$PROFILE" \
        "${patch_args[@]}" \
        ${DSH_HOST:+--host "$DSH_HOST"} \
        ${DSH_TRUSTED_HOSTS:+$(printf -- '--trusted-host %s ' $DSH_TRUSTED_HOSTS)} \
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
    exec "$NODE_BIN" --import tsx/esm dsh.mjs --profile "$PROFILE" "$@"
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
