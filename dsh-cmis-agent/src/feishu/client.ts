/**
 * 飞书 OpenAPI 多账号客户端。
 *
 * 凭证来自 cmis-context 租户配置（TenantFeishuConfig），token 缓存键 = serviceIndex，
 * 各租户 token 严格隔离，过期前提前刷新（默认提前 60 秒），避免并发拿到失效 token。
 */
import type { TenantFeishuConfig } from '../context/types.ts'

/** 飞书开放平台地址（私有化部署可通过参数覆盖） */
const DEFAULT_BASE_URL = 'https://open.feishu.cn'

/** token 提前刷新余量（毫秒） */
const TOKEN_REFRESH_AHEAD_MS = 60_000

/** tenant_access_token 缓存条目 */
interface TokenCacheEntry {
    token: string
    expireAt: number
}

/** 飞书 API 通用响应 */
interface FeishuApiResponse {
    code: number
    msg?: string
    data?: unknown
}

/** 发送消息结果 */
export interface FeishuMessageResult {
    messageId: string
}

/** 消息类型（text=纯文本，markdown=卡片 markdown 元素） */
export type FeishuMsgType = 'text' | 'markdown'

export class FeishuClient {
    private readonly baseUrl: string
    /** serviceIndex → tenant_access_token 缓存（租户隔离） */
    private readonly tokenCache = new Map<string, TokenCacheEntry>()

    constructor(baseUrl: string = DEFAULT_BASE_URL) {
        this.baseUrl = baseUrl
    }

    /** 拼接 baseUrl 与 path，压缩重复的斜杠（保留协议头的双斜杠） */
    private buildUrl(path: string): string {
        return (this.baseUrl + path).replace(/([^:]\/)\/+/g, '$1')
    }

    /**
     * 获取租户 tenant_access_token（缓存优先，过期前自动刷新）。
     * 缓存键 = serviceIndex：不同租户（不同飞书应用）token 互不串扰。
     */
    async getTenantAccessToken(
        serviceIndex: string,
        credential: TenantFeishuConfig,
        signal?: AbortSignal,
    ): Promise<string> {
        const cached = this.tokenCache.get(serviceIndex)
        if (cached && cached.expireAt - TOKEN_REFRESH_AHEAD_MS > Date.now()) {
            return cached.token
        }

        const response = await fetch(this.buildUrl('/open-apis/auth/v3/tenant_access_token/internal'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                app_id: credential.appId,
                app_secret: credential.appSecret,
            }),
            signal,
        })
        if (!response.ok) {
            throw new Error(`获取飞书 tenant_access_token 失败（HTTP ${response.status}）`)
        }
        const result = await response.json() as FeishuApiResponse & {
            tenant_access_token?: string
            expire?: number
        }
        if (result.code !== 0 || !result.tenant_access_token) {
            throw new Error(`获取飞书 tenant_access_token 失败：${result.msg ?? `code=${result.code}`}`)
        }
        const expireMs = (result.expire ?? 3600) * 1000
        this.tokenCache.set(serviceIndex, {
            token: result.tenant_access_token,
            expireAt: Date.now() + expireMs,
        })
        return result.tenant_access_token
    }

    /**
     * 发送消息到指定群（receive_id_type=chat_id）。
     * text：纯文本；markdown：interactive 卡片的 markdown 元素（支持表格等富文本）。
     */
    async sendMessage(
        serviceIndex: string,
        credential: TenantFeishuConfig,
        chatId: string,
        msgType: FeishuMsgType,
        content: string,
        signal?: AbortSignal,
    ): Promise<FeishuMessageResult> {
        const token = await this.getTenantAccessToken(serviceIndex, credential, signal)
        const body = msgType === 'markdown'
            ? {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify({
                    elements: [{ tag: 'markdown', content }],
                }),
            }
            : {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: content }),
            }

        const response = await fetch(
            this.buildUrl('/open-apis/im/v1/messages?receive_id_type=chat_id'),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
                signal,
            },
        )
        if (!response.ok) {
            throw new Error(`飞书消息发送失败（HTTP ${response.status}）`)
        }
        const result = await response.json() as FeishuApiResponse & {
            data?: { message_id?: string }
        }
        if (result.code !== 0) {
            throw new Error(`飞书消息发送失败：${result.msg ?? `code=${result.code}`}`)
        }
        return { messageId: result.data?.message_id ?? '' }
    }

    /** 丢弃租户 token 缓存（凭证变更/发送失败要求重新鉴权时使用） */
    dropToken(serviceIndex: string): void {
        this.tokenCache.delete(serviceIndex)
    }
}
