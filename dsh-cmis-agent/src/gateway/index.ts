import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import z from '@deepseek-ai/schemastery'
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { authenticate, AuthError, readCredentials } from './auth.ts'
import type { AuthResult } from './auth.ts'
import { buildSessionId, SessionDriver } from './bridge.ts'
import type { TurnConnection } from './bridge.ts'
import { XfyunRealtimeAsr } from './speech.ts'
import type { SpeechRecognition, XfyunCredential } from './speech.ts'
import type { ClientRequest, ClientSpeechControl, RequestId, ServerEvent } from './types.ts'
import { DEFAULT_BUSINESS_TYPE } from './types.ts'
import type { CmisContext } from '../context/index.ts'

export const name = 'cmis-gateway'
export const inject = ['cmisContext', 'agents', 'agentDefaultModel', 'sessionPersistence']

export const defaultWelcomeText = `欢迎使用信步AI报表助手！我是您的智能报表查询助手。

您可以通过文字告诉我想看的报表，例如"查一下上周的滞销品报表"。
也可以让我列出可用的报表清单。`

export interface Config {
    /** gateway WS 监听端口 */
    port: number
    /** WS 路径（终端连接地址 ws://host:port<path>） */
    path: string
    /** 欢迎文案 */
    welcomeText: string
    /** 心跳推送间隔（毫秒，0 关闭） */
    heartbeatIntervalMs: number
    /** 断开后会话保留时长（毫秒，超时且无重连则销毁 agent；0 表示不销毁） */
    sessionRetentionMs: number
    /** 讯飞实时转写凭证（不配置则语音输入不可用） */
    speech?: XfyunCredential
}

export const Config: z<Config> = z.object({
    port: z.natural().default(3000).description('gateway WS 监听端口'),
    path: z.string().default('/agent').description('WS 路径'),
    welcomeText: z.string().role('textarea').default(defaultWelcomeText).description('欢迎文案'),
    heartbeatIntervalMs: z.natural().default(30000).description('心跳推送间隔（毫秒，0 关闭）'),
    sessionRetentionMs: z.natural().default(600000).description('断开后会话保留时长（毫秒，超时无重连销毁 agent，0 不销毁）'),
    speech: z.object({
        appId: z.string().required().description('讯飞应用 App ID'),
        apiKey: z.string().required().description('讯飞 Access Key ID'),
        apiSecret: z.string().required().description('讯飞 Access Key Secret'),
    }).description('讯飞实时转写凭证（不配置则语音输入不可用）'),
})

/** 终端连接：鉴权通过后的会话级状态 */
class GatewayConnection implements TurnConnection {
    /** 活跃语音识别器（连接级，一次一个录音会话） */
    speechRecognizer?: SpeechRecognition
    /** 当前语音会话（识别完成后按此提交对话） */
    activeSpeech?: { requestId: RequestId; deptCode?: string; driver: SessionDriver }
    /** 连接级当前业务（消息未携带 businessType 时沿用；消息携带时随消息更新） */
    businessType: string
    /** 本连接使用过的全部业务（断开时逐一释放对应会话） */
    readonly usedBusinessTypes = new Set<string>()

    constructor(
        readonly ws: WebSocket,
        readonly auth: AuthResult,
        private readonly sendMessage: (ws: WebSocket, event: ServerEvent) => void,
    ) {
        this.businessType = auth.businessType
        this.usedBusinessTypes.add(auth.businessType)
    }

    sendEvent(event: ServerEvent): void {
        this.sendMessage(this.ws, event)
    }
}

export function apply(ctx: Context, config: Config) {
    const cmisContext: CmisContext = ctx.cmisContext
    /** sessionId → 会话驱动器 */
    const drivers = new Map<string, SessionDriver>()
    /** WebSocket → 终端连接 */
    const connections = new Map<WebSocket, GatewayConnection>()
    /** sessionId → 保留期销毁定时器 */
    const retentionTimers = new Map<string, ReturnType<typeof setTimeout>>()
    /** sessionId → 进行中的会话创建/销毁 Promise（并发连接与保留期销毁串行化，避免同 id 重复 create/resume 冲突） */
    const sessionTransitions = new Map<string, Promise<unknown>>()

    const sendMessage = (ws: WebSocket, event: ServerEvent): void => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify(event))
    }

    // 会话事件路由：仅处理 gateway 管理的会话且处于活动轮次时
    ctx.on('session/event', (session, event) => {
        drivers.get(session.id)?.handleEvent(event)
    })

    const getOrCreateDriver = async (serviceIndex: string, businessType: string, appUserId: string): Promise<SessionDriver> => {
        const key = buildSessionId(serviceIndex, businessType, appUserId).toString()
        for (;;) {
            const existing = drivers.get(key)
            if (existing) {
                // 重连复用：取消保留期销毁
                const timer = retentionTimers.get(key)
                if (timer) {
                    clearTimeout(timer)
                    retentionTimers.delete(key)
                }
                return existing
            }
            // 同会话的创建/销毁正在进行：等它结束再重查（避免并发 create/resume 撞 id）
            const transition = sessionTransitions.get(key)
            if (transition) {
                await transition
                continue
            }
            const creating = createDriver(key, serviceIndex, businessType, appUserId)
            sessionTransitions.set(key, creating)
            try {
                return await creating
            } finally {
                if (sessionTransitions.get(key) === creating) sessionTransitions.delete(key)
            }
        }
    }

    /** 内存无此会话：磁盘已有同 id 则 resume 恢复历史（进程重启后重连），否则新建 */
    const createDriver = async (key: string, serviceIndex: string, businessType: string, appUserId: string): Promise<SessionDriver> => {
        const sessionId = buildSessionId(serviceIndex, businessType, appUserId)
        const persistence = ctx.get('sessionPersistence')
        const persisted = persistence !== undefined && (await persistence.list()).some((item: { header: { id: string } }) => item.header.id === sessionId)
        if (persisted) {
            const resumed = await ctx.agents.resume({
                resumeSessionId: sessionId,
                agentOptions: ctx.agentDefaultModel.currentSelection(),
            })
            const driver = new SessionDriver(sessionId, resumed)
            drivers.set(key, driver)
            return driver
        }
        const handle = await ctx.agents.create({
            sessionId,
            meta: { cwd: process.cwd() },
            agentOptions: ctx.agentDefaultModel.currentSelection(),
        })
        const driver = new SessionDriver(sessionId, handle)
        drivers.set(key, driver)
        return driver
    }

    const scheduleDisposal = (sessionId: string): void => {
        if (config.sessionRetentionMs <= 0) return
        const existing = retentionTimers.get(sessionId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
            retentionTimers.delete(sessionId)
            const driver = drivers.get(sessionId)
            if (!driver) return
            if (driver.isActive) {
                // 仍有活动轮次（异常残留），顺延一个保留期再试
                scheduleDisposal(sessionId)
                return
            }
            drivers.delete(sessionId)
            // 销毁过程登记为会话迁移：销毁期间的重连等待完成后按磁盘历史 resume，避免与未释放完的旧会话撞 id
            const disposing = driver.dispose().catch((error) => {
                ctx.logger.warn(`[cmis-gateway] 销毁会话 "${sessionId}" 失败：${error instanceof Error ? error.message : String(error)}`)
            })
            sessionTransitions.set(sessionId, disposing)
            void disposing.finally(() => {
                if (sessionTransitions.get(sessionId) === disposing) sessionTransitions.delete(sessionId)
            })
        }, config.sessionRetentionMs)
        retentionTimers.set(sessionId, timer)
    }

    /** 提交一轮文本对话（businessType 切换 → deptCode 切换 → 心跳续期 → 失效检查 → 驱动 agent） */
    const submitTextTurn = async (
        connection: GatewayConnection,
        driver: SessionDriver,
        requestId: RequestId,
        text: string,
        deptCode?: string,
    ): Promise<void> => {
        const sessionId = driver.sessionId.toString()
        if (deptCode) {
            try {
                await cmisContext.switchShop(sessionId, deptCode)
            } catch (error) {
                connection.sendEvent({ requestId, type: 'error', message: error instanceof Error ? error.message : String(error) })
                return
            }
        }
        // 续期用户心跳（消息到达视为活跃）
        cmisContext.touchUser(connection.auth.serviceIndex, connection.auth.appUserId, cmisContext.get(sessionId)?.user.userName)
        // 空闲超过刷新间隔：先续期用户信息（携带 Authorization，ticket 过期时下游静默重登换新票）
        if (cmisContext.needsRefresh(sessionId)) {
            try {
                await cmisContext.refreshUser(sessionId)
            } catch (error) {
                // flag=20 时 refreshUser 已标记 invalid，走下方统一拦截
                ctx.logger.warn(`[cmis-gateway] 会话 "${sessionId}" 用户信息刷新失败：${error instanceof Error ? error.message : String(error)}`)
            }
        }
        // ticket 过期标记：提示终端重新鉴权
        const sessionContext = cmisContext.get(sessionId)
        if (sessionContext?.invalid) {
            connection.sendEvent({ requestId, type: 'error', code: 'unauthorized', message: '登录信息已过期，请重新登录后再试' })
            return
        }
        driver.submit(connection, requestId, text)
    }

    /** 语音识别控制：start 建识别器、end 结束识别、cancel 取消 */
    const handleSpeechControl = (connection: GatewayConnection, control: ClientSpeechControl): void => {
        const { requestId, stream, speechProperties, deptCode, businessType } = control
        if (stream === 'start') {
            // 上一次录音未正常收尾：先取消，避免识别器泄漏
            connection.speechRecognizer?.cancel()
            connection.speechRecognizer = undefined
            connection.activeSpeech = undefined

            if (!config.speech) {
                connection.sendEvent({ requestId, type: 'error', message: '语音识别服务未配置，请联系管理员' })
                return
            }
            if (!speechProperties?.sampleRate) {
                connection.sendEvent({ requestId, type: 'error', message: '语音开始消息缺少录音参数（speechProperties.sampleRate）' })
                return
            }

            // 业务在 start 时确定（缺省沿用连接当前业务），识别完成文本提交到该业务会话
            const speechConfig = config.speech
            void resolveDriver(connection, businessType ?? connection.businessType).then((driver) => {
                connection.activeSpeech = { requestId, deptCode, driver }
                try {
                    connection.speechRecognizer = new XfyunRealtimeAsr(
                        speechConfig,
                        speechProperties,
                        (text, isEnd) => {
                            // 识别器已被取消/清理（cancel 后的迟到回调），丢弃
                            if (connection.activeSpeech?.requestId !== requestId) return
                            if (!isEnd) {
                                connection.sendEvent({ requestId, type: 'stt', text, isEnd: false })
                                return
                            }
                            // 最终结果：清理识别器并转入对话流程
                            connection.speechRecognizer = undefined
                            connection.activeSpeech = undefined
                            if (!text.trim()) {
                                connection.sendEvent({ requestId, type: 'error', message: '语音识别未识别到有效内容，请重试' })
                                return
                            }
                            connection.sendEvent({ requestId, type: 'stt', text, isEnd: true })
                            void submitTextTurn(connection, driver, requestId, text, deptCode)
                        },
                        (error) => {
                            if (connection.activeSpeech?.requestId !== requestId) return
                            connection.speechRecognizer = undefined
                            connection.activeSpeech = undefined
                            connection.sendEvent({ requestId, type: 'error', message: `语音识别服务错误：${error.message}` })
                        },
                    )
                } catch (error) {
                    connection.speechRecognizer = undefined
                    connection.activeSpeech = undefined
                    connection.sendEvent({ requestId, type: 'error', message: `语音识别初始化失败：${error instanceof Error ? error.message : String(error)}` })
                }
            })
            return
        }
        if (stream === 'end') {
            connection.speechRecognizer?.end()
            return
        }
        if (stream === 'cancel') {
            connection.speechRecognizer?.cancel()
            connection.speechRecognizer = undefined
            connection.activeSpeech = undefined
        }
    }

    /** 绑定/刷新业务会话的 cmis-context 上下文（连接建立与跨业务创建会话时调用，幂等） */
    const bindSessionContext = (connection: GatewayConnection, sessionId: string): void => {
        const { serviceIndex, serviceUrl, appUserId, ticket, authorization, user } = connection.auth
        const existing = cmisContext.get(sessionId)
        cmisContext.bind(sessionId, {
            serviceIndex,
            serviceUrl,
            appUserId,
            ticket,
            authorization,
            user,
            lastShopCode: existing?.lastShopCode,
            lastShopId: existing?.lastShopId,
        })
    }

    /** 按业务解析目标会话驱动器（业务变化时更新连接当前业务并切换，旧业务会话无其他连接使用则进入保留期） */
    const resolveDriver = async (connection: GatewayConnection, businessType?: string): Promise<SessionDriver> => {
        const target = businessType?.trim() || connection.businessType || DEFAULT_BUSINESS_TYPE
        const previous = connection.businessType
        connection.usedBusinessTypes.add(target)
        if (target !== previous) connection.businessType = target
        const driver = await getOrCreateDriver(connection.auth.serviceIndex, target, connection.auth.appUserId)
        // 跨业务动态创建的会话同样需要绑定上下文（bind 幂等，ticket 取连接最新值）
        bindSessionContext(connection, driver.sessionId.toString())
        // 切换业务：旧业务会话无同会话其他连接时进入保留期，超时无使用则销毁
        if (target !== previous) {
            releaseDriver(previous, connection)
        }
        return driver
    }

    /** 收集连接涉及的全部业务（本连接使用过的业务集合，断开时逐一释放对应会话与排队请求） */
    const collectConnectionBusinessTypes = (connection: GatewayConnection): string[] => {
        return [...connection.usedBusinessTypes]
    }

    /** 释放连接对某业务会话的占用（断开或业务切换时调用；无同会话其他连接时进入保留期） */
    const releaseDriver = (businessType: string, connection: GatewayConnection): void => {
        const sessionId = buildSessionId(connection.auth.serviceIndex, businessType, connection.auth.appUserId).toString()
        const inUse = [...connections.values()].some((item) =>
            item !== connection
            && item.auth.serviceIndex === connection.auth.serviceIndex
            && item.auth.appUserId === connection.auth.appUserId
            && item.businessType === businessType,
        )
        if (!inUse) scheduleDisposal(sessionId)
    }

    const handleMessage = async (connection: GatewayConnection, raw: unknown, isBinary: boolean): Promise<void> => {
        // 二进制音频帧 → 当前活跃识别器（start 与 end 之间到达）
        if (isBinary) {
            if (connection.speechRecognizer) {
                connection.speechRecognizer.sendAudioData(Buffer.from(raw as ArrayBuffer))
            }
            return
        }
        let request: ClientRequest | ClientSpeechControl
        try {
            request = JSON.parse(String(raw)) as ClientRequest | ClientSpeechControl
        } catch {
            connection.sendEvent({ type: 'error', message: '消息格式错误，需要 JSON：{ requestId, text, deptCode?, businessType? } 或 { type: "speech", requestId, stream, ... }' })
            return
        }
        // 语音识别控制消息（业务在 start 时解析，end/cancel 只操作识别器）
        if ((request as ClientSpeechControl).type === 'speech') {
            const control = request as ClientSpeechControl
            if (!control.requestId || !['start', 'end', 'cancel'].includes(control.stream)) {
                connection.sendEvent({ requestId: control.requestId, type: 'error', message: '语音消息格式错误：requestId 与 stream（start/end/cancel）为必填' })
                return
            }
            handleSpeechControl(connection, control)
            return
        }
        // 文本对话请求
        const textRequest = request as ClientRequest
        if (typeof textRequest?.requestId === 'undefined' || textRequest.requestId === null || typeof textRequest.text !== 'string' || !textRequest.text.trim()) {
            connection.sendEvent({ requestId: textRequest?.requestId, type: 'error', message: '消息格式错误：requestId 与 text 为必填' })
            return
        }
        try {
            const driver = await resolveDriver(connection, textRequest.businessType)
            await submitTextTurn(connection, driver, textRequest.requestId, textRequest.text, textRequest.deptCode)
        } catch (error) {
            connection.sendEvent({ requestId: textRequest.requestId, type: 'error', message: `会话创建失败，请重试：${error instanceof Error ? error.message : String(error)}` })
        }
    }

    const server = http.createServer((request, response) => {
        if (request.url === '/agent/health') {
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ status: 'ok', online: connections.size, timestamp: new Date().toISOString() }))
            return
        }
        response.writeHead(404)
        response.end()
    })
    const wss = new WebSocketServer({ server, path: config.path })

    wss.on('connection', (ws, request) => {
        void (async () => {
            try {
                const credentials = readCredentials(request.headers)
                const authResult = await authenticate(cmisContext, credentials)
                const driver = await getOrCreateDriver(authResult.serviceIndex, authResult.businessType, authResult.appUserId)

                const connection = new GatewayConnection(ws, authResult, sendMessage)
                connections.set(ws, connection)

                // 绑定/刷新初始业务会话的 cmis-context 上下文，并登记在线用户
                bindSessionContext(connection, driver.sessionId.toString())
                cmisContext.touchUser(authResult.serviceIndex, authResult.appUserId, authResult.user.userName)

                // 心跳推送（小程序环境无法访问协议层 pong 帧，走应用层心跳）
                let heartbeatTimer: ReturnType<typeof setInterval> | undefined
                if (config.heartbeatIntervalMs > 0) {
                    heartbeatTimer = setInterval(() => sendMessage(ws, { type: 'heartbeat' }), config.heartbeatIntervalMs)
                }

                ws.on('message', (message, isBinary) => {
                    void handleMessage(connection, message, isBinary).catch((error) => {
                        connection.sendEvent({ type: 'error', message: `消息处理失败，请重试：${error instanceof Error ? error.message : String(error)}` })
                    })
                })
                ws.on('close', () => {
                    if (heartbeatTimer) clearInterval(heartbeatTimer)
                    connections.delete(ws)
                    // 断开时终止进行中的语音识别
                    connection.speechRecognizer?.cancel()
                    connection.speechRecognizer = undefined
                    connection.activeSpeech = undefined
                    // 各业务会话逐一释放：丢弃排队请求，无同会话的其他连接时进入保留期，超时无重连则销毁 agent
                    for (const businessType of collectConnectionBusinessTypes(connection)) {
                        const sessionId = buildSessionId(connection.auth.serviceIndex, businessType, connection.auth.appUserId).toString()
                        drivers.get(sessionId)?.dropPending(connection)
                        releaseDriver(businessType, connection)
                    }
                    cmisContext.removeUser(connection.auth.serviceIndex, connection.auth.appUserId)
                })
                ws.on('error', () => ws.close())

                sendMessage(ws, { type: 'welcome', text: config.welcomeText })
            } catch (error) {
                const message = error instanceof AuthError
                    ? error.message
                    : `连接过程中发生错误，请重试：${error instanceof Error ? error.message : String(error)}`
                ctx.logger.warn(`[cmis-gateway] 连接处理失败：${message}`)
                sendMessage(ws, { type: 'error', code: error instanceof AuthError ? 'unauthorized' : undefined, message })
                ws.close()
            }
        })()
    })

    server.listen(config.port, () => {
        ctx.logger.info(`[cmis-gateway] WebSocket 服务已启动：ws://127.0.0.1:${config.port}${config.path}`)
    })

    ctx.effect(() => () => {
        for (const timer of retentionTimers.values()) clearTimeout(timer)
        retentionTimers.clear()
        wss.close()
        server.close()
    })
}
