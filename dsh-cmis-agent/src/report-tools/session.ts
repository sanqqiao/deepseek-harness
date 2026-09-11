/**
 * 工具侧会话上下文解析：从工具执行的 agent（DSH 会话）取回 cmis-context 绑定的租户/用户身份。
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CmisContext } from '../context/index.ts'
import type { SessionContext, SimpleReturn } from '../context/types.ts'
import { ResponseFlag } from '../context/types.ts'

/** 工具可用的会话身份 */
export interface ToolSession {
    sessionId: string
    context: SessionContext
}

/**
 * 解析工具执行所属的 CMIS 会话上下文。
 * 返回 undefined 表示当前会话未经 gateway 鉴权绑定（如本地调试会话）。
 */
export function resolveToolSession(cmisContext: CmisContext, exec: ToolRunContext): ToolSession | undefined {
    const sessionId = exec.agent?.id
    if (!sessionId) return undefined
    const context = cmisContext.get(sessionId)
    if (!context) return undefined
    return { sessionId, context }
}

/** 响应是否未登录（flag=20，同时标记会话上下文失效等待终端重新鉴权） */
export function markUnlogin(cmisContext: CmisContext, session: ToolSession, resp: SimpleReturn): boolean {
    if (resp.flag !== ResponseFlag.UNLOGIN) return false
    cmisContext.invalidate(session.sessionId)
    return true
}

export const UNLOGIN_MESSAGE = '登录信息已过期，请重新登录后再试'
