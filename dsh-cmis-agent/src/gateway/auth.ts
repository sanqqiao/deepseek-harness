import type { CmisContext } from '../context/index.ts'
import { ResponseFlag } from '../context/types.ts'
import type { CmisUser, SimpleReturn } from '../context/types.ts'
import { HEADER_NAMES } from './types.ts'

/** 连接鉴权凭证（来自 WS 升级请求头） */
export interface AuthCredentials {
    serviceIndex: string
    ticket: string
    appUserId: string
    authorization?: string
}

/** 连接鉴权结果 */
export interface AuthResult {
    serviceIndex: string
    serviceUrl: string
    appUserId: string
    ticket: string
    authorization?: string
    user: CmisUser
}

/** 鉴权失败（消息可直接推送给终端） */
export class AuthError extends Error {}

/** 从 WS 升级请求头读取鉴权凭证（头名大小写不敏感） */
export function readCredentials(headers: Record<string, string | string[] | undefined>): AuthCredentials {
    const getHeader = (name: string): string | undefined => {
        const lowerName = name.toLowerCase()
        for (const key in headers) {
            if (key.toLowerCase() === lowerName) {
                const value = headers[key]
                return Array.isArray(value) ? value[0] : value
            }
        }
        return undefined
    }
    return {
        serviceIndex: getHeader(HEADER_NAMES.serviceIndex) ?? '',
        ticket: getHeader(HEADER_NAMES.ticket) ?? '',
        appUserId: getHeader(HEADER_NAMES.appUserId) ?? '',
        authorization: getHeader(HEADER_NAMES.authorization),
    }
}

/** 校验凭证完整性（缺失时抛 AuthError） */
function requireCredentials(credentials: AuthCredentials): void {
    if (!credentials.serviceIndex) throw new AuthError('业务系统服务索引不能为空')
    if (!credentials.ticket) throw new AuthError('登录凭证不能为空')
    if (!credentials.appUserId) throw new AuthError('用户ID不能为空')
}

/** 拼接 baseUrl 与 path，压缩重复的斜杠（保留协议头的双斜杠） */
function buildUrl(baseUrl: string, path: string): string {
    return (baseUrl + path).replace(/([^:]\/)\/+/g, '$1')
}

/**
 * 连接鉴权：serviceIndex 经中心服务解析 serviceUrl，
 * 再以 ticket 调 getUserByTicket 获取真实 CMIS 用户（未登录时拒绝连接）。
 */
export async function authenticate(cmisContext: CmisContext, credentials: AuthCredentials, signal?: AbortSignal): Promise<AuthResult> {
    requireCredentials(credentials)
    const serviceUrl = await cmisContext.resolveServiceUrl(credentials.serviceIndex, signal)

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Simple-Ticket': credentials.ticket,
    }
    if (credentials.authorization) headers.Authorization = credentials.authorization
    const response = await fetch(buildUrl(serviceUrl, '/system/onlineUser/getUserByTicket.do'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ticket: credentials.ticket }),
        signal,
    })
    if (!response.ok) {
        throw new AuthError(`查找用户信息失败（HTTP ${response.status}），请稍后再试`)
    }
    const result = await response.json() as SimpleReturn<CmisUser>
    if (result.flag !== ResponseFlag.SUCCESS) {
        throw new AuthError(`查找用户信息失败（flag=${result.flag}${result.message ? ` ${result.message}` : ''}），请重新登录`)
    }
    if (!result.data) {
        throw new AuthError('查找用户信息失败：未返回用户数据')
    }
    return {
        serviceIndex: credentials.serviceIndex,
        serviceUrl,
        appUserId: credentials.appUserId,
        ticket: result.data.ticket ?? credentials.ticket,
        authorization: credentials.authorization,
        user: result.data,
    }
}
