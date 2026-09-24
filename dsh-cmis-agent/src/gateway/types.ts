/** 请求/响应关联标识（终端生成，原样回传） */
export type RequestId = number | string

/** 终端 → 服务端消息：一轮对话请求 */
export interface ClientRequest {
    requestId: RequestId
    text: string
    /** 门店切换（可选，沿用旧语义：切换后会话级门店上下文更新） */
    deptCode?: string
}

/** 终端 → 服务端消息：语音识别控制（二进制音频帧裸发于 start/end 之间） */
export interface ClientSpeechControl {
    type: 'speech'
    requestId: RequestId
    stream: 'start' | 'end' | 'cancel'
    /** 录音参数（start 时必传：采样率/格式，转写服务按此配置） */
    speechProperties?: {
        sampleRate: number
        format?: string
        numberOfChannels?: number
        encodeBitRate?: number
        featureId?: string
    }
    /** 门店切换（可选，识别完成文本转入对话流程时使用） */
    deptCode?: string
}

/** 一轮对话的 token 用量摘要 */
export interface UsageSummary {
    inputTokens: number
    outputTokens: number
}

/** 报表列定义（中文名与数值格式，前端表头/格式化用） */
export interface ReportColumnMeta {
    field: string
    label: string
    format?: 'money' | 'qty' | 'days' | 'ratio' | 'text'
}

/** 报表工具结构化结果（query_report 的 presentationMeta 投影，前端渲染完整表格用） */
export interface ReportResultData {
    reportCode: string
    reportName: string
    params: Record<string, unknown>
    columns?: ReportColumnMeta[]
    rows: unknown[]
    summary?: Record<string, unknown> | null
    page?: unknown
    dataSource: 'cache' | 'realtime'
    cacheUpdatedAt?: string
}

/** 服务端 → 终端推送事件（与 DSH SessionEvent 一一对应，bridge 转译层最薄） */
export type ServerEvent =
    | { type: 'welcome'; text: string }
    | { type: 'heartbeat' }
    | { requestId: RequestId; type: 'delta'; text: string }
    | { requestId: RequestId; type: 'tool'; name: string; state: 'start' | 'end'; error?: string; resultData?: ReportResultData }
    | { requestId: RequestId; type: 'done'; usage?: UsageSummary }
    | { requestId: RequestId; type: 'stt'; text: string; isEnd: boolean }
    | { requestId?: RequestId; type: 'error'; message: string; code?: 'unauthorized' }

/** 连接鉴权头（沿用旧协议头名，前端改动小） */
export const HEADER_NAMES = {
    serviceIndex: 'service-index',
    ticket: 'simple-ticket',
    appUserId: 'app-user-id',
    authorization: 'authorization',
} as const
