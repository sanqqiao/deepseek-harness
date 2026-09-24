/**
 * query_report 工具：查询报表数据（缓存优先）。
 *
 * 优先按报表注册表的 cache 配置定位 cmis-report 预计算缓存（docId 只读查询，
 * 业务参数与日期区间需匹配），命中直接返回并附生成时间；未命中或无缓存配置时
 * 回退实时查询（经 mall 主系统 simple-report 前缀调用报表接口）。
 * 结构化数据通过 presentationMeta 投影（gateway 在 tool 事件回传前端渲染），
 * markdown 表格 + 分页信息返回给 LLM（用于组织最终回复）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CmisContext } from '../context/index.ts'
import { ResponseFlag } from '../context/types.ts'
import type { SessionContext, SimpleReturn } from '../context/types.ts'
import { agentCacheList, agentCacheQuery, queryReport } from './api.ts'
import type { PageParam } from './api.ts'
import { findReport } from './registry.ts'
import type { ReportDefinition, ReportColumnDef } from './registry.ts'
import { markUnlogin, resolveToolSession, UNLOGIN_MESSAGE } from './session.ts'

/** 单次回传 LLM 的最大行数（防止超长 tool 结果撑爆上下文） */
const MAX_ROWS_TO_LLM = 30

/** 报表行（键值对，值为 JSON 数据） */
export type ReportRow = Record<string, JsonValue>

/** 缓存报表条目（agentCacheList 返回，docs 为该报表的缓存文档列表） */
export interface CacheReportEntry {
    reportName: string
    docs: CacheDocItem[]
}

/** 缓存文档条目（agentCacheList 返回） */
export interface CacheDocItem {
    docId: string
    reportName: string
    mode: string
    period: string
    year?: number
    month?: number
    week?: number
    dayOfYear?: number
    cacheParams: Record<string, unknown>
    dataCount?: number
    updatedAt: string | Date
}

/** 分页信息（报表查询返回，字段按需读取） */
interface PageInfoLike {
    totalRows?: number
    currentPage?: number
    totalPages?: number
}

/** 结构化结果（presentationMeta 投影，gateway tool 事件回传前端渲染） */
export interface ReportResultData {
    reportCode: string
    reportName: string
    params: Record<string, JsonValue>
    columns?: Record<string, JsonValue>[] | null
    rows: ReportRow[]
    summary?: Record<string, JsonValue> | null
    page: JsonValue
    dataSource: 'cache' | 'realtime'
    cacheUpdatedAt: string | null
}

/** 把日期值（Date/ISO 字符串/YYYY-MM-DD）归一到天粒度时间戳 */
export function toDayTime(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null
    const date = value instanceof Date ? value : new Date(String(value))
    if (isNaN(date.getTime())) return null
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 业务参数匹配（非日期参数）：
 * 用户提供了值的参数要求与缓存文档一致（文档缺省时按注册表默认值兜底）；
 * 用户未提供的参数不约束（接受用户订阅范围内任意缓存）。
 */
export function businessParamMatch(
    docParams: Record<string, unknown>,
    params: Record<string, unknown>,
    report: ReportDefinition,
): boolean {
    for (const def of report.paramDefs) {
        if (def.name === 'startDate' || def.name === 'endDate') continue
        const userValue = params[def.name]
        if (userValue === undefined) continue
        const docRaw = docParams[def.name]
        const docValue = docRaw !== undefined ? docRaw : def.defaultValue
        if (docValue === undefined) return false
        if (String(docValue) !== String(userValue)) return false
    }
    return true
}

/** 日期覆盖：请求的起止日期都落在缓存文档的统计区间内 */
export function dateRangeCovers(
    docParams: Record<string, unknown>,
    startDate?: string,
    endDate?: string,
): boolean {
    if (!startDate && !endDate) return true
    const docStart = toDayTime(docParams.startDate)
    const docEnd = toDayTime(docParams.endDate)
    if (docStart === null || docEnd === null) return false

    const reqStart = toDayTime(startDate)
    const reqEnd = toDayTime(endDate)
    if (reqStart !== null && (reqStart < docStart || reqStart > docEnd)) return false
    if (reqEnd !== null && (reqEnd < docStart || reqEnd > docEnd)) return false
    return true
}

/** 从缓存文档列表中挑选最匹配的：业务参数一致 + 日期覆盖 + 生成时间最新 */
export function pickCacheDoc(
    docs: CacheDocItem[],
    report: ReportDefinition,
    params: Record<string, unknown>,
    startDate?: string,
    endDate?: string,
): CacheDocItem | undefined {
    const matched = docs.filter(
        (doc) => businessParamMatch(doc.cacheParams || {}, params, report)
            && dateRangeCovers(doc.cacheParams || {}, startDate, endDate),
    )
    if (matched.length === 0) return undefined
    matched.sort((a, b) => toDayTime(b.updatedAt)! - toDayTime(a.updatedAt)!)
    return matched[0]
}

/**
 * 缓存优先查询：定位预计算缓存文档并按 docId 只读读取。
 * 命中返回行数据与分页；任何异常或未命中返回 null（回退实时查询）。
 */
async function queryFromCache(
    sessionContext: SessionContext,
    report: ReportDefinition,
    params: Record<string, unknown>,
    startDate: string | undefined,
    endDate: string | undefined,
    page: number,
    pageSize: number,
    signal?: AbortSignal,
): Promise<{ rows: ReportRow[]; summary?: Record<string, JsonValue> | null; page?: PageInfoLike; updatedAt: string; period: string } | null> {
    const cacheConfig = report.cache!
    try {
        const listResp = await agentCacheList(
            sessionContext,
            { reportNames: [cacheConfig.reportName] },
            signal,
        )
        if (listResp.flag !== ResponseFlag.SUCCESS || !Array.isArray(listResp.data)) {
            return null
        }

        const reportEntry = (listResp.data as CacheReportEntry[]).find(
            (item) => item?.reportName === cacheConfig.reportName,
        )
        const docs: CacheDocItem[] = reportEntry?.docs || []
        if (docs.length === 0) return null

        const doc = pickCacheDoc(docs, report, params, startDate, endDate)
        if (!doc) return null

        const nestedPath = cacheConfig.mode === 'nested' && cacheConfig.detailColumn
            ? [{ column: cacheConfig.detailColumn }]
            : undefined

        const queryResp = await agentCacheQuery(
            sessionContext,
            {
                docId: doc.docId,
                reportName: cacheConfig.reportName,
                mode: cacheConfig.mode,
                period: doc.period,
                year: doc.year,
                month: doc.month,
                week: doc.week,
                dayOfYear: doc.dayOfYear,
                cacheParams: doc.cacheParams,
                nestedPath,
            },
            { currentPage: page, pageSize },
            signal,
        )
        if (queryResp.flag !== ResponseFlag.SUCCESS || !(queryResp.data as { hit?: boolean } | undefined)?.hit) {
            return null
        }

        const data = (queryResp.data as { data?: unknown }).data
        const rows: ReportRow[] = Array.isArray(data) ? data as ReportRow[] : data ? [data as ReportRow] : []
        const summary = (queryResp.data as { summary?: unknown }).summary
        const updatedAt = doc.updatedAt instanceof Date
            ? doc.updatedAt.toISOString()
            : String(doc.updatedAt)
        return {
            rows,
            summary: summary && typeof summary === 'object' && !Array.isArray(summary)
                ? summary as Record<string, JsonValue>
                : null,
            page: queryResp.page as PageInfoLike | undefined,
            updatedAt,
            period: doc.period,
        }
    } catch {
        return null
    }
}

/** 从列定义解析 markdown/汇总用列清单（无定义时取数据第一行键兜底） */
export function resolveColumns(
    columns: ReportColumnDef[] | undefined,
    rows: ReportRow[],
): ReportColumnDef[] {
    if (columns && columns.length > 0) {
        return columns.filter(
            (col) => rows.length === 0 || rows.some((row) => row[col.field] !== undefined),
        )
    }
    if (rows.length === 0) return []
    return Object.keys(rows[0])
        .filter((key) => typeof rows[0][key] !== 'object' || rows[0][key] === null)
        .map((field) => ({ field, label: field }))
}

/** 单元格文本（markdown 转义） */
function cellText(value: JsonValue | undefined): string {
    return value === null || value === undefined ? '' : String(value).replace(/\|/g, '\\|')
}

/** 把报表行转成 markdown 表格（中文表头，可选汇总行） */
export function buildMarkdownTable(
    reportName: string,
    rows: ReportRow[],
    columns?: ReportColumnDef[],
    summary?: Record<string, JsonValue> | null,
): string {
    if (rows.length === 0) {
        return `${reportName}：查询结果为空`
    }
    const cols = resolveColumns(columns, rows)
    const header = `| ${cols.map((col) => col.label).join(' | ')} |`
    const separator = `| ${cols.map(() => '---').join(' | ')} |`
    const body = rows
        .map((row) => `| ${cols.map((col) => cellText(row[col.field])).join(' | ')} |`)
        .join('\n')
    const summaryLine = summary
        ? `\n| ${cols
            .map((col, index) => (index === 0 ? '合计' : cellText(summary[col.field] as JsonValue | undefined)))
            .join(' | ')} |`
        : ''
    return `${header}\n${separator}\n${body}${summaryLine}`
}

/** 组装查询参数：只传报表注册表中定义的参数（必填缺省用默认值兜底） */
export function assembleParams(report: ReportDefinition, paramArgs: Record<string, unknown>): Record<string, JsonValue> {
    const params: Record<string, JsonValue> = {}
    for (const def of report.paramDefs) {
        const value = paramArgs[def.name]
        if (value !== undefined && value !== null && value !== '') {
            params[def.name] = value as JsonValue
        } else if (def.required && def.defaultValue !== undefined) {
            params[def.name] = def.defaultValue
        }
    }
    return params
}

/** 未登录时的工具返回 */
function unloginResult(): JsonValue {
    return { success: false, error: UNLOGIN_MESSAGE }
}

/**
 * 创建 query_report 工具（缓存优先查询）。
 *
 * @param cmisContext cmis-context 服务（会话身份与租户上下文）
 */
export function createQueryReportTool(cmisContext: CmisContext): ToolDefinition {
    return defineTool({
        name: 'query_report',
        description:
            '查询报表数据。reportCode 必须来自 list_available_reports 返回的报表编码'
            + '（如 unsoldProduct=滞销品报表、costDiff=成本差异分析、expiryWarning=临期预警）。'
            + '日期参数格式 YYYY-MM-DD；不确定报表需要哪些参数时先调用 get_report_schema。'
            + '用户询问自然时间段（今天/昨天/本周/上周/本月/上月）时优先匹配预计算缓存，'
            + '命中时返回 dataSource=cache 及缓存生成时间 cacheUpdatedAt。',
        parameters: {
            reportCode: {
                type: 'string',
                required: true,
                description: '报表编码，来自 list_available_reports 或 get_report_schema 返回',
            },
            startDate: { type: 'string', description: '开始日期，格式 YYYY-MM-DD' },
            endDate: { type: 'string', description: '结束日期，格式 YYYY-MM-DD' },
            deptCode: { type: 'string', description: '部门编码，可选' },
            unsoldDays: { type: 'number', description: '滞销天数（仅滞销品报表），默认30' },
            turnoverDays: { type: 'number', description: '周转天数（仅高周转商品报表），默认60' },
            newProductDays: { type: 'number', description: '新品天数（仅新品报表），默认90' },
            page: { type: 'number', description: '页码，默认1' },
            pageSize: { type: 'number', description: '每页行数，默认20' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            presentationMeta: (_args, value) => {
                const result = value as { success?: boolean; resultData?: ReportResultData }
                return result?.success && result.resultData
                    ? result.resultData as unknown as JsonValue
                    : null
            },
        },
        async execute(args, exec): Promise<JsonValue> {
            const session = resolveToolSession(cmisContext, exec)
            if (!session) {
                return { success: false, error: '当前会话未绑定用户身份，请通过终端连接后再使用' }
            }

            const { reportCode, page = 1, pageSize = 20, ...paramArgs } = args
            const report = findReport(reportCode)
            if (!report) {
                return {
                    success: false,
                    error: `未找到报表: ${reportCode}，请先调用 list_available_reports 获取可用报表编码`,
                }
            }

            const params = assembleParams(report, paramArgs as Record<string, unknown>)

            // 必填参数缺失时提示 LLM 向用户索要
            const missing = report.paramDefs.filter(
                (def) => def.required && params[def.name] === undefined,
            )
            if (missing.length > 0) {
                return {
                    success: false,
                    missingParams: missing.map((item) => ({
                        name: item.name,
                        label: item.label,
                        description: item.description ?? null,
                    })),
                    hint: `查询${report.reportName}缺少必填参数：${missing.map((item) => item.label).join('、')}。请向用户询问后再调用。`,
                }
            }

            // 缓存优先：命中直接返回
            let dataSource: 'cache' | 'realtime' = 'realtime'
            let cacheUpdatedAt: string | undefined
            let cachePeriod: string | undefined
            let rows: ReportRow[] = []
            let respPage: PageInfoLike | undefined
            let summary: Record<string, JsonValue> | null | undefined

            if (report.cache) {
                const cacheResult = await queryFromCache(
                    session.context,
                    report,
                    params,
                    paramArgs.startDate,
                    paramArgs.endDate,
                    page,
                    pageSize,
                    exec.signal,
                )
                if (cacheResult) {
                    dataSource = 'cache'
                    cacheUpdatedAt = cacheResult.updatedAt
                    cachePeriod = cacheResult.period
                    rows = cacheResult.rows
                    respPage = cacheResult.page
                    summary = cacheResult.summary
                }
            }

            // 回退实时查询
            if (dataSource === 'realtime') {
                let resp: SimpleReturn
                try {
                    resp = await queryReport(
                        session.context,
                        report.path,
                        params,
                        { currentPage: page, pageSize } satisfies PageParam,
                        exec.signal,
                    )
                } catch (error) {
                    return {
                        success: false,
                        error: `报表查询失败：${error instanceof Error ? error.message : String(error)}`,
                    }
                }
                if (markUnlogin(cmisContext, session, resp)) {
                    return unloginResult()
                }
                if (resp.flag !== ResponseFlag.SUCCESS) {
                    return {
                        success: false,
                        error: resp.message || '报表查询失败',
                    }
                }

                const data = resp.data
                rows = Array.isArray(data) ? data as ReportRow[] : data ? [data as ReportRow] : []
                respPage = resp.page as PageInfoLike | undefined
                summary = resp.sum && typeof resp.sum === 'object' && !Array.isArray(resp.sum)
                    ? resp.sum as Record<string, JsonValue>
                    : null
            }

            // markdown 表格给 LLM 组织回复（截断防止超长）
            const previewRows = rows.slice(0, MAX_ROWS_TO_LLM)
            const markdown = buildMarkdownTable(report.reportName, previewRows, report.columns, summary)
            const pageDesc = respPage
                ? `共 ${respPage.totalRows ?? rows.length} 行，当前第 ${respPage.currentPage}/${respPage.totalPages ?? 1} 页`
                : `共 ${rows.length} 行`
            const sourceDesc = dataSource === 'cache' && cacheUpdatedAt
                ? `数据来源：预计算缓存（${cachePeriod}），生成时间 ${cacheUpdatedAt}`
                : '数据来源：实时查询'

            return {
                success: true,
                reportName: report.reportName,
                dataSource,
                cacheUpdatedAt: cacheUpdatedAt ?? null,
                rowCount: rows.length,
                pageDesc,
                sourceDesc,
                markdown,
                hint:
                    rows.length > MAX_ROWS_TO_LLM
                        ? `结果较多，仅展示前 ${MAX_ROWS_TO_LLM} 行。完整数据已返回前端界面展示，回复中告知用户可在界面查看完整数据。回复中注明数据来源（缓存/实时）与生成时间。`
                        : '请基于表格数据做简要总结后回复用户，并注明数据来源（缓存/实时）与生成时间。',
                resultData: {
                    reportCode: report.reportCode,
                    reportName: report.reportName,
                    params,
                    columns: report.columns?.map((col): Record<string, JsonValue> => {
                        const out: Record<string, JsonValue> = { field: col.field, label: col.label }
                        if (col.format !== undefined) out.format = col.format
                        return out
                    }) ?? null,
                    rows,
                    summary: summary ?? null,
                    page: respPage
                        ? {
                            totalRows: respPage.totalRows ?? null,
                            currentPage: respPage.currentPage ?? null,
                            totalPages: respPage.totalPages ?? null,
                        }
                        : null,
                    dataSource,
                    cacheUpdatedAt: cacheUpdatedAt ?? null,
                } satisfies ReportResultData,
            }
        },
    })
}
