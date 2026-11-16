# NewAPI 转换器插件

把 Mistral 的非标准 Chat Completions 洗成标准 OpenAI 格式，**直接在 NewAPI 内部跑**，不需要额外进程。

转换逻辑与 [Go 版](../go/) / [Node 版](../node/) 完全一致。

## 版本要求

**NewAPI rc50 或更高。**

`meta.relay` 字段和 `converter: "plugin"` 的转换器 hook 是 **rc50 才引入的**。在 rc41~rc49 上上传会报：

```
Plugin metadata contains an unknown field "relay".
```

## 和独立代理的区别

| | 本插件 | [Go 版](../go/) / [Node 版](../node/) |
|---|---|---|
| 部署 | 上传到 NewAPI 后台 | 单独跑一个进程 |
| 前置代理 | 用 NewAPI 渠道自带的代理设置 | 配置里指定 |
| 适用 | 仅 NewAPI | 任何 OpenAI 兼容客户端 |
| 请求路径 | 走 NewAPI 正常渠道 | 客户端连本地端口 |

## 安装

1. NewAPI 后台 → **管理员** → **任务插件**
2. 上传本目录的 `plugin.js`
3. 启用

上传时 NewAPI 会用自带的 JS 引擎编译一遍，有错会直接报出来。

## 配置渠道

插件通过 `converter: "plugin"` 路由接管 `/v1/chat/completions`：

- **类型**：Task Plugin（61）或 New API（60）
- **Base URL**：`https://api.mistral.ai`（或你的中转地址）
- **密钥**：你的 Mistral key
- **绑定插件**：`mistral-fix`

> **渠道类型不要选内置的「Mistral」**。那个类型的 `ConvertClaudeRequest` 是 `panic("implement me")`，用 Claude 格式调会直接 422。本插件走独立路由，不碰那个函数。

### 触发范围

插件只在**绑定了它的渠道**上生效，不是全局中间件。其他渠道完全不受影响。

路由配置是 `models: []`（空列表 = 该路径所有模型），所以**该渠道上任何模型都会触发**。因为渠道的 Base URL 已经锁定了 Mistral，不会误伤。

如果想更严格，可以给路由加白名单：

```js
relay: [{
  incoming_path: "/v1/chat/completions",
  upstream_path: "/v1/chat/completions",
  converter: "plugin",
  models: ["mistral-large-latest", "re:^deepseek-"],
}]
```

但没列出的模型会 fallback 到 NewAPI 默认逻辑，又会撞上数组 content 解析失败。**建议保持空列表。**

## 转换规则

### 请求方向（`convertRequest`）

- 数组 content 压平为字符串（含 `image_url` / `document_url` 时保留数组）
- tool id 重写为 9 位字母数字，assistant 与 tool 消息同步映射
- `arguments` 对象 → JSON 字符串
- 剥掉 `reasoning_content`、`reasoning`、`name`、`logprobs`、`top_logprobs`、`logit_bias`、`store`、`metadata`、`service_tier`、`stream_options`
- `stream: true` 时补 `stream_options: {include_usage: true}`

### 非流式响应（`convertResponse`）

- `message.content` 数组 → 字符串
- `thinking` 分块 → `reasoning_content`
- `arguments` 对象 → JSON 字符串
- 非 JSON 响应原样返回

### 流式响应（`convertStreamEvent`）

- 每个 chunk 的 `delta.content` 数组 → 字符串
- `thinking` 分块 → `reasoning_content`（累加）
- `[DONE]`、空 data、非 JSON 原样透传

## 测试

```bash
node test-plugin.mjs
```

46 项断言，覆盖 manifest 合法性、三个 hook 的契约与转换逻辑。

另外用 NewAPI 官方 JS 引擎（`jsplugin.CompilePlugin` + `CallConvertRequest` / `CallConvertResponse` / `CallConvertStreamEvent`）实际执行过，编译和运行时都通过。

## 已知限制

- **只接管 `/v1/chat/completions`**，其他路径走 NewAPI 默认逻辑
- **不支持 SOCKS 代理**（NewAPI 渠道设置本身也不支持，用 HTTP 代理）
- **tool id 映射是单次请求内的**，跨请求不保持
- **不能声明 `optional`** —— 那是「请求处理部分」的字段，转换器插件不支持，声明了会加载失败
- **需要 NewAPI rc50+**
