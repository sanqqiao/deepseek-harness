/**
 * cmis-report-tools 插件：注册报表查询工具（query_report / list_available_reports /
 * list_my_reports / get_report_schema）与报表助手 system prompt 段落。
 * 工具经 cmis-context 解析会话身份（serviceUrl/ticket/user），按租户隔离调用报表接口。
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { CmisContext } from '../context/index.ts'
import { createGetReportSchemaTool } from './get-report-schema.ts'
import { createListAvailableReportsTool } from './list-available-reports.ts'
import { createListMyReportsTool } from './list-my-reports.ts'
import { createQueryReportTool } from './query-report.ts'

export const name = 'cmis-report-tools'
export const inject = ['tools', 'systemPrompt', 'cmisContext']

/** 读取提示词文件（插件加载时一次性读入） */
function loadPrompt(fileName: string): string {
    return readFileSync(new URL(`./prompts/${fileName}`, import.meta.url), 'utf-8')
}

/** 主提示词段落顺序（persona 之后、100-199 工具指引带之前） */
const REPORT_PROMPT_ORDER = 80
/** 日期规则段落顺序（紧随主提示词） */
const DATE_RULES_PROMPT_ORDER = 81

export function apply(ctx: Context) {
    const cmisContext: CmisContext = ctx.cmisContext

    ctx.tools.register(createQueryReportTool(cmisContext))
    ctx.tools.register(createListAvailableReportsTool(cmisContext))
    ctx.tools.register(createListMyReportsTool(cmisContext))
    ctx.tools.register(createGetReportSchemaTool())

    ctx.systemPrompt.section({
        name: 'cmis-report/main',
        order: REPORT_PROMPT_ORDER,
        text: loadPrompt('report.md'),
    })
    ctx.systemPrompt.section({
        name: 'cmis-report/date-rules',
        order: DATE_RULES_PROMPT_ORDER,
        text: loadPrompt('date-rules.md'),
    })

    console.log('[cmis-report-tools] 已注册工具：query_report、list_available_reports、list_my_reports、get_report_schema')
}
