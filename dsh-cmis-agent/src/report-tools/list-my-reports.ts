/**
 * list_my_reports 工具：获取当前用户的个性化报表清单。
 *
 * 返回三部分：
 * 1. commonReports：常用报表（按缓存使用记录聚合，含使用次数与最近查看时间）
 * 2. subscribedReports：已订阅报表（模块名称与订阅时间）
 * 3. notifications：最新推送通知（含推送内容与时间）
 *
 * 与 list_available_reports 的区别：后者返回系统内置的全量报表清单，
 * 本工具返回用户维度的个性化数据（常用/订阅/推送）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CmisContext } from '../context/index.ts'
import { ResponseFlag } from '../context/types.ts'
import { agentMyReports } from './api.ts'
import { markUnlogin, resolveToolSession, UNLOGIN_MESSAGE } from './session.ts'

/** 创建 list_my_reports 工具 */
export function createListMyReportsTool(cmisContext: CmisContext): ToolDefinition {
    return defineTool({
        name: 'list_my_reports',
        description:
            '获取当前用户的个性化报表数据：常用报表（最近经常查看的报表及最近查看时间）、'
            + '已订阅报表清单、最新报表推送通知。当用户问"我最近看了什么报表"、'
            + '"我订阅了哪些报表"、"我的报表推送"时调用。',
        parameters: {},
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(_args, exec): Promise<JsonValue> {
            const session = resolveToolSession(cmisContext, exec)
            if (!session) {
                return { success: false, error: '当前会话未绑定用户身份，请通过终端连接后再使用' }
            }

            let data: {
                commonReports?: JsonValue[]
                subscribedReports?: JsonValue[]
                notifications?: JsonValue[]
            } | undefined
            try {
                const resp = await agentMyReports(session.context, undefined, exec.signal)
                if (markUnlogin(cmisContext, session, resp)) {
                    return { success: false, error: UNLOGIN_MESSAGE }
                }
                if (resp.flag === ResponseFlag.SUCCESS) {
                    data = resp.data as typeof data
                }
            } catch {
                return { success: false, error: '用户报表清单获取失败，请稍后重试' }
            }

            if (!data) {
                return { success: false, error: '用户报表清单获取失败，请稍后重试' }
            }

            const commonCount = data.commonReports?.length || 0
            const subscribeCount = data.subscribedReports?.length || 0
            const notifyCount = data.notifications?.length || 0

            return {
                success: true,
                commonReports: data.commonReports || [],
                subscribedReports: data.subscribedReports || [],
                notifications: data.notifications || [],
                hint: `已获取用户报表清单：常用报表${commonCount}个、订阅报表${subscribeCount}个、最新推送${notifyCount}条。`
                    + '可向用户简要展示清单；用户指定报表后，用对应 reportCode 调用 query_report 查询数据。',
            }
        },
    })
}
