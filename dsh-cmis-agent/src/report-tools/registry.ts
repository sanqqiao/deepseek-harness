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

/**
 * 报表列定义：中文名与数值格式（投影给前端做表头/格式化，markdown 表头用中文名）。
 * format: money=金额（分→元）、qty=数量（保留2位）、days=天数、ratio=比率、text=文本/日期原样
 */
export interface ReportColumnDef {
    field: string
    label: string
    format?: 'money' | 'qty' | 'days' | 'ratio' | 'text'
}

/** 共享字段字典（多报表复用） */
export const columnDict: Record<string, ReportColumnDef> = {
    productId: { field: 'productId', label: '商品ID' },
    productCode: { field: 'productCode', label: '商品编码' },
    productName: { field: 'productName', label: '商品名称' },
    barcode: { field: 'barcode', label: '条码' },
    classCode: { field: 'classCode', label: '类别编码' },
    className: { field: 'className', label: '类别' },
    brandName: { field: 'brandName', label: '品牌' },
    quantityUnit: { field: 'quantityUnit', label: '单位' },
    shopId: { field: 'shopId', label: '门店ID' },
    shopName: { field: 'shopName', label: '门店' },
    deptId: { field: 'deptId', label: '部门ID' },
    deptCode: { field: 'deptCode', label: '部门编码' },
    deptName: { field: 'deptName', label: '部门' },
    supplierCode: { field: 'supplierCode', label: '供应商编码' },
    supplierName: { field: 'supplierName', label: '供应商' },
    totalQuantity: { field: 'totalQuantity', label: '总库存量', format: 'qty' },
    totalBatchCount: { field: 'totalBatchCount', label: '批次数' },
    minBatchDate: { field: 'minBatchDate', label: '最早批次日期' },
    maxBatchDate: { field: 'maxBatchDate', label: '最晚批次日期' },
    unsoldDays: { field: 'unsoldDays', label: '滞销天数', format: 'days' },
    turnoverDays: { field: 'turnoverDays', label: '周转天数', format: 'days' },
    newProductDays: { field: 'newProductDays', label: '新品天数', format: 'days' },
    batchno: { field: 'batchno', label: '批号' },
    batchDate: { field: 'batchDate', label: '生产日期' },
    inputDate: { field: 'inputDate', label: '入库日期' },
    nowQuantity: { field: 'nowQuantity', label: '当前库存', format: 'qty' },
    cost: { field: 'cost', label: '成本单价', format: 'money' },
    saleMoney: { field: 'saleMoney', label: '销售额', format: 'money' },
    saleQty: { field: 'saleQty', label: '销售数量', format: 'qty' },
    saleCount: { field: 'saleCount', label: '销售次数' },
    costMoney: { field: 'costMoney', label: '成本额', format: 'money' },
    profit: { field: 'profit', label: '毛利', format: 'money' },
    profitRate: { field: 'profitRate', label: '毛利率', format: 'ratio' },
    totalSaleMoney: { field: 'totalSaleMoney', label: '总销售额', format: 'money' },
    totalSaleQty: { field: 'totalSaleQty', label: '总销售量', format: 'qty' },
    totalCostMoney: { field: 'totalCostMoney', label: '总成本额', format: 'money' },
    totalProfit: { field: 'totalProfit', label: '总毛利', format: 'money' },
    avgCost: { field: 'avgCost', label: '平均成本', format: 'money' },
    lastCost: { field: 'lastCost', label: '最近成本', format: 'money' },
    purchaseQty: { field: 'purchaseQty', label: '采购量', format: 'money' },
    purchaseMoney: { field: 'purchaseMoney', label: '采购额', format: 'money' },
    diffQty: { field: 'diffQty', label: '数量差异', format: 'qty' },
    diffMoney: { field: 'diffMoney', label: '金额差异', format: 'money' },
    diffRate: { field: 'diffRate', label: '差异率', format: 'ratio' },
    lossMoney: { field: 'lossMoney', label: '报损金额', format: 'money' },
    totalLoss: { field: 'totalLoss', label: '报损合计', format: 'money' },
    comprehensiveProfit: { field: 'comprehensiveProfit', label: '综合毛利', format: 'money' },
    expiryDate: { field: 'expiryDate', label: '到期日期' },
    expiryDays: { field: 'expiryDays', label: '距到期天数', format: 'days' },
    accountDate: { field: 'accountDate', label: '日期' },
}

/** 从共享字典取列定义（缺省生成仅含 field 的兜底定义） */
const cols = (...fields: string[]): ReportColumnDef[] =>
    fields.map((field) => columnDict[field] ?? { field, label: field })

export interface ReportDefinition {
    reportCode: string
    reportName: string
    category: string
    path: string
    description: string
    paramDefs: ReportParamDef[]
    /** 列定义（中文表头与格式化），列序即展示序 */
    columns?: ReportColumnDef[]
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
        columns: cols('productCode', 'productName', 'barcode', 'className', 'brandName', 'quantityUnit', 'totalQuantity', 'totalBatchCount', 'unsoldDays', 'minBatchDate'),
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
        columns: cols('productCode', 'productName', 'barcode', 'className', 'brandName', 'quantityUnit', 'saleQty', 'saleMoney', 'profit', 'turnoverDays'),
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
        columns: cols('productCode', 'productName', 'barcode', 'className', 'brandName', 'quantityUnit', 'saleQty', 'saleMoney', 'totalQuantity'),
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
        columns: cols('productCode', 'productName', 'barcode', 'className', 'brandName', 'quantityUnit', 'totalQuantity', 'unsoldDays'),
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
        columns: cols('productCode', 'productName', 'barcode', 'className', 'brandName', 'quantityUnit', 'saleQty', 'saleMoney'),
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
        columns: cols('className', 'brandName', 'totalSaleQty', 'totalSaleMoney', 'totalCostMoney', 'totalProfit', 'turnoverDays'),
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'costDiff',
        reportName: '采购成本差异分析报表',
        category: '运转动态',
        path: '/report/buyer/costDiffReport.do',
        description: '分析采购成本差异',
        cache: { reportName: 'buyer-cost-diff', mode: 'flat' },
        columns: cols('productCode', 'productName', 'supplierName', 'avgCost', 'lastCost', 'purchaseMoney', 'diffMoney', 'diffRate'),
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'qtyDiff',
        reportName: '采购数量差异分析报表',
        category: '运转动态',
        path: '/report/buyer/qtyDiffReport.do',
        description: '分析采购数量差异',
        cache: { reportName: 'buyer-qty-diff', mode: 'flat' },
        columns: cols('productCode', 'productName', 'supplierName', 'totalSaleQty', 'purchaseQty', 'diffQty', 'diffRate'),
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'profitContribution',
        reportName: '采购毛利贡献报表',
        category: '效益',
        path: '/report/buyer/profitContributionReport.do',
        description: '分析采购毛利贡献',
        cache: { reportName: 'buyer-profit-contribution', mode: 'flat' },
        columns: cols('className', 'totalSaleMoney', 'comprehensiveProfit', 'profit', 'totalLoss', 'profitRate'),
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'supplierPerformance',
        reportName: '供应商经营效益报表',
        category: '效益',
        path: '/report/buyer/supplierPerformanceReport.do',
        description: '供应商经营概况与效益分析',
        cache: { reportName: 'buyer-supplier-performance', mode: 'nested', detailColumn: 'items' },
        columns: cols('supplierCode', 'supplierName', 'totalSaleMoney', 'totalSaleQty', 'totalProfit', 'profitRate', 'turnoverDays'),
        paramDefs: dateRangeParams,
    },
    {
        reportCode: 'expiryWarning',
        reportName: '临期商品预警报表',
        category: '日常预警',
        path: '/report/buyer/expiryWarningReport.do',
        description: '临期商品预警',
        cache: { reportName: 'buyer-expiry-warning', mode: 'flat' },
        columns: cols('productCode', 'productName', 'barcode', 'className', 'brandName', 'quantityUnit', 'batchno', 'batchDate', 'expiryDays', 'nowQuantity'),
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
        columns: cols('productCode', 'productName', 'className', 'brandName', 'saleQty', 'saleMoney', 'costMoney', 'profit', 'profitRate'),
        paramDefs: dateRangeParams,
    },
]

export const findReport = (reportCode: string): ReportDefinition | undefined => {
    return reportRegistry.find((r) => r.reportCode === reportCode)
}
