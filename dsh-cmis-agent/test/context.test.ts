import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CmisContext } from '../src/context/index.ts'
import type { Config } from '../src/context/index.ts'
import type { CmisUser, SessionContext, SimpleReturn } from '../src/context/types.ts'

const testConfig: Config = {
    centerServer: 'https://center.test',
    centerAuthorization: 'Basic test-auth',
    userRefreshIntervalMs: 60000,
    tenants: [
        {
            serviceIndex: 'mall-001',
            feishu: { appId: 'cli-a', appSecret: 'secret-a', defaultChatId: 'oc-a' },
        },
        { serviceIndex: 'mall-002' },
    ],
}

const testUser: CmisUser = {
    userId: 1,
    ticket: 'ticket-old',
    userType: 2,
    deptCode: 'D01',
    deptId: 11,
    deptType: 'shop',
}

const testSessionContext: SessionContext = {
    serviceIndex: 'mall-001',
    serviceUrl: 'https://mall-1.test',
    appUserId: 'app-user-1',
    ticket: 'ticket-old',
    user: testUser,
}

/** 替换全局 fetch 为可断言的桩，返回调用记录与还原函数 */
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

async function createService(config: Config = testConfig): Promise<{ ctx: Context; service: CmisContext }> {
    const ctx = new Context()
    await ctx.plugin(CmisContext, config)
    return { ctx, service: ctx.cmisContext }
}

test('会话上下文 bind/get/unbind 与失效标记', async () => {
    const { service } = await createService()
    service.bind('session-1', { ...testSessionContext, user: { ...testUser } })

    const context = service.get('session-1')
    assert.ok(context)
    assert.equal(context.serviceIndex, 'mall-001')
    assert.equal(context.serviceUrl, 'https://mall-1.test')

    service.invalidate('session-1')
    assert.equal(service.get('session-1')?.invalid, true)

    assert.equal(service.unbind('session-1'), true)
    assert.equal(service.get('session-1'), undefined)
    assert.equal(service.unbind('session-1'), false)
})

test('session/disposed 事件自动清理会话绑定', async () => {
    const { ctx, service } = await createService()
    service.bind('session-1', { ...testSessionContext, user: { ...testUser } })
    service.bind('session-2', { ...testSessionContext, user: { ...testUser } })

    ctx.emit('session/disposed', { id: 'session-1' } as any)
    assert.equal(service.get('session-1'), undefined)
    assert.ok(service.get('session-2'))
})

test('租户配置查询（含飞书凭证映射）', async () => {
    const { service } = await createService()
    assert.equal(service.getTenantConfig('mall-001')?.feishu?.appId, 'cli-a')
    assert.equal(service.getTenantConfig('mall-002')?.feishu, undefined)
    assert.equal(service.getTenantConfig('mall-003'), undefined)
})

test('resolveServiceUrl：中心服务解析 + 内存缓存', async () => {
    const { calls, restore } = mockFetch((_url, body) => ({
        flag: 1,
        data: { url: `https://resolved-${body.serviceIndex}.test` },
    }))
    try {
        const { service } = await createService()
        const url = await service.resolveServiceUrl('mall-001')
        assert.equal(url, 'https://resolved-mall-001.test')

        // 第二次命中缓存，不发起请求
        const urlAgain = await service.resolveServiceUrl('mall-001')
        assert.equal(urlAgain, 'https://resolved-mall-001.test')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].headers.Authorization, 'Basic test-auth')
    } finally {
        restore()
    }
})

test('resolveServiceUrl：flag 非 1 时抛错且不写缓存', async () => {
    const { calls, restore } = mockFetch(() => ({ flag: 2, message: '服务不存在' }))
    try {
        const { service } = await createService()
        await assert.rejects(service.resolveServiceUrl('mall-003'), /服务不存在/)
        // 失败后重试仍会发起新请求（未污染缓存）
        await assert.rejects(service.resolveServiceUrl('mall-003'))
        assert.equal(calls.length, 2)
    } finally {
        restore()
    }
})

test('refreshUser：flag=1 更新用户与续期 ticket', async () => {
    const renewedUser = { ...testUser, ticket: 'ticket-new', userName: '张三' }
    const { calls, restore } = mockFetch(() => ({ flag: 1, data: renewedUser }))
    try {
        const { service } = await createService()
        service.bind('session-1', { ...testSessionContext, user: { ...testUser } })

        const user = await service.refreshUser('session-1')
        assert.equal(user.ticket, 'ticket-new')
        const context = service.get('session-1')
        assert.equal(context?.ticket, 'ticket-new')
        assert.equal(context?.user.userName, '张三')
        assert.equal(calls[0].headers['Simple-Ticket'], 'ticket-old')
        assert.equal(calls[0].body.ticket, 'ticket-old')
    } finally {
        restore()
    }
})

test('refreshUser：flag=20 标记会话失效并抛错', async () => {
    const { restore } = mockFetch(() => ({ flag: 20, message: '未登录' }))
    try {
        const { service } = await createService()
        service.bind('session-1', { ...testSessionContext, user: { ...testUser } })

        await assert.rejects(service.refreshUser('session-1'), /未登录/)
        assert.equal(service.get('session-1')?.invalid, true)
    } finally {
        restore()
    }
})

test('refreshUser：未绑定会话抛错', async () => {
    const { service } = await createService()
    await assert.rejects(service.refreshUser('session-unknown'), /未绑定上下文/)
})

test('switchShop：更新会话级门店上下文', async () => {
    const { calls, restore } = mockFetch((_url, body) => ({ flag: 1, data: { deptId: 88, deptCode: body.deptCode } }))
    try {
        const { service } = await createService()
        service.bind('session-1', { ...testSessionContext, user: { ...testUser } })

        const result = await service.switchShop('session-1', 'SHOP-88')
        assert.deepEqual(result, { lastShopCode: 'SHOP-88', lastShopId: 88 })
        const context = service.get('session-1')
        assert.equal(context?.lastShopCode, 'SHOP-88')
        assert.equal(context?.lastShopId, 88)
        assert.equal(calls[0].url, 'https://mall-1.test/system/dept/getByCode.do')
    } finally {
        restore()
    }
})

test('在线用户表：touch/remove/list 与刷新判断', async () => {
    const { service } = await createService()
    service.bind('session-1', { ...testSessionContext, user: { ...testUser } })

    // 未 touch → 需要刷新
    assert.equal(service.needsRefresh('session-1'), true)

    service.touchUser('mall-001', 'app-user-1', '张三')
    assert.equal(service.needsRefresh('session-1'), false)

    const onlineUsers = service.listOnlineUsers()
    assert.equal(onlineUsers.length, 1)
    assert.equal(onlineUsers[0].appUserId, 'app-user-1')
    assert.equal(onlineUsers[0].userName, '张三')

    // touch 保留已有 userName
    service.touchUser('mall-001', 'app-user-1')
    assert.equal(service.listOnlineUsers()[0].userName, '张三')

    service.removeUser('mall-001', 'app-user-1')
    assert.equal(service.listOnlineUsers().length, 0)
    assert.equal(service.needsRefresh('session-1'), true)
})
