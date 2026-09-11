/**
 * feishu_send_message 工具：发送消息到当前租户的飞书群。
 *
 * 执行时按会话 serviceIndex 从 cmis-context 取租户飞书凭证（appId/appSecret），
 * chatId 缺省用租户 defaultChatId。典型场景：先 query_report 查出报表数据，
 * 再以 markdown 卡片发到飞书群，实现"查完发群"的多插件协同。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CmisContext } from '../context/index.ts'
import type { FeishuClient, FeishuMsgType } from './client.ts'
import { resolveToolSession } from '../report-tools/session.ts'

/** 创建 feishu_send_message 工具 */
export function createFeishuSendMessageTool(cmisContext: CmisContext, client: FeishuClient): ToolDefinition {
    return defineTool({
        name: 'feishu_send_message',
        description:
            '发送消息到当前租户的飞书群。用户要求"发到飞书群"、"把报表发到群里"时调用；'
            + 'msgType=markdown 时支持 markdown 富文本（表格/加粗），适合发送报表结果。'
            + 'chatId 不传时发送到租户默认飞书群。',
        parameters: {
            content: {
                type: 'string',
                required: true,
                description: '消息内容（markdown 类型支持 markdown 语法）',
            },
            msgType: {
                type: 'string',
                description: '消息类型：text=纯文本（默认）、markdown=markdown 卡片',
            },
            chatId: {
                type: 'string',
                description: '目标群 chatId，不传时用租户默认群',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec): Promise<JsonValue> {
            const session = resolveToolSession(cmisContext, exec)
            if (!session) {
                return { success: false, error: '当前会话未绑定用户身份，请通过终端连接后再使用' }
            }

            const serviceIndex = session.context.serviceIndex
            const tenant = cmisContext.getTenantConfig(serviceIndex)
            const credential = tenant?.feishu
            if (!credential) {
                return {
                    success: false,
                    error: `当前租户（${serviceIndex}）未配置飞书应用，请联系管理员在 cmis-context 租户配置中补充`,
                }
            }

            const chatId = args.chatId ?? credential.defaultChatId
            if (!chatId) {
                return {
                    success: false,
                    error: '未指定目标群：请提供 chatId，或联系管理员配置租户默认飞书群（defaultChatId）',
                }
            }

            const msgType: FeishuMsgType = args.msgType === 'markdown' ? 'markdown' : 'text'
            try {
                const result = await client.sendMessage(
                    serviceIndex,
                    credential,
                    chatId,
                    msgType,
                    args.content,
                    exec.signal,
                )
                return {
                    success: true,
                    chatId,
                    msgType,
                    messageId: result.messageId,
                    hint: '消息已发送到飞书群，请告知用户。',
                }
            } catch (error) {
                return {
                    success: false,
                    error: `飞书消息发送失败：${error instanceof Error ? error.message : String(error)}`,
                }
            }
        },
    })
}
