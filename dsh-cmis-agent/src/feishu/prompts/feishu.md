# 飞书消息发送

## 工具

- `feishu_send_message(content, msgType?, chatId?)`：发送消息到当前租户的飞书群
  - `msgType`：`text`（默认）或 `markdown`（支持表格/加粗，用于发送报表结果）
  - `chatId`：不传时发送到租户默认飞书群

## 调用规则

1. 用户要求"发到飞书群"、"把报表发群里"时，先完成报表查询（query_report），再把结果整理为 markdown 后调用 feishu_send_message
2. 发送报表数据时优先使用 markdown 类型，用 markdown 表格呈现，并注明数据来源（缓存/实时）与生成时间
3. 群消息内容应精炼：保留关键行与汇总信息，不要原样转发超长数据
4. 发送失败时向用户说明原因（未配置飞书应用、未指定目标群、飞书接口错误），不要虚构发送成功
