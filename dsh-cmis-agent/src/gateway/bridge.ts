import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RequestId, ReportResultData, ServerEvent, UsageSummary } from './types.ts'

/** 运行期日志：直接写 stdout，确保在 dsh-server.log 中可见（ctx.logger 在网关运行期不落盘） */
const log = (message: string): void => {
    process.stdout.write(`[cmis-gateway] ${new Date().toISOString()} ${message}\n`)
}

/** 会话键：DSH 会话按 serviceIndex-businessType-appUserId 复用（断线重连上下文不丢，业务间互相隔离） */
export function buildSessionId(serviceIndex: string, businessType: string, appUserId: string): SessionId {
    return SessionId(`cmis-${serviceIndex}-${businessType}-${appUserId}`)
}

/**
 * 一轮对话的事件转译器：喂入 DSH session 事件，产出协议推送事件。
 * 一次 turn 生命周期内使用，turn/end 时结束（reason 决定 done/error）。
 */
export class TurnTranslator {
    private readonly usage: UsageSummary = { inputTokens: 0, outputTokens: 0 }
    private readonly toolNames = new Map<string, string>()
    private finished = false

    constructor(private readonly requestId: RequestId) {}

    get isFinished(): boolean {
        return this.finished
    }

    /** 处理一条会话事件，返回要推送的协议事件（0~1 条） */
    translate(event: SessionEvent): ServerEvent[] {
        if (this.finished) return []
        switch (event.type) {
            case 'assistant/chunk': {
                const chunk = event.data.chunk
                if (chunk.type === 'text-delta' && chunk.text) {
                    return [{ requestId: this.requestId, type: 'delta', text: chunk.text }]
                }
                return []
            }
            case 'assistant/message': {
                const usage = event.data.usage
                if (usage) {
                    this.usage.inputTokens += usage.inputTokens
                    this.usage.outputTokens += usage.outputTokens
                }
                return []
            }
            case 'tool/call': {
                this.toolNames.set(event.data.callId, event.data.name)
                return [{ requestId: this.requestId, type: 'tool', name: event.data.name, state: 'start' }]
            }
            case 'tool/result': {
                const callId = event.data.message.source.callId
                const name = this.toolNames.get(callId) ?? callId
                const error = event.data.error ? `${event.data.error.name}: ${event.data.error.code}` : undefined
                // 工具 presentationMeta 投影的结构化结果（如 query_report 的报表数据）回传前端渲染
                const resultData = event.data.meta as ReportResultData | undefined
                return [{
                    requestId: this.requestId,
                    type: 'tool',
                    name,
                    state: 'end',
                    ...(error ? { error } : {}),
                    ...(resultData !== undefined ? { resultData } : {}),
                }]
            }
            case 'turn/end': {
                this.finished = true
                const reason = event.data.reason
                if (reason.kind === 'error') {
                    return [{ requestId: this.requestId, type: 'error', message: reason.error.message }]
                }
                if (reason.kind === 'aborted') {
                    return [{ requestId: this.requestId, type: 'error', message: '本轮对话已取消' }]
                }
                if (reason.kind === 'blocked') {
                    return [{ requestId: this.requestId, type: 'error', message: '本轮对话被阻塞，请稍后重试' }]
                }
                const usage = this.usage.inputTokens > 0 || this.usage.outputTokens > 0 ? { ...this.usage } : undefined
                return [{ requestId: this.requestId, type: 'done', ...(usage ? { usage } : {}) }]
            }
            default:
                return []
        }
    }
}

/** 已提交、等待对应轮次开始的请求（与 agent next-turn inbox 顺序一一对应） */
interface QueuedRequest {
    connection: TurnConnection
    requestId: RequestId
}

/** 驱动一轮对话所需的最小连接接口（便于测试替身） */
export interface TurnConnection {
    sendEvent(event: ServerEvent): void
}

/**
 * 会话驱动器：一个 DSH 会话（serviceIndex-appUserId）对应一个实例。
 * 排队交由 agent 的 next-turn inbox（followup 语义）：每条消息直接 followup，
 * agent 在当前轮结束后按序自动开始下一轮；本类只负责按 turn/start 顺序把
 * 轮次事件映射回发起请求的连接。
 */
export class SessionDriver {
    private activeTurn: { connection: TurnConnection; translator: TurnTranslator } | undefined
    private readonly queuedRequests: QueuedRequest[] = []

    constructor(
        public readonly sessionId: SessionId,
        private readonly handle: AgentHandle,
    ) {}

    get isActive(): boolean {
        return this.activeTurn !== undefined || this.queuedRequests.length > 0
    }

    /** 终端提交一轮对话：直接交给 agent 排队（当前轮结束后自动开始），并记录对应请求 */
    submit(connection: TurnConnection, requestId: RequestId, text: string): void {
        this.queuedRequests.push({ connection, requestId })
        try {
            this.handle.agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            }))
        } catch (error) {
            this.queuedRequests.pop()
            log(`消息提交失败：${this.sessionId} ${error instanceof Error ? error.message : String(error)}`)
            connection.sendEvent({ requestId, type: 'error', message: `消息处理失败：${error instanceof Error ? error.message : String(error)}` })
        }
    }

    /** 会话事件入口（由 gateway 全局 session/event 订阅路由进来） */
    handleEvent(event: SessionEvent): void {
        // 每个 turn/start 按序消费一个排队请求；无对应请求的轮次（agent 自发）没有接收方
        if (event.type === 'turn/start') {
            const next = this.queuedRequests.shift()
            if (next === undefined) log(`忽略无对应请求的轮次：${this.sessionId} turn=${event.data.turn}`)
            this.activeTurn = next === undefined
                ? undefined
                : { connection: next.connection, translator: new TurnTranslator(next.requestId) }
        }
        const activeTurn = this.activeTurn
        if (!activeTurn) return
        for (const serverEvent of activeTurn.translator.translate(event)) {
            activeTurn.connection.sendEvent(serverEvent)
        }
        if (activeTurn.translator.isFinished) this.activeTurn = undefined
    }

    /** 丢弃尚未开始的排队请求（连接断开时调用；已 followup 的消息由 agent 自行消费） */
    dropPending(connection: TurnConnection): void {
        for (let index = this.queuedRequests.length - 1; index >= 0; index--) {
            if (this.queuedRequests[index].connection === connection) {
                this.queuedRequests.splice(index, 1)
            }
        }
    }

    /** 停止驱动并销毁 agent（会话保留期到期时调用） */
    async dispose(): Promise<void> {
        this.activeTurn = undefined
        this.queuedRequests.length = 0
        await this.handle.dispose()
    }
}
