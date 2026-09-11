/**
 * get_report_schema 工具：获取指定报表的查询参数结构（schema）。
 * LLM 在不确定报表需要哪些参数、或 query_report 返回 missingParams 时调用，
 * 据此向用户询问缺失参数。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { findReport } from './registry.ts'

/** 创建 get_report_schema 工具 */
export function createGetReportSchemaTool(): ToolDefinition {
    return defineTool({
        name: 'get_report_schema',
        description:
            '获取指定报表的查询参数结构（参数名、是否必填、类型、默认值）。'
            + '当不确定某个报表需要哪些查询参数、或 query_report 提示缺少必填参数时调用。',
        parameters: {
            reportCode: {
                type: 'string',
                required: true,
                description: '报表编码，来自 list_available_reports 返回',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args): Promise<JsonValue> {
            const report = findReport(args.reportCode)
            if (!report) {
                return {
                    success: false,
                    error: `未找到报表: ${args.reportCode}，请先调用 list_available_reports 获取可用报表编码`,
                }
            }
            return {
                success: true,
                reportCode: report.reportCode,
                reportName: report.reportName,
                description: report.description,
                params: report.paramDefs.map((param) => ({
                    name: param.name,
                    label: param.label,
                    type: param.type,
                    required: param.required,
                    defaultValue: param.defaultValue ?? null,
                    description: param.description ?? null,
                })),
            }
        },
    })
}
