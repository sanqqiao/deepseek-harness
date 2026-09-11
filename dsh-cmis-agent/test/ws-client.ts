/**
 * gateway 端到端测试客户端（"hello"级对话验证）。
 *
 * 用法（在 DSH 仓库根目录，DSH web 已通过 --patch 加载 cmis-gateway 时）：
 *   node --experimental-transform-types --no-warnings \
 *     dsh-cmis-agent/test/ws-client.ts --ticket <ticket> [--service-index mall] [--app-user-id tester] "你好"
 *
 * 连接 ws://127.0.0.1:3001/agent，携带鉴权头，发送一条消息并打印全部推送事件。
 */
import { WebSocket } from 'ws'

const argumentsList = process.argv.slice(2)
const options: Record<string, string> = {}
const prompts: string[] = []
for (let index = 0; index < argumentsList.length; index++) {
    const item = argumentsList[index]
    if (item.startsWith('--')) {
        const next = argumentsList[index + 1]
        if (next !== undefined && !next.startsWith('--')) {
            options[item.slice(2)] = next
            index += 1
        }
    } else {
        prompts.push(item)
    }
}

const serviceIndex = options['service-index'] || 'mall'
const ticket = options['ticket'] || ''
const appUserId = options['app-user-id'] || 'tester'
const port = options['port'] || '3001'
const text = prompts[0] || '你好'

if (!ticket) {
    console.error('缺少 --ticket <登录凭证>（从 mall 主系统获取 simple-ticket）')
    process.exit(1)
}

const url = `ws://127.0.0.1:${port}/agent`
console.log(`连接 ${url}（serviceIndex=${serviceIndex}, appUserId=${appUserId}）`)
const ws = new WebSocket(url, {
    headers: {
        'service-index': serviceIndex,
        'simple-ticket': ticket,
        'app-user-id': appUserId,
    },
})

let requestId = 0
const timer = setTimeout(() => {
    console.error('超时：60 秒内未完成一轮对话')
    process.exit(1)
}, 60000)

ws.on('open', () => {
    console.log('已连接，等待欢迎消息...')
})
ws.on('message', (message) => {
    const event = JSON.parse(String(message))
    switch (event.type) {
        case 'welcome':
            console.log(`[welcome] ${event.text.replace(/\n/g, ' ')}`)
            requestId += 1
            console.log(`发送请求 #${requestId}：${text}`)
            ws.send(JSON.stringify({ requestId, text }))
            break
        case 'heartbeat':
            break
        case 'delta':
            process.stdout.write(event.text)
            break
        case 'tool':
            console.log(`\n[tool] ${event.name} ${event.state}${event.error ? `（${event.error}）` : ''}`)
            break
        case 'done':
            console.log(`\n[done] usage=${JSON.stringify(event.usage ?? {})}`)
            clearTimeout(timer)
            ws.close()
            process.exit(0)
            break
        case 'error':
            console.error(`\n[error] ${event.message}`)
            clearTimeout(timer)
            ws.close()
            process.exit(1)
            break
        default:
            console.log(`\n[${event.type}] ${JSON.stringify(event)}`)
    }
})
ws.on('close', () => {
    console.log('连接已关闭')
    process.exit(0)
})
ws.on('error', (error) => {
    console.error(`连接错误：${error.message}`)
    process.exit(1)
})
