/** 中心服务/业务系统统一响应结构（SimpleReturn）的 flag 值 */
export const ResponseFlag = {
    SUCCESS: 1,
    UNLOGIN: 20,
} as const

/** 中心服务/业务系统统一响应结构 */
export interface SimpleReturn<T = unknown> {
    flag: number
    message?: string
    data?: T
    /** 汇总数据（报表查询返回） */
    sum?: unknown
    /** 分页信息（报表查询返回：currentPage/pageSize/totalRows/totalPages） */
    page?: unknown
}

/** CMIS 用户信息（getUserByTicket 返回） */
export interface CmisUser {
    id?: number
    userId: number
    ticket: string
    userCode?: string
    userName?: string
    userType: number
    deptCode: string
    deptName?: string
    deptId: number
    deptType: string
    shopCode?: string
    shopName?: string
}

/** 租户飞书应用凭证 */
export interface TenantFeishuConfig {
    appId: string
    appSecret: string
    defaultChatId?: string
}

/** 租户配置 */
export interface TenantConfig {
    serviceIndex: string
    feishu?: TenantFeishuConfig
}

/** 会话上下文：DSH 会话（sessionId）→ 租户/用户身份绑定 */
export interface SessionContext {
    serviceIndex: string
    serviceUrl: string
    /** 终端应用用户标识（连接头 app-user-id，在线用户表与刷新判断的关联键） */
    appUserId: string
    ticket: string
    user: CmisUser
    /** 会话级门店上下文（deptCode 切换时更新） */
    lastShopCode?: string
    lastShopId?: number
    /** ticket 失效标记（flag=20 时置位，等待终端重新鉴权） */
    invalid?: boolean
}

/** 在线用户记录（连接级，按 serviceIndex + appUserId 维度） */
export interface OnlineUserRecord {
    serviceIndex: string
    appUserId: string
    userName?: string
    lastActiveAt: number
}
