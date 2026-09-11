/**
 * list_available_reports 工具：列出用户可用的报表清单。
 *
 * 返回两部分：
 * 1. commonReports：系统内置的常用报表（报表注册表）
 * 2. subscribeReports：用户已订阅报表的最新推送通知（含报表名称与推送时间）
 *
 * LLM 拿到清单后可向用户展示，或据此选择 reportCode 调用 query_report。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CmisContext } from '../context/index.ts'
import { ResponseFlag } from '../context/types.ts'
import { listSubscribeNotifications } from './api.ts'
import { reportRegistry } from './registry.ts'
import { markUnlogin, resolveToolSession, UNLOGIN_MESSAGE } from './session.ts'

/** 订阅推送通知条目（listSubscribeNotifications 返回，按需读取字段） */
interface SubscribeNotificationItem {
    menuId?: JsonValue
    menuName?: JsonValue
    title?: JsonValue
    content?: JsonValue
    readFlag?: JsonValue
    sentAt?: JsonValue
}

/** 创建 list_available_reports 工具 */
export function createListAvailableReportsTool(cmisContext: CmisContext): ToolDefinition {
    return defineTool({
        name: 'list_available_reports',
        description:
            '列出当前用户可查询的所有报表清单，包含常用报表（报表编码、名称、分类、说明）'
            + '和已订阅报表的最新推送通知。当用户问"有哪些报表"、"能查什么"、'
            + '"我的订阅"，或用户提到的报表无法确定对应哪个 reportCode 时调用。',
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

            const commonReports = reportRegistry.map((report) => ({
                reportCode: report.reportCode,
                reportName: report.reportName,
                category: report.category,
                description: report.description,
            }))

            // 拉取用户订阅报表的最新通知（订阅报表可能不在内置清单中；失败不阻塞常用报表清单）
            let subscribeReports: JsonValue[] = []
            try {
                const resp = await listSubscribeNotifications(
                    session.context,
                    { currentPage: 1, pageSize: 10 },
                    exec.signal,
                )
                if (markUnlogin(cmisContext, session, resp)) {
                    return { success: false, error: UNLOGIN_MESSAGE }
                }
                if (resp.flag === ResponseFlag.SUCCESS && Array.isArray(resp.data)) {
                    subscribeReports = (resp.data as (SubscribeNotificationItem | undefined)[]).map((item) => ({
                        menuId: item?.menuId ?? null,
                        menuName: item?.menuName ?? null,
                        title: item?.title ?? null,
                        content: item?.content ?? null,
                        readFlag: item?.readFlag ?? null,
                        sentAt: item?.sentAt ?? null,
                    }))
                }
            } catch {
                subscribeReports = []
            }

            return {
                success: true,
                commonReports,
                subscribeReports,
                hint: '已获取报表清单。可向用户简要展示报表名称与分类；用户指定报表后，用对应 reportCode 调用 query_report 查询数据。',
            }
        },
    })
}
