/**
 * cmis-feishu 插件：注册 feishu_send_message 工具与飞书使用说明 prompt 段落。
 * 凭证按租户（serviceIndex）隔离，来自 cmis-context 租户配置；
 * token 缓存键 = serviceIndex，多租户互不串扰。
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { FeishuClient } from './client.ts'
import { createFeishuSendMessageTool } from './send-message.ts'

export const name = 'cmis-feishu'
export const inject = ['tools', 'systemPrompt', 'cmisContext']

/** 飞书使用说明段落顺序（报表提示词 81 之后） */
const FEISHU_PROMPT_ORDER = 85

function loadPrompt(fileName: string): string {
    return readFileSync(new URL(`./prompts/${fileName}`, import.meta.url), 'utf-8')
}

export function apply(ctx: Context) {
    const client = new FeishuClient()
    ctx.tools.register(createFeishuSendMessageTool(ctx.cmisContext, client))

    ctx.systemPrompt.section({
        name: 'cmis-feishu/main',
        order: FEISHU_PROMPT_ORDER,
        text: loadPrompt('feishu.md'),
    })

    console.log('[cmis-feishu] 已注册工具：feishu_send_message')
}
