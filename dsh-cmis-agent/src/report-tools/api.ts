/**
 * CMIS 报表 API 客户端：经 mall 主系统 simple-report 前缀调用 cmis-report 服务。
 * 请求携带会话上下文的 Simple-Ticket；响应头返回新 ticket 时顺带回写会话上下文（续期）。
 */
import type { SessionContext, SimpleReturn } from '../context/types.ts'

/** 分页参数（Simple-Page 请求头） */
export interface PageParam {
    currentPage: number
    pageSize: number
}

/** 拼接 baseUrl 与 path，压缩重复的斜杠（保留协议头的双斜杠） */
function buildUrl(baseUrl: string, path: string): string {
    return (baseUrl + path).replace(/([^:]\/)\/+/g, '$1')
}

async function postJson<T = unknown>(
    sessionContext: SessionContext,
    path: string,
    data: unknown,
    page?: PageParam,
    signal?: AbortSignal,
): Promise<SimpleReturn<T>> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Simple-Ticket': sessionContext.ticket,
    }
    if (sessionContext.authorization) headers['Authorization'] = sessionContext.authorization
    if (page) headers['Simple-Page'] = JSON.stringify(page)
    const response = await fetch(buildUrl(sessionContext.serviceUrl, path), {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
        signal,
    })
    if (!response.ok) {
        throw new Error(`请求失败（HTTP ${response.status}）：${path}`)
    }
    const ticket = response.headers.get('simple-ticket')
    if (ticket) sessionContext.ticket = ticket
    return await response.json() as SimpleReturn<T>
}

/**
 * 实时查询报表数据。
 *
 * @param sessionContext 会话上下文（serviceUrl/ticket）
 * @param path 报表接口路径（如 /report/buyer/unsoldProductReport.do）
 * @param params 查询参数（startDate/endDate/deptCode 等）
 * @param page 分页参数
 * @param signal 取消信号
 */
export function queryReport(
    sessionContext: SessionContext,
    path: string,
    params: Record<string, unknown>,
    page?: PageParam,
    signal?: AbortSignal,
): Promise<SimpleReturn> {
    return postJson(sessionContext, `/simple-report${path}`, params, page, signal)
}

/**
 * 查询用户的订阅通知列表（已订阅报表的推送记录）。
 */
export function listSubscribeNotifications(
    sessionContext: SessionContext,
    page?: PageParam,
    signal?: AbortSignal,
): Promise<SimpleReturn<unknown[]>> {
    return postJson(sessionContext, '/simple-report/report/subscribe/listNotifications.do', {}, page, signal)
}

/**
 * 列出报表的可用缓存文档（docId、cacheParams、期间、生成时间）。
 * 供 query_report 缓存优先流程定位预计算缓存。
 */
export function agentCacheList(
    sessionContext: SessionContext,
    data: { reportNames?: string[]; paths?: string[]; period?: string; year?: number },
    signal?: AbortSignal,
): Promise<SimpleReturn<unknown[]>> {
    return postJson(sessionContext, '/simple-report/agent/report/cacheList.do', data, undefined, signal)
}

/**
 * 按 docId 只读查询报表缓存数据（未命中不触发生成）。
 */
export function agentCacheQuery(
    sessionContext: SessionContext,
    data: Record<string, unknown>,
    page?: PageParam,
    signal?: AbortSignal,
): Promise<SimpleReturn> {
    return postJson(sessionContext, '/simple-report/agent/report/cacheQuery.do', data, page, signal)
}

/**
 * 获取用户报表清单：常用报表（缓存使用记录）+ 已订阅报表 + 最新推送通知。
 */
export function agentMyReports(
    sessionContext: SessionContext,
    data?: { notificationCount?: number },
    signal?: AbortSignal,
): Promise<SimpleReturn> {
    return postJson(sessionContext, '/simple-report/agent/report/myReports.do', data ?? {}, undefined, signal)
}
