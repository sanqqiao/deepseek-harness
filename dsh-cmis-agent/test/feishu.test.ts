import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CmisContext } from '../src/context/index.ts'
import type { Config } from '../src/context/index.ts'
import type { CmisUser, SimpleReturn } from '../src/context/types.ts'
import { FeishuClient } from '../src/feishu/client.ts'
import type { TenantFeishuConfig } from '../src/context/types.ts'
import { createFeishuSendMessageTool } from '../src/feishu/send-message.ts'

const TENANT_A_FEISHU: TenantFeishuConfig = {
    appId: 'app-a',
    appSecret: 'secret-a',
    defaultChatId: 'chat-default-a',
}
const TENANT_B_FEISHU: TenantFeishuConfig = {
    appId: 'app-b',
    appSecret: 'secret-b',
    defaultChatId: 'chat-default-b',
}

const contextConfig: Config = {
    centerServer: 'https://center.test',
    centerAuthorization: 'Basic test-auth',
    userRefreshIntervalMs: 60000,
    tenants: [
        { serviceIndex: 'mall-001', feishu: TENANT_A_FEISHU },
        { serviceIndex: 'mall-002', feishu: TENANT_B_FEISHU },
        { serviceIndex: 'mall-003' },
    ],
}

const testUser: CmisUser = {
    userId: 1,
    ticket: 'ticket-a',
    userType: 2,
    deptCode: 'D01',
    deptId: 11,
    deptType: 'shop',
}

const SESSION_ID = 'cmis-mall-001-user-1'

function buildExec(sessionId: string = SESSION_ID): ToolRunContext {
    return {
        callId: 'call-1' as never,
        rootCallId: 'call-1' as never,
        name: 'feishu_send_message',
        arguments: {},
        agent: { id: SessionId(sessionId) },
        signal: new AbortController().signal,
    } as unknown as ToolRunContext
}

/** 按请求路径分发响应的 fetch 桩（记录调用供断言） */
function mockFetch(handler: (url: string, body: any) => any) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(init.headers ?? {})) {
            headers[key] = String(value)
        }
        calls.push({ url: String(url), body, headers })
        return {
            ok: true,
            headers: { get: () => null },
            json: async () => handler(String(url), body),
        } as any
    }) as any
    return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

async function createCmisContext(): Promise<CmisContext> {
    const ctx = new Context()
    await ctx.plugin(CmisContext, contextConfig)
    ctx.cmisContext.bind(SESSION_ID, {
        serviceIndex: 'mall-001',
        serviceUrl: 'https://mall.test',
        appUserId: 'user-1',
        ticket: 'ticket-a',
        user: testUser,
    })
    return ctx.cmisContext
}

/** token 接口响应 */
function tokenResponse(token: string): SimpleReturn {
    return { flag: 1, code: 0, tenant_access_token: token, expire: 7200 } as never
}

// ---- FeishuClient：token 缓存与租户隔离 ----

test('getTenantAccessToken：缓存命中只请求一次，过期后刷新', async () => {
    const client = new FeishuClient()
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse('token-a-1')
        }
        return { code: 0 }
    })
    try {
        const first = await client.getTenantAccessToken('mall-001', TENANT_A_FEISHU)
        const second = await client.getTenantAccessToken('mall-001', TENANT_A_FEISHU)
        assert.equal(first, 'token-a-1')
        assert.equal(second, 'token-a-1')
        assert.equal(fetchStub.calls.length, 1)

        // 模拟过期：手工将缓存 expireAt 置为过去
        const cache = (client as never as { tokenCache: Map<string, { expireAt: number }> }).tokenCache
        cache.get('mall-001')!.expireAt = Date.now() - 1000
        const third = await client.getTenantAccessToken('mall-001', TENANT_A_FEISHU)
        assert.equal(third, 'token-a-1')
        assert.equal(fetchStub.calls.length, 2)
    } finally {
        fetchStub.restore()
    }
})

test('getTenantAccessToken：多租户 token 缓存互不串扰', async () => {
    const client = new FeishuClient()
    const fetchStub = mockFetch((url, body) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse(body.app_id === 'app-a' ? 'token-a' : 'token-b')
        }
        return { code: 0 }
    })
    try {
        assert.equal(await client.getTenantAccessToken('mall-001', TENANT_A_FEISHU), 'token-a')
        assert.equal(await client.getTenantAccessToken('mall-002', TENANT_B_FEISHU), 'token-b')
        // 再次读取仍命中各自缓存（两次 token 请求分别对应各自 appId）
        assert.equal(await client.getTenantAccessToken('mall-001', TENANT_A_FEISHU), 'token-a')
        assert.equal(await client.getTenantAccessToken('mall-002', TENANT_B_FEISHU), 'token-b')
        const tokenCalls = fetchStub.calls.filter((call) => call.url.includes('tenant_access_token'))
        assert.deepEqual(tokenCalls.map((call) => call.body.app_id), ['app-a', 'app-b'])
    } finally {
        fetchStub.restore()
    }
})

test('getTenantAccessToken：接口报错抛出异常', async () => {
    const client = new FeishuClient()
    const fetchStub = mockFetch(() => ({ code: 99991663, msg: 'app secret invalid' }))
    try {
        await assert.rejects(
            () => client.getTenantAccessToken('mall-001', TENANT_A_FEISHU),
            /app secret invalid/,
        )
    } finally {
        fetchStub.restore()
    }
})

// ---- FeishuClient：sendMessage ----

test('sendMessage：text 消息体与 token 鉴权头', async () => {
    const client = new FeishuClient()
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse('token-a')
        }
        if (url.includes('/open-apis/im/v1/messages')) {
            return { code: 0, data: { message_id: 'msg-1' } }
        }
        return { code: 0 }
    })
    try {
        const result = await client.sendMessage('mall-001', TENANT_A_FEISHU, 'chat-1', 'text', '滞销品预警')
        assert.equal(result.messageId, 'msg-1')

        const sendCall = fetchStub.calls.find((call) => call.url.includes('/open-apis/im/v1/messages'))!
        assert.equal(sendCall.headers.Authorization, 'Bearer token-a')
        assert.equal(sendCall.url.includes('receive_id_type=chat_id'), true)
        assert.equal(sendCall.body.msg_type, 'text')
        assert.equal(JSON.parse(sendCall.body.content).text, '滞销品预警')
        assert.equal(sendCall.body.receive_id, 'chat-1')
    } finally {
        fetchStub.restore()
    }
})

test('sendMessage：markdown 走 interactive 卡片', async () => {
    const client = new FeishuClient()
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse('token-a')
        }
        if (url.includes('/open-apis/im/v1/messages')) {
            return { code: 0, data: { message_id: 'msg-2' } }
        }
        return { code: 0 }
    })
    try {
        await client.sendMessage('mall-001', TENANT_A_FEISHU, 'chat-1', 'markdown', '| 商品 | 库存 |')
        const sendCall = fetchStub.calls.find((call) => call.url.includes('/open-apis/im/v1/messages'))!
        assert.equal(sendCall.body.msg_type, 'interactive')
        const content = JSON.parse(sendCall.body.content)
        assert.equal(content.elements[0].tag, 'markdown')
        assert.equal(content.elements[0].content, '| 商品 | 库存 |')
    } finally {
        fetchStub.restore()
    }
})

// ---- feishu_send_message 工具 ----

test('feishu_send_message：未绑定会话返回错误', async () => {
    const cmisContext = await createCmisContext()
    const tool = createFeishuSendMessageTool(cmisContext, new FeishuClient())
    const result = await tool.execute(
        { content: 'hello' },
        buildExec('unbound-session'),
    ) as Record<string, unknown>
    assert.equal(result.success, false)
})

test('feishu_send_message：租户未配置飞书凭证返回错误', async () => {
    const ctx = new Context()
    await ctx.plugin(CmisContext, contextConfig)
    ctx.cmisContext.bind('cmis-mall-003-user-1', {
        serviceIndex: 'mall-003',
        serviceUrl: 'https://mall3.test',
        appUserId: 'user-1',
        ticket: 'ticket-c',
        user: testUser,
    })
    const tool = createFeishuSendMessageTool(ctx.cmisContext, new FeishuClient())
    const result = await tool.execute(
        { content: 'hello' },
        buildExec('cmis-mall-003-user-1'),
    ) as Record<string, unknown>
    assert.equal(result.success, false)
    assert.match(String(result.error), /未配置飞书应用/)
})

test('feishu_send_message：缺省 chatId 用租户默认群', async () => {
    const cmisContext = await createCmisContext()
    const tool = createFeishuSendMessageTool(cmisContext, new FeishuClient())
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse('token-a')
        }
        if (url.includes('/open-apis/im/v1/messages')) {
            return { code: 0, data: { message_id: 'msg-3' } }
        }
        return { code: 0 }
    })
    try {
        const result = await tool.execute(
            { content: '滞销品预警', msgType: 'markdown' },
            buildExec(),
        ) as Record<string, unknown>
        assert.equal(result.success, true)
        assert.equal(result.chatId, 'chat-default-a')
        assert.equal(result.msgType, 'markdown')
        assert.equal(result.messageId, 'msg-3')
    } finally {
        fetchStub.restore()
    }
})

test('feishu_send_message：发送失败返回错误（不虚构成功）', async () => {
    const cmisContext = await createCmisContext()
    const tool = createFeishuSendMessageTool(cmisContext, new FeishuClient())
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse('token-a')
        }
        if (url.includes('/open-apis/im/v1/messages')) {
            return { code: 230002, msg: 'not in chat' }
        }
        return { code: 0 }
    })
    try {
        const result = await tool.execute(
            { content: 'hello', chatId: 'chat-x' },
            buildExec(),
        ) as Record<string, unknown>
        assert.equal(result.success, false)
        assert.match(String(result.error), /not in chat/)
    } finally {
        fetchStub.restore()
    }
})

test('feishu_send_message：多租户隔离（各租户 token 与目标群）', async () => {
    const ctx = new Context()
    await ctx.plugin(CmisContext, contextConfig)
    ctx.cmisContext.bind('cmis-mall-001-user-1', {
        serviceIndex: 'mall-001',
        serviceUrl: 'https://mall.test',
        appUserId: 'user-1',
        ticket: 'ticket-a',
        user: testUser,
    })
    ctx.cmisContext.bind('cmis-mall-002-user-1', {
        serviceIndex: 'mall-002',
        serviceUrl: 'https://mall2.test',
        appUserId: 'user-1',
        ticket: 'ticket-b',
        user: testUser,
    })

    const client = new FeishuClient()
    const tool = createFeishuSendMessageTool(ctx.cmisContext, client)
    const fetchStub = mockFetch((url, body) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
            return tokenResponse(body.app_id === 'app-a' ? 'token-a' : 'token-b')
        }
        if (url.includes('/open-apis/im/v1/messages')) {
            return { code: 0, data: { message_id: 'msg-ok' } }
        }
        return { code: 0 }
    })
    try {
        const resultA = await tool.execute(
            { content: '租户A的报表' },
            buildExec('cmis-mall-001-user-1'),
        ) as Record<string, unknown>
        const resultB = await tool.execute(
            { content: '租户B的报表' },
            buildExec('cmis-mall-002-user-1'),
        ) as Record<string, unknown>
        assert.equal(resultA.success, true)
        assert.equal(resultA.chatId, 'chat-default-a')
        assert.equal(resultB.success, true)
        assert.equal(resultB.chatId, 'chat-default-b')

        // 两次发送分别使用各自租户的 token 与默认群
        const sendCalls = fetchStub.calls.filter((call) => call.url.includes('/open-apis/im/v1/messages'))
        assert.deepEqual(sendCalls.map((call) => call.headers.Authorization), ['Bearer token-a', 'Bearer token-b'])
        assert.deepEqual(sendCalls.map((call) => call.body.receive_id), ['chat-default-a', 'chat-default-b'])
    } finally {
        fetchStub.restore()
    }
})
