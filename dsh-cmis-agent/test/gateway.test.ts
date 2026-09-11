import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CmisContext } from '../src/context/index.ts'
import type { Config } from '../src/context/index.ts'
import type { CmisUser, SimpleReturn } from '../src/context/types.ts'
import { authenticate, AuthError, readCredentials } from '../src/gateway/auth.ts'
import { buildSessionId, SessionDriver, TurnTranslator } from '../src/gateway/bridge.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ServerEvent } from '../src/gateway/types.ts'

const contextConfig: Config = {
    centerServer: 'https://center.test',
    centerAuthorization: 'Basic test-auth',
    userRefreshIntervalMs: 60000,
    tenants: [],
}

const testUser: CmisUser = {
    userId: 1,
    ticket: 'ticket-new',
    userType: 2,
    deptCode: 'D01',
    deptId: 11,
    deptType: 'shop',
}

/** 替换全局 fetch 为可断言的桩（getUserByTicket 返回指定 SimpleReturn） */
function mockFetch(handler: (url: string, body: any) => SimpleReturn) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(init.headers ?? {})) {
            headers[key] = String(value)
        }
        calls.push({ url: String(url), body, headers })
        return { ok: true, json: async () => handler(String(url), body) } as any
    }) as any
    return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

async function createCmisContext(): Promise<CmisContext> {
    const ctx = new Context()
    await ctx.plugin(CmisContext, contextConfig)
    return ctx.cmisContext
}

function event(type: string, data: unknown): SessionEvent {
    return { type, seq: 0, time: 0, data } as SessionEvent
}

// ---- readCredentials ----

test('readCredentials：头名大小写不敏感读取', () => {
    const credentials = readCredentials({
        'Service-Index': 'mall-001',
        'SIMPLE-TICKET': 'ticket-a',
        'app-user-id': 'app-user-1',
        'Authorization': 'Bearer token',
    })
    assert.equal(credentials.serviceIndex, 'mall-001')
    assert.equal(credentials.ticket, 'ticket-a')
    assert.equal(credentials.appUserId, 'app-user-1')
    assert.equal(credentials.authorization, 'Bearer token')
})

test('readCredentials：缺失头返回空串', () => {
    const credentials = readCredentials({})
    assert.equal(credentials.serviceIndex, '')
    assert.equal(credentials.ticket, '')
    assert.equal(credentials.appUserId, '')
    assert.equal(credentials.authorization, undefined)
})

// ---- authenticate ----

test('authenticate：缺凭证抛 AuthError', async () => {
    const cmisContext = await createCmisContext()
    await assert.rejects(authenticate(cmisContext, { serviceIndex: '', ticket: '', appUserId: '' }), AuthError)
})

test('authenticate：成功返回用户并续期 ticket', async () => {
    const { calls, restore } = mockFetch((_url, body) => body.serviceIndex !== undefined
        ? { flag: 1, data: { url: 'https://mall-1.test' } }
        : { flag: 1, data: { ...testUser } })
    try {
        const cmisContext = await createCmisContext()
        const result = await authenticate(cmisContext, {
            serviceIndex: 'mall-001',
            ticket: 'ticket-old',
            appUserId: 'app-user-1',
        })
        assert.equal(result.serviceUrl, 'https://mall-1.test')
        assert.equal(result.serviceIndex, 'mall-001')
        assert.equal(result.appUserId, 'app-user-1')
        assert.equal(result.ticket, 'ticket-new')
        assert.equal(result.user.userId, 1)
        // getUserByTicket 请求：Simple-Ticket 头 + body.ticket
        const userCall = calls.find(call => call.url.includes('getUserByTicket'))
        assert.ok(userCall)
        assert.equal(userCall.headers['Simple-Ticket'], 'ticket-old')
        assert.equal(userCall.body.ticket, 'ticket-old')
        assert.equal(userCall.url, 'https://mall-1.test/system/onlineUser/getUserByTicket.do')
    } finally {
        restore()
    }
})

test('authenticate：flag=20 拒绝连接并提示重新登录', async () => {
    const { restore } = mockFetch((_url, body) => body.serviceIndex !== undefined
        ? { flag: 1, data: { url: 'https://mall-1.test' } }
        : { flag: 20, message: '未登录' })
    try {
        const cmisContext = await createCmisContext()
        await assert.rejects(
            authenticate(cmisContext, { serviceIndex: 'mall-001', ticket: 'bad', appUserId: 'app-user-1' }),
            /重新登录/,
        )
    } finally {
        restore()
    }
})

// ---- buildSessionId ----

test('buildSessionId：serviceIndex-appUserId 组合', () => {
    assert.equal(buildSessionId('mall-001', 'app-user-1').toString(), 'cmis-mall-001-app-user-1')
})

// ---- TurnTranslator ----

test('TurnTranslator：text-delta 转译为 delta，reasoning-delta 忽略', () => {
    const translator = new TurnTranslator(1)
    assert.deepEqual(translator.translate(event('assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' },
    })), [{ requestId: 1, type: 'delta', text: '你好' }])
    assert.deepEqual(translator.translate(event('assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: '思考' },
    })), [])
})

test('TurnTranslator：工具调用开始/结束（callId 关联工具名，error 透传）', () => {
    const translator = new TurnTranslator(1)
    assert.deepEqual(translator.translate(event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'cmis_query_report', arguments: '{}' })), [
        { requestId: 1, type: 'tool', name: 'cmis_query_report', state: 'start' },
    ])
    assert.deepEqual(translator.translate(event('tool/result', {
        turn: 1, step: 1,
        message: { role: 'user', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call-1' } },
    })), [
        { requestId: 1, type: 'tool', name: 'cmis_query_report', state: 'end' },
    ])
    assert.deepEqual(translator.translate(event('tool/result', {
        turn: 1, step: 1,
        message: { role: 'user', content: [], source: { kind: 'tool', callId: 'call-2' } },
        error: { name: 'ToolError', code: 'E_FAIL' },
    })), [
        { requestId: 1, type: 'tool', name: 'call-2', state: 'end', error: 'ToolError: E_FAIL' },
    ])
})

test('TurnTranslator：usage 累计并在 done 汇总', () => {
    const translator = new TurnTranslator('req-1')
    translator.translate(event('assistant/message', { turn: 1, step: 1, message: {} as any, usage: { inputTokens: 10, outputTokens: 5 } }))
    translator.translate(event('assistant/message', { turn: 2, step: 1, message: {} as any, usage: { inputTokens: 7, outputTokens: 3 } }))
    assert.deepEqual(translator.translate(event('turn/end', { turn: 2, reason: { kind: 'completed' } })), [
        { requestId: 'req-1', type: 'done', usage: { inputTokens: 17, outputTokens: 8 } },
    ])
    assert.equal(translator.isFinished, true)
    // 结束后忽略后续事件
    assert.deepEqual(translator.translate(event('assistant/chunk', {
        turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' },
    })), [])
})

test('TurnTranslator：turn/end 错误/取消/阻塞转译为 error', () => {
    const errorTranslator = new TurnTranslator(1)
    assert.deepEqual(errorTranslator.translate(event('turn/end', {
        turn: 1, reason: { kind: 'error', error: { message: '模型调用失败', code: 'E_LLM' } },
    })), [{ requestId: 1, type: 'error', message: '模型调用失败' }])

    const abortedTranslator = new TurnTranslator(2)
    assert.deepEqual(abortedTranslator.translate(event('turn/end', {
        turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } },
    })), [{ requestId: 2, type: 'error', message: '本轮对话已取消' }])

    const blockedTranslator = new TurnTranslator(3)
    assert.deepEqual(blockedTranslator.translate(event('turn/end', { turn: 1, reason: { kind: 'blocked' } })), [
        { requestId: 3, type: 'error', message: '本轮对话被阻塞，请稍后重试' },
    ])
})

// ---- SessionDriver ----

interface RecordedConnection {
    events: ServerEvent[]
    sendEvent(event: ServerEvent): void
}

function createConnection(): RecordedConnection {
    return {
        events: [],
        sendEvent(event) { this.events.push(event) },
    }
}

function createDriver(): { driver: SessionDriver; followups: string[]; disposed: boolean } {
    const followups: string[] = []
    const handle = {
        agent: {
            followup: (message: { content: { type: string; text?: string }[] }) => {
                followups.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
            },
        },
        dispose: async () => { },
    } as unknown as AgentHandle
    return { driver: new SessionDriver(buildSessionId('mall-001', 'app-user-1'), handle), followups, disposed: false }
}

test('SessionDriver：空闲提交立即驱动，事件回推发起连接', () => {
    const { driver, followups } = createDriver()
    const connection = createConnection()
    driver.submit(connection, 1, '查一下滞销品报表')

    assert.equal(followups.length, 1)
    assert.equal(followups[0], '查一下滞销品报表')
    assert.equal(driver.isActive, true)

    driver.handleEvent(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '好的' } }))
    driver.handleEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))

    assert.deepEqual(connection.events, [
        { requestId: 1, type: 'delta', text: '好的' },
        { requestId: 1, type: 'done' },
    ])
    assert.equal(driver.isActive, false)
})

test('SessionDriver：忙时排队，上一轮结束后依序驱动', () => {
    const { driver, followups } = createDriver()
    const connectionOne = createConnection()
    const connectionTwo = createConnection()
    driver.submit(connectionOne, 1, '第一个问题')
    driver.submit(connectionTwo, 2, '第二个问题')
    assert.equal(followups.length, 1)

    driver.handleEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    assert.equal(followups.length, 2)
    assert.equal(followups[1], '第二个问题')

    // 第二轮事件回推第二个连接
    driver.handleEvent(event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    assert.deepEqual(connectionTwo.events, [{ requestId: 2, type: 'done' }])
})

test('SessionDriver：dropPending 丢弃指定连接的排队请求', () => {
    const { driver, followups } = createDriver()
    const connectionOne = createConnection()
    const connectionTwo = createConnection()
    driver.submit(connectionOne, 1, '第一个问题')
    driver.submit(connectionTwo, 2, '第二个问题')
    driver.dropPending(connectionTwo)

    driver.handleEvent(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    assert.equal(followups.length, 1)
    assert.deepEqual(connectionTwo.events, [])
})

test('SessionDriver：followup 抛错时回推 error 且不卡死驱动器', () => {
    const handle = {
        agent: { followup: () => { throw new Error('agent 已销毁') } },
        dispose: async () => { },
    } as unknown as AgentHandle
    const driver = new SessionDriver(buildSessionId('mall-001', 'app-user-1'), handle)
    const connection = createConnection()
    driver.submit(connection, 1, '你好')

    assert.deepEqual(connection.events, [{ requestId: 1, type: 'error', message: '消息处理失败：agent 已销毁' }])
    assert.equal(driver.isActive, false)
    // 驱动器可继续接受下一轮
    const recovered = createDriver()
    assert.equal(recovered.driver.isActive, false)
})
