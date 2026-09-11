import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CmisContext } from '../src/context/index.ts'
import type { Config } from '../src/context/index.ts'
import type { CmisUser, SimpleReturn } from '../src/context/types.ts'
import { TurnTranslator } from '../src/gateway/bridge.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { findReport, reportRegistry } from '../src/report-tools/registry.ts'
import {
    assembleParams,
    buildMarkdownTable,
    businessParamMatch,
    dateRangeCovers,
    pickCacheDoc,
    toDayTime,
    createQueryReportTool,
} from '../src/report-tools/query-report.ts'
import type { CacheDocItem, ReportResultData } from '../src/report-tools/query-report.ts'
import { createGetReportSchemaTool } from '../src/report-tools/get-report-schema.ts'
import { createListAvailableReportsTool } from '../src/report-tools/list-available-reports.ts'
import { createListMyReportsTool } from '../src/report-tools/list-my-reports.ts'

const contextConfig: Config = {
    centerServer: 'https://center.test',
    centerAuthorization: 'Basic test-auth',
    userRefreshIntervalMs: 60000,
    tenants: [],
}

const testUser: CmisUser = {
    userId: 1,
    ticket: 'ticket-a',
    userType: 2,
    deptCode: 'D01',
    deptId: 11,
    deptType: 'shop',
}

const SESSION_ID = 'cmis-mall-001-user-1'

/** 构造工具执行上下文（绑定测试会话的 agent） */
function buildExec(sessionId: string = SESSION_ID): ToolRunContext {
    return {
        callId: 'call-1' as never,
        rootCallId: 'call-1' as never,
        name: 'query_report',
        arguments: {},
        agent: { id: SessionId(sessionId) },
        signal: new AbortController().signal,
    } as unknown as ToolRunContext
}

/** 按请求路径分发响应的 fetch 桩（记录调用供断言） */
function mockFetch(handler: (url: string, body: any) => SimpleReturn) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(init.headers ?? {})) {
            headers[key] = String(value)
        }
        calls.push({ url: String(url), body, headers })
        return {
            ok: true,
            headers: { get: () => null },
            json: async () => handler(String(url), body),
        } as any
    }) as any
    return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

async function createCmisContext(): Promise<CmisContext> {
    const ctx = new Context()
    await ctx.plugin(CmisContext, contextConfig)
    ctx.cmisContext.bind(SESSION_ID, {
        serviceIndex: 'mall-001',
        serviceUrl: 'https://mall.test',
        appUserId: 'user-1',
        ticket: 'ticket-a',
        user: testUser,
    })
    return ctx.cmisContext
}

function event(type: string, data: unknown): SessionEvent {
    return { type, seq: 0, time: 0, data } as SessionEvent
}

// ---- registry ----

test('registry：findReport 命中与未命中', () => {
    assert.equal(findReport('unsoldProduct')?.reportName, '滞销品报表')
    assert.equal(findReport('not-exist'), undefined)
    assert.equal(reportRegistry.length >= 12, true)
})

// ---- 纯函数 ----

test('toDayTime：日期归一到天粒度', () => {
    assert.equal(toDayTime('2026-08-17T15:30:00'), new Date(2026, 7, 17).getTime())
    assert.equal(toDayTime(undefined), null)
    assert.equal(toDayTime('invalid-date'), null)
})

test('businessParamMatch：业务参数一致（文档缺省按注册表默认值兜底）', () => {
    const report = findReport('unsoldProduct')!
    assert.equal(businessParamMatch({ startDate: '2026-08-17', unsoldDays: 30 }, { unsoldDays: 30 }, report), true)
    // 文档未记录 unsoldDays，按注册表默认值 30 兜底
    assert.equal(businessParamMatch({ startDate: '2026-08-17' }, { unsoldDays: 30 }, report), true)
    assert.equal(businessParamMatch({ unsoldDays: 60 }, { unsoldDays: 30 }, report), false)
    // 用户未提供的参数不约束
    assert.equal(businessParamMatch({ unsoldDays: 60 }, {}, report), true)
})

test('dateRangeCovers：请求日期需落在缓存文档区间内', () => {
    const docParams = { startDate: '2026-08-17', endDate: '2026-08-23' }
    assert.equal(dateRangeCovers(docParams, '2026-08-17', '2026-08-23'), true)
    assert.equal(dateRangeCovers(docParams, '2026-08-20', undefined), true)
    assert.equal(dateRangeCovers(docParams, '2026-08-16', '2026-08-20'), false)
    assert.equal(dateRangeCovers(docParams, undefined, undefined), true)
})

test('pickCacheDoc：业务参数一致 + 日期覆盖 + 生成时间最新', () => {
    const report = findReport('unsoldProduct')!
    const docs: CacheDocItem[] = [
        {
            docId: 'doc-old',
            reportName: 'buyer-unsold-product',
            mode: 'nested',
            period: 'weekly',
            cacheParams: { startDate: '2026-08-17', endDate: '2026-08-23' },
            updatedAt: '2026-08-24T06:00:00Z',
        },
        {
            docId: 'doc-new',
            reportName: 'buyer-unsold-product',
            mode: 'nested',
            period: 'weekly',
            cacheParams: { startDate: '2026-08-17', endDate: '2026-08-23' },
            updatedAt: '2026-08-25T06:00:00Z',
        },
        {
            docId: 'doc-mismatch',
            reportName: 'buyer-unsold-product',
            mode: 'nested',
            period: 'weekly',
            cacheParams: { startDate: '2026-08-10', endDate: '2026-08-16' },
            updatedAt: '2026-08-26T06:00:00Z',
        },
    ]
    assert.equal(pickCacheDoc(docs, report, {}, '2026-08-17', '2026-08-23')?.docId, 'doc-new')
    assert.equal(pickCacheDoc(docs, report, {}, '2026-08-01', '2026-08-05'), undefined)
})

test('buildMarkdownTable：行转 markdown 表格与空结果', () => {
    const markdown = buildMarkdownTable('滞销品报表', [
        { productCode: 'P001', productName: '可乐', stockQuantity: 10 },
        { productCode: 'P002', productName: '雪碧|1L', stockQuantity: 5 },
    ])
    assert.match(markdown, /^\| productCode \| productName \| stockQuantity \|$/m)
    assert.match(markdown, /\| P002 \| 雪碧\\\|1L \| 5 \|/)
    assert.equal(buildMarkdownTable('滞销品报表', []), '滞销品报表：查询结果为空')
})

test('assembleParams：只传注册表参数，必填缺省用默认值兜底', () => {
    const report = findReport('unsoldProduct')!
    const params = assembleParams(report, { startDate: '2026-08-17', endDate: '2026-08-23', hack: 'x' })
    assert.deepEqual(params, { startDate: '2026-08-17', endDate: '2026-08-23' })
})

// ---- query_report 工具 ----

test('query_report：缓存命中返回 cache 数据与 resultData', async () => {
    const cmisContext = await createCmisContext()
    const tool = createQueryReportTool(cmisContext)
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/agent/report/cacheList.do')) {
            return {
                flag: 1,
                data: [{
                    reportName: 'buyer-unsold-product',
                    docs: [{
                        docId: 'doc-1',
                        reportName: 'buyer-unsold-product',
                        mode: 'nested',
                        period: 'weekly',
                        cacheParams: { startDate: '2026-08-17', endDate: '2026-08-23' },
                        updatedAt: '2026-08-24T06:00:00Z',
                    }],
                }],
            }
        }
        if (url.endsWith('/agent/report/cacheQuery.do')) {
            return {
                flag: 1,
                data: { hit: true, data: [{ productCode: 'P001', productName: '可乐', stockQuantity: 10 }] },
                page: { totalRows: 1, currentPage: 1, totalPages: 1 },
            }
        }
        return { flag: 1, data: [] }
    })
    try {
        const result = await tool.execute(
            { reportCode: 'unsoldProduct', startDate: '2026-08-17', endDate: '2026-08-23' },
            buildExec(),
        ) as Record<string, unknown>

        assert.equal(result.success, true)
        assert.equal(result.dataSource, 'cache')
        assert.equal(result.cacheUpdatedAt, '2026-08-24T06:00:00Z')
        const resultData = result.resultData as ReportResultData
        assert.equal(resultData.dataSource, 'cache')
        assert.equal((resultData.rows as unknown[]).length, 1)

        // presentationMeta 投影结构化结果（gateway tool 事件回传前端）
        const meta = tool.output.presentationMeta?.({}, result as never) as unknown as ReportResultData
        assert.equal(meta.reportCode, 'unsoldProduct')
        assert.equal((meta.rows as unknown[]).length, 1)
    } finally {
        fetchStub.restore()
    }
})

test('query_report：缓存未命中回退实时查询', async () => {
    const cmisContext = await createCmisContext()
    const tool = createQueryReportTool(cmisContext)
    const fetchStub = mockFetch((url) => {
        if (url.endsWith('/agent/report/cacheList.do')) {
            return { flag: 1, data: [] }
        }
        if (url.includes('/simple-report/report/buyer/unsoldProductReport.do')) {
            return {
                flag: 1,
                data: [{ productCode: 'P002', productName: '雪碧', stockQuantity: 8 }],
                page: { totalRows: 1, currentPage: 1, totalPages: 1 },
            }
        }
        return { flag: 1, data: [] }
    })
    try {
        const result = await tool.execute(
            { reportCode: 'unsoldProduct', startDate: '2026-08-17', endDate: '2026-08-23' },
            buildExec(),
        ) as Record<string, unknown>

        assert.equal(result.success, true)
        assert.equal(result.dataSource, 'realtime')

        // 实时查询走 simple-report 前缀，携带 ticket 与分页头
        const realtimeCall = fetchStub.calls.find((call) => call.url.includes('/simple-report/report/buyer/unsoldProductReport.do'))
        assert.ok(realtimeCall, '应调用实时查询接口')
        assert.equal(realtimeCall.headers['Simple-Ticket'], 'ticket-a')
        assert.ok(realtimeCall.headers['Simple-Page'])
    } finally {
        fetchStub.restore()
    }
})

test('query_report：缺少必填参数返回 missingParams', async () => {
    const cmisContext = await createCmisContext()
    const tool = createQueryReportTool(cmisContext)
    const result = await tool.execute({ reportCode: 'costDiff' }, buildExec()) as Record<string, unknown>

    assert.equal(result.success, false)
    const missingParams = result.missingParams as { name: string }[]
    assert.deepEqual(missingParams.map((item) => item.name), ['startDate', 'endDate'])
})

test('query_report：未绑定会话身份时报错', async () => {
    const cmisContext = await createCmisContext()
    const tool = createQueryReportTool(cmisContext)
    const result = await tool.execute(
        { reportCode: 'unsoldProduct', startDate: '2026-08-17', endDate: '2026-08-23' },
        buildExec('cmis-other-session'),
    ) as Record<string, unknown>

    assert.equal(result.success, false)
    assert.match(String(result.error), /未绑定用户身份/)
})

test('query_report：未登录（flag=20）标记会话失效', async () => {
    const cmisContext = await createCmisContext()
    const tool = createQueryReportTool(cmisContext)
    const fetchStub = mockFetch(() => ({ flag: 20, message: '未登录' }))
    try {
        const result = await tool.execute(
            { reportCode: 'unsoldProduct', startDate: '2026-08-17', endDate: '2026-08-23' },
            buildExec(),
        ) as Record<string, unknown>

        assert.equal(result.success, false)
        assert.match(String(result.error), /重新登录/)
        assert.equal(cmisContext.get(SESSION_ID)?.invalid, true)
    } finally {
        fetchStub.restore()
    }
})

// ---- get_report_schema / list_available_reports / list_my_reports ----

test('get_report_schema：返回报表参数结构', async () => {
    const tool = createGetReportSchemaTool()
    const result = await tool.execute({ reportCode: 'unsoldProduct' }, buildExec()) as Record<string, unknown>

    assert.equal(result.success, true)
    const params = result.params as { name: string }[]
    assert.deepEqual(params.map((item) => item.name), ['startDate', 'endDate', 'unsoldDays', 'deptCode'])
})

test('get_report_schema：报表不存在时报错', async () => {
    const tool = createGetReportSchemaTool()
    const result = await tool.execute({ reportCode: 'not-exist' }, buildExec()) as Record<string, unknown>
    assert.equal(result.success, false)
})

test('list_available_reports：内置清单 + 订阅通知', async () => {
    const cmisContext = await createCmisContext()
    const tool = createListAvailableReportsTool(cmisContext)
    const fetchStub = mockFetch(() => ({
        flag: 1,
        data: [{ menuId: 1, menuName: '滞销品报表', title: '推送', content: '内容', readFlag: 0, sentAt: '2026-08-25T09:00:00Z' }],
    }))
    try {
        const result = await tool.execute({}, buildExec()) as Record<string, unknown>

        assert.equal(result.success, true)
        const commonReports = result.commonReports as { reportCode: string }[]
        assert.equal(commonReports.length, reportRegistry.length)
        assert.equal((result.subscribeReports as unknown[]).length, 1)
    } finally {
        fetchStub.restore()
    }
})

test('list_my_reports：未登录返回错误', async () => {
    const cmisContext = await createCmisContext()
    const tool = createListMyReportsTool(cmisContext)
    const fetchStub = mockFetch(() => ({ flag: 20, message: '未登录' }))
    try {
        const result = await tool.execute({}, buildExec()) as Record<string, unknown>
        assert.equal(result.success, false)
        assert.match(String(result.error), /重新登录/)
    } finally {
        fetchStub.restore()
    }
})

// ---- gateway 协议扩展：tool 事件携带 resultData ----

test('TurnTranslator：tool/result 的 meta 转译为 tool 事件 resultData', () => {
    const translator = new TurnTranslator(1)
    translator.translate(event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'query_report' }))
    const events = translator.translate(event('tool/result', {
        turn: 1,
        step: 1,
        message: { source: { callId: 'call-1' } },
        meta: {
            reportCode: 'unsoldProduct',
            reportName: '滞销品报表',
            params: {},
            rows: [{ productCode: 'P001' }],
            dataSource: 'cache',
        },
    }))
    assert.equal(events.length, 1)
    const toolEvent = events[0] as { type: string; name: string; state: string; resultData?: ReportResultData }
    assert.equal(toolEvent.type, 'tool')
    assert.equal(toolEvent.name, 'query_report')
    assert.equal(toolEvent.state, 'end')
    assert.equal(toolEvent.resultData?.reportCode, 'unsoldProduct')
    assert.equal((toolEvent.resultData?.rows as unknown[]).length, 1)
})

test('TurnTranslator：无 meta 的 tool/result 不携带 resultData', () => {
    const translator = new TurnTranslator(1)
    translator.translate(event('tool/call', { turn: 1, step: 1, callId: 'call-2', name: 'list_available_reports' }))
    const events = translator.translate(event('tool/result', {
        turn: 1,
        step: 1,
        message: { source: { callId: 'call-2' } },
    }))
    assert.equal(events.length, 1)
    const toolEvent = events[0] as { resultData?: unknown }
    assert.equal('resultData' in toolEvent, false)
})
