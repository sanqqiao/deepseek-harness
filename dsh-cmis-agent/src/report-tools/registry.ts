/**
 * 报表注册表：定义 AI 可查询的报表清单。
 * reportCode 为 query_report 工具的入参；path 为 cmis-report 的接口路径
 * （agent 经 mall 主系统 simple-report 前缀转发调用）。
 */
export interface ReportParamDef {
    name: string
    label: string
    type: 'string' | 'number'
    required: boolean
    description?: string
    defaultValue?: string | number | boolean | null
}

/**
 * 报表缓存配置：与 cmis-report 预计算缓存体系对齐。
 * query_report 优先按 reportName 定位预计算缓存文档，命中则直接读缓存。
 */
export interface ReportCacheConfig {
    /** cmis-report 缓存体系中的报表名（handler.name） */
    reportName: string
    /** 缓存模式：flat=扁平（行文档）/ nested=嵌套（map 文档） */
    mode: 'flat' | 'nested'
    /** 嵌套缓存中明细数组的字段名（如 items），nested 模式必填 */
    detailColumn?: string
}

export interface ReportDefinition {
    reportCode: string
    reportName: string
    category: string
    path: string
    description: string
    paramDefs: ReportParamDef[]
    cache?: ReportCacheConfig
}

const dateRangeParams: ReportParamDef[] = [
    { name: 'startDate', label: '开始日期', type: 'string', required: true, description: '格式 YYYY-MM-DD' },
    { name: 'endDate', label: '结束日期', type: 'string', required: true, description: '格式 YYYY-MM-DD' },
    { name: 'deptCode', label: '部门编码', type: 'string', required: false },
]

export const reportRegistry: ReportDefinition[] = [
    {
        reportCode: 'unsoldProduct',
        reportName: '滞销品报表',
        category: '关注单品',
        path: '/report/buyer/unsoldProductReport.do',
        description: '查询超过滞销天数仍有库存的商品，含批次、库存量、滞销天数明细',
        cache: { reportName: 'buyer-unsold-product', mode: 'nested', detailColumn: 'items' },
        paramDefs: [
            { name: 'startDate', label: '开始日期', type: 'string', required: true, description: '格式 YYYY-MM-DD' },
            { name: 'endDate', label: '结束日期', type: 'string', required: true, description: '格式 YYYY-MM-DD' },
            { name: 'unsoldDays', label: '滞销天数', type: 'number', required: false, defaultValue: 30, description: '默认30天' },
            { name: 'deptCode', label: '部门编码', type: 'string', required: false },
        ],
    },
    {
        reportCode: 'turnoverProduct',
        reportName: '高周转商品报表',
        category: '关注单品',
        path: '/report/buyer/turnoverProductReport.do',
        description: '查询高周转（快速动销）的商品',
        cache: { reportName: 'buyer-turnover-product', mode: 'nested', detailColumn: 'items' },
        paramDefs: [
            { name: 'turnoverDays', label: '周转天数', type: 'number', required: false, defaultValue: 60, description: '默认60天' },
            { name: 'deptCode', label: '部门编码', type: 'string', required: false },
        ],
    },
    {
        reportCode: 'newProduct',
        reportName: '新品报表',
        category: '关注单品',
        path: '/report/buyer/newProductReport.do',
        description: '查询近期新增的商品及其动销情况',
        cache: { reportName: 'buyer-new-product', mode: 'nested', detailColumn: 'items' },
        paramDefs: [
            { name: 'newProductDays', label: '新品天数', type: 'number', required: false, defaultValue: 90, description: '默认90天' },
            { name: 'deptCode', label: '部门编码', type: 'string', required: false },
        ],
    },
    {
        reportCode: 'soldoutProduct',
        reportName: '断货商品报表',
        category: '关注单品',
        path: '/report/buyer/soldoutProductReport.do',
        description: '查询已断货的商品',
        cache: { reportName: 'buyer-soldout-product', mode: 'nested', detailColumn: 'items' },
        paramDefs: [
            { name: 'deptCode', label: '部门编码', type: 'string', required: false },
        ],
    },
    {
        reportCode: 'outOfStockProduct',
        reportName: '缺货商品报表',
        category: '关注单品',
        path: '/report/buyer/outOfStockProductReport.do',
        description: '查询缺货的商品',
        cache: { reportName: 'buyer-out-of-stock-product', mode: 'nested', detailColumn: 'items' },
        paramDefs: [
            { name: 'deptCode', label: '部门编码', type: 'string', required: false },
        ],
    },
    {
        reportCode: 'turnoverAnalysis',
        reportName: '周转分析报表',
        category: '运转动态',
        path: '/report/buyer/turnoverAnalysisReport.do',
        description: '商品周转及动态分析',
        cache: { reportName: 'buyer-turnover-analysis', mode: 'flat' },
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'costDiff',
        reportName: '采购成本差异分析报表',
        category: '运转动态',
        path: '/report/buyer/costDiffReport.do',
        description: '分析采购成本差异',
        cache: { reportName: 'buyer-cost-diff', mode: 'flat' },
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'qtyDiff',
        reportName: '采购数量差异分析报表',
        category: '运转动态',
        path: '/report/buyer/qtyDiffReport.do',
        description: '分析采购数量差异',
        cache: { reportName: 'buyer-qty-diff', mode: 'flat' },
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'profitContribution',
        reportName: '采购毛利贡献报表',
        category: '效益',
        path: '/report/buyer/profitContributionReport.do',
        description: '分析采购毛利贡献',
        cache: { reportName: 'buyer-profit-contribution', mode: 'flat' },
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'supplierPerformance',
        reportName: '供应商经营效益报表',
        category: '效益',
        path: '/report/buyer/supplierPerformanceReport.do',
        description: '供应商经营概况与效益分析',
        cache: { reportName: 'buyer-supplier-performance', mode: 'nested', detailColumn: 'items' },
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'expiryWarning',
        reportName: '临期商品预警报表',
        category: '日常预警',
        path: '/report/buyer/expiryWarningReport.do',
        description: '临期商品预警',
        cache: { reportName: 'buyer-expiry-warning', mode: 'flat' },
        paramDefs: [
            { name: 'deptCode', label: '部门编码', type: 'string', required: false },
        ],
    },
    {
        reportCode: 'negativeProfitWarning',
        reportName: '负毛利预警报表',
        category: '日常预警',
        path: '/report/buyer/negativeProfitWarningReport.do',
        description: '负毛利（亏损销售）商品预警',
        cache: { reportName: 'buyer-negative-profit-warning', mode: 'flat' },
        paramDefs: dateRangeParams,
    },
]

export const findReport = (reportCode: string): ReportDefinition | undefined => {
    return reportRegistry.find((r) => r.reportCode === reportCode)
}
