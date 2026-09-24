import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ResponseFlag } from './types.ts'
import type { CmisUser, OnlineUserRecord, SessionContext, SimpleReturn, TenantConfig } from './types.ts'

export const name = 'cmis-context'

export interface Config {
    /** 中心服务地址（serviceIndex → serviceUrl 解析） */
    centerServer: string
    /** 中心服务 Authorization */
    centerAuthorization: string
    /** 用户信息刷新间隔（毫秒），超过未活动则下次访问触发 ticket 续期 */
    userRefreshIntervalMs: number
    /** 租户配置（serviceIndex → 飞书凭证映射） */
    tenants: TenantConfig[]
}

export const Config: z<Config> = z.object({
    centerServer: z.string().required().description('中心服务地址'),
    centerAuthorization: z.string().required().description('中心服务 Authorization'),
    userRefreshIntervalMs: z.natural().default(60000).description('用户信息刷新间隔（毫秒）'),
    tenants: z.array(z.object({
        serviceIndex: z.string().required().description('业务系统服务索引'),
        feishu: z.object({
            appId: z.string().required().description('飞书应用 App ID'),
            appSecret: z.string().required().description('飞书应用 App Secret'),
            defaultChatId: z.string().description('默认发送目标群 chatId'),
        }).description('飞书应用凭证'),
    })).default([]).description('租户配置列表'),
})

declare module '@deepseek-ai/cordis' {
    interface Context {
        cmisContext: CmisContext
    }
}

/** 拼接 baseUrl 与 path，压缩重复的斜杠（保留协议头的双斜杠） */
function buildUrl(baseUrl: string, path: string): string {
    return (baseUrl + path).replace(/([^:]\/)\/+/g, '$1')
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<{ result: SimpleReturn; responseTicket?: string }> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
    })
    if (!response.ok) {
        throw new Error(`请求失败（HTTP ${response.status}）：${url}`)
    }
    return {
        result: await response.json() as SimpleReturn,
        responseTicket: response.headers.get('simple-ticket') ?? undefined,
    }
}

/**
 * 租户/会话上下文中心：DSH 会话与 CMIS 租户/用户身份的绑定关系、
 * serviceIndex 解析缓存、租户配置（含飞书凭证）、在线用户表、ticket 续期。
 */
export class CmisContext extends Service {
    /** sessionId → 会话上下文 */
    private readonly sessionContexts = new Map<string, SessionContext>()
    /** serviceIndex → serviceUrl 解析缓存 */
    private readonly serviceUrlCache = new Map<string, string>()
    /** 在线用户表：`${serviceIndex}|${appUserId}` → 记录 */
    private readonly onlineUsers = new Map<string, OnlineUserRecord>()
    /** serviceIndex → 租户配置 */
    private readonly tenantMap = new Map<string, TenantConfig>()

    constructor(ctx: Context, private readonly config: Config) {
        super(ctx, 'cmisContext')
        for (const tenant of config.tenants) {
            this.tenantMap.set(tenant.serviceIndex, tenant)
        }
        // 会话销毁时自动清理绑定，避免租户上下文泄漏
        ctx.on('session/disposed', (session) => {
            this.sessionContexts.delete(session.id)
        })
    }

    // ---- 会话上下文 ----

    bind(sessionId: string, context: SessionContext): void {
        this.sessionContexts.set(sessionId, context)
    }

    get(sessionId: string): SessionContext | undefined {
        return this.sessionContexts.get(sessionId)
    }

    unbind(sessionId: string): boolean {
        return this.sessionContexts.delete(sessionId)
    }

    /** 标记会话上下文失效（ticket 过期，等待终端重新鉴权） */
    invalidate(sessionId: string): void {
        const context = this.sessionContexts.get(sessionId)
        if (context) context.invalid = true
    }

    // ---- serviceIndex 解析 ----

    /** serviceIndex → serviceUrl（经中心服务解析，内存缓存） */
    async resolveServiceUrl(serviceIndex: string, signal?: AbortSignal): Promise<string> {
        const cached = this.serviceUrlCache.get(serviceIndex)
        if (cached) return cached
        const { result } = await postJson(
            buildUrl(this.config.centerServer, '/app/service/getAppService.do'),
            { serviceIndex },
            { Authorization: this.config.centerAuthorization },
            signal,
        )
        if (result.flag !== ResponseFlag.SUCCESS) {
            throw new Error(result.message || '查找业务系统服务失败')
        }
        const serviceUrl = (result.data as { url?: string } | undefined)?.url
        if (!serviceUrl) throw new Error('业务系统服务地址为空')
        this.serviceUrlCache.set(serviceIndex, serviceUrl)
        return serviceUrl
    }

    // ---- 租户配置 ----

    getTenantConfig(serviceIndex: string): TenantConfig | undefined {
        return this.tenantMap.get(serviceIndex)
    }

    // ---- 用户身份 ----

    /**
     * 按当前会话身份重新获取用户信息（getUserByTicket，ticket 顺带续期）。
     * flag=20（未登录）时标记会话上下文失效并抛错。
     */
    async refreshUser(sessionId: string, signal?: AbortSignal): Promise<CmisUser> {
        const context = this.requireContext(sessionId)
        const { result, responseTicket } = await postJson(
            buildUrl(context.serviceUrl, '/system/onlineUser/getUserByTicket.do'),
            { ticket: context.ticket },
            this.buildAuthHeaders(context),
            signal,
        )
        if (result.flag === ResponseFlag.UNLOGIN) {
            context.invalid = true
            throw new Error('未登录或登录信息已过期，请重新登录')
        }
        if (result.flag !== ResponseFlag.SUCCESS) {
            throw new Error(result.message || '查找用户信息失败')
        }
        const user = result.data as CmisUser
        context.user = user
        if (responseTicket) context.ticket = responseTicket
        else if (user.ticket) context.ticket = user.ticket
        return user
    }

    /**
     * 门店切换：按 deptCode 查询部门，更新会话级门店上下文（lastShopCode/lastShopId）。
     */
    async switchShop(sessionId: string, deptCode: string, signal?: AbortSignal): Promise<{ lastShopCode: string; lastShopId: number }> {
        const context = this.requireContext(sessionId)
        const { result, responseTicket } = await postJson(
            buildUrl(context.serviceUrl, '/system/dept/getByCode.do'),
            { deptCode },
            this.buildAuthHeaders(context),
            signal,
        )
        if (responseTicket) context.ticket = responseTicket
        if (result.flag !== ResponseFlag.SUCCESS) {
            throw new Error(result.message || `根据编码 ${deptCode} 查找门店失败`)
        }
        const deptId = (result.data as { deptId?: number } | undefined)?.deptId
        if (deptId === undefined) throw new Error(`根据编码 ${deptCode} 查找门店失败：未返回部门ID`)
        context.lastShopCode = deptCode
        context.lastShopId = deptId
        return { lastShopCode: deptCode, lastShopId: deptId }
    }

    // ---- 在线用户表 ----

    /** 更新在线用户心跳（连接建立/收到消息时调用） */
    touchUser(serviceIndex: string, appUserId: string, userName?: string): void {
        const key = `${serviceIndex}|${appUserId}`
        const existing = this.onlineUsers.get(key)
        this.onlineUsers.set(key, {
            serviceIndex,
            appUserId,
            userName: userName ?? existing?.userName,
            lastActiveAt: Date.now(),
        })
    }

    /** 移除在线用户（连接断开时调用） */
    removeUser(serviceIndex: string, appUserId: string): void {
        this.onlineUsers.delete(`${serviceIndex}|${appUserId}`)
    }

    listOnlineUsers(): OnlineUserRecord[] {
        return [...this.onlineUsers.values()]
    }

    /** 用户信息是否需要刷新（超过 userRefreshIntervalMs 未活动） */
    needsRefresh(sessionId: string): boolean {
        const context = this.sessionContexts.get(sessionId)
        if (!context || context.invalid) return true
        const record = this.onlineUsers.get(`${context.serviceIndex}|${context.appUserId}`)
        if (!record) return true
        return Date.now() - record.lastActiveAt >= this.config.userRefreshIntervalMs
    }

    /** 统一鉴权请求头：Simple-Ticket + 可选 Authorization（ticket 过期时下游静默重登） */
    private buildAuthHeaders(context: SessionContext): Record<string, string> {
        const headers: Record<string, string> = { 'Simple-Ticket': context.ticket }
        if (context.authorization) headers['Authorization'] = context.authorization
        return headers
    }

    private requireContext(sessionId: string): SessionContext {
        const context = this.sessionContexts.get(sessionId)
        if (!context) throw new Error(`会话 "${sessionId}" 未绑定上下文`)
        return context
    }
}

export function apply(ctx: Context, config: Config) {
    ctx.plugin(CmisContext, config)
    console.log(`[cmis-context] 服务已注册：centerServer=${config.centerServer}，租户数=${config.tenants.length}`)
}
