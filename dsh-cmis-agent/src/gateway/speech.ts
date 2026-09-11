/**
 * 讯飞实时语音转写（AST 大模型版）：gateway 语音识别实现。
 *
 * 自 cmis-report-agent 的 xf-realtime.ts 迁移，依赖替换为 Node 原生模块
 * （crypto-js → node:crypto，uuid → crypto.randomUUID）。
 * 建立到讯飞的 wss 连接后流式转发音频帧，识别结果经 onResult 上报
 * （中间结果 isEnd=false / 最终结果 isEnd=true），识别完成后的文本由
 * gateway 转入 agent 对话流程。
 */
import { createHmac, randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

const HOST = 'office-api-ast-dx.iflyaisol.com'
const PATH = '/ast/communicate/v1'

/** 讯飞凭证（来自 gateway 插件配置） */
export interface XfyunCredential {
    appId: string
    apiKey: string
    apiSecret: string
}

/** 语音属性（终端录音参数，随 speech start 消息上报） */
export interface SpeechProperties {
    numberOfChannels?: number
    sampleRate: number
    format?: string
    encodeBitRate?: number
    /** 声纹过滤（可选，featureId 对应讯飞声纹库特征） */
    featureId?: string
}

/** 识别器接口：音频帧流入，识别结果/错误回调流出 */
export interface SpeechRecognition {
    sendAudioData(audioData: Buffer): void
    end(): void
    cancel(): void
}

function formatUtcDate(): string {
    const now = new Date()
    const offset = -now.getTimezoneOffset()
    const sign = offset >= 0 ? '+' : '-'
    const absOffset = Math.abs(offset)
    const hours = String(Math.floor(absOffset / 60)).padStart(2, '0')
    const minutes = String(absOffset % 60).padStart(2, '0')
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const h = String(now.getHours()).padStart(2, '0')
    const m = String(now.getMinutes()).padStart(2, '0')
    const s = String(now.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day}T${h}:${m}:${s}${sign}${hours}:${minutes}`
}

/** 请求签名（HMAC-SHA1 + Base64，参数按 key 升序拼接） */
export function generateSignature(params: Record<string, string>, accessKeySecret: string): string {
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
        .join('&')
    return createHmac('sha1', accessKeySecret).update(queryString).digest('base64')
}

/** 录音格式 → 讯飞音频编码映射 */
export function mapAudioFormat(format: string | undefined): string {
    switch (format?.toLowerCase()) {
        case 'pcm':
        case 'wav':
            return 'pcm_s16le'
        case 'opus':
            return 'opus-wb'
        case 'speex':
            return 'speex-7'
        default:
            return 'pcm_s16le'
    }
}

interface RtResultItem {
    ws: Array<{
        cw: Array<{
            w: string
            wp?: string
            wb?: number
            we?: number
            rl?: number
        }>
    }>
}

interface RtResultData {
    seg_id?: number
    cn: {
        st: {
            type: string
            rt: RtResultItem[]
            bg?: number
            ed?: number
        }
    }
    ls?: boolean
    msg_type?: string
    res_type?: string
}

interface RtActionData {
    action?: 'started' | 'error' | 'end'
    code?: string
    sid?: string
    sessionId?: string
    message?: string
    desc?: string
}

interface RtMessage {
    msg_type: 'action' | 'result'
    data: RtActionData | RtResultData
}

export class XfyunRealtimeAsr implements SpeechRecognition {
    private websocket: WebSocket | null = null
    private onResult: (text: string, isEnd: boolean) => void
    private onError: (error: Error) => void
    private audioData: (Buffer | string)[] = []
    private isSending = false
    private sessionId = ''
    private speechProperties: SpeechProperties

    constructor(
        credential: XfyunCredential,
        speechProperties: SpeechProperties,
        onResult: (text: string, isEnd: boolean) => void,
        onError: (error: Error) => void,
    ) {
        this.speechProperties = speechProperties
        this.onResult = onResult
        this.onError = onError
        this.initWebSocket(credential)
    }

    private initWebSocket(credential: XfyunCredential): void {
        const params: Record<string, string> = {
            appId: credential.appId,
            accessKeyId: credential.apiKey,
            uuid: randomUUID(),
            utc: formatUtcDate(),
            lang: 'autodialect',
            audio_encode: mapAudioFormat(this.speechProperties.format),
            samplerate: String(this.speechProperties.sampleRate),
            eng_vad_mdn: '2',
        }

        if (this.speechProperties.featureId) {
            params.role_type = '2'
            params.feature_ids = this.speechProperties.featureId
            params.eng_spk_match = '1'
        }

        params.signature = generateSignature(params, credential.apiSecret)

        const queryString = Object.keys(params)
            .sort()
            .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
            .join('&')

        const url = `wss://${HOST}${PATH}?${queryString}`
        this.websocket = new WebSocket(url)

        this.websocket.on('open', () => {
            this.sendAudioChunk()
        })

        let fullText = ''
        let currentText = ''
        let targetRole: number | undefined
        const hasVoiceFilter = !!this.speechProperties.featureId

        this.websocket.on('message', (data) => {
            try {
                const message: RtMessage = JSON.parse(data.toString('utf8'))

                if (message.msg_type === 'action') {
                    const actionData = message.data as RtActionData
                    if (actionData.sid || actionData.sessionId) {
                        this.sessionId = actionData.sid || actionData.sessionId || ''
                    }
                    if (actionData.action === 'started') return
                    if (actionData.code !== undefined && actionData.code !== '0') {
                        const errMsg = actionData.message || actionData.desc || actionData.action || '识别错误'
                        this.onError(new Error(`讯飞实时转写错误（code=${actionData.code}）：${errMsg}`))
                    }
                    return
                }

                if (message.msg_type === 'result') {
                    const resultData = message.data as RtResultData
                    const st = resultData.cn?.st
                    if (!st) return

                    const allCw = st.rt.flatMap((item) => item.ws.flatMap((wsItem) => wsItem.cw))

                    const PAUSE_THRESHOLD_MS = 200
                    let words = ''
                    for (let i = 0; i < allCw.length; i++) {
                        const cw = allCw[i]

                        if (hasVoiceFilter) {
                            if (cw.rl != null) {
                                const rl = Number(cw.rl)
                                if (rl > 0 && targetRole === undefined) {
                                    targetRole = rl
                                }
                                if (targetRole !== undefined && rl !== 0 && rl !== targetRole) {
                                    continue
                                }
                            }
                        }

                        if (cw.wp === 'p') {
                            const prev = allCw.slice(0, i).reverse().find((c) => c.wp === 'n')
                            const next = allCw.slice(i + 1).find((c) => c.wp === 'n')
                            if (prev?.we != null && next?.wb != null) {
                                const gap = next.wb - prev.we
                                if (gap < PAUSE_THRESHOLD_MS) continue
                            }
                        }
                        words += cw.w
                    }

                    if (st.type === '0') {
                        fullText += words
                        currentText = ''
                    } else {
                        currentText = words
                    }

                    this.onResult(fullText + currentText, false)

                    if (resultData.ls) {
                        this.onResult(fullText + currentText, true)
                        setTimeout(() => {
                            this.websocket?.close()
                            this.websocket = null
                        }, 100)
                    }
                }
            } catch {
                this.onError(new Error('讯飞实时转写消息解析失败'))
            }
        })

        this.websocket.on('error', () => {
            this.onError(new Error('讯飞实时转写 WebSocket 连接错误'))
        })
    }

    private sendAudioChunk(): void {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return
        if (this.isSending) return
        this.isSending = true
        while (this.audioData.length > 0) {
            const audioChunk = this.audioData.shift()
            if (audioChunk) {
                if (typeof audioChunk === 'string' && audioChunk === 'end') {
                    this.websocket?.send(JSON.stringify({
                        end: true,
                        sessionId: this.sessionId,
                    }))
                    this.isSending = false
                    return
                } else if (Buffer.isBuffer(audioChunk)) {
                    this.websocket?.send(audioChunk)
                }
            }
        }
        this.isSending = false
    }

    sendAudioData(audioData: Buffer): void {
        this.audioData.push(audioData)
        this.sendAudioChunk()
    }

    end(): void {
        this.audioData.push('end')
        this.sendAudioChunk()
    }

    cancel(): void {
        this.audioData = []
        this.isSending = false
        if (this.websocket) {
            this.websocket.close()
            this.websocket = null
        }
    }
}
