# mistral-proxy

把 **Mistral 的 Chat Completions** 洗成**标准 OpenAI 格式**的转换代理。

解决 Mistral 与标准 OpenAI 的 4 处不兼容，让 NewAPI、Claude Code 等 OpenAI 兼容客户端能正常使用 Mistral 及其托管模型（DeepSeek、GLM 等）。

提供三种实现，转换逻辑完全一致，按部署环境任选其一。

---

## 问题

Mistral 的 Chat Completions 与标准 OpenAI 有 4 处差异：

| # | Mistral 行为 | 标准 OpenAI | 症状 |
|---|---|---|---|
| 1 | 流式 `delta.content` 是数组 `[{type:"text",text:"..."}]` | 字符串 | `cannot unmarshal array into ... of type string`，每条 chunk 刷屏 |
| 2 | `{type:"thinking"}` 分块混在 content 数组里 | 无此概念 | 正文丢失或解析失败 |
| 3 | `tool_calls[].function.arguments` 可能是对象 | JSON 字符串 | 解析失败 |
| 4 | tool id 必须是 9 位字母数字 | 无限制 | Claude Code 的 `toolu_xxx` 被拒 → HTTP 422 |

此外，Mistral 对未知字段是 `extra_forbidden`，assistant 历史里带 `reasoning_content` 会整条 422。

---

## 三种实现

| | [Go 版](go/) | [Node 版](node/) | [NewAPI 插件](newapi-plugin/) |
|---|---|---|---|
| **推荐度** | ⭐ 首选 | 备选 | 有条件 |
| **依赖** | 无（单文件二进制） | Node.js 18+ | NewAPI ≥ rc50 |
| **部署** | 上传即跑 | `node mistral-proxy.mjs` | 后台上传 `plugin.js` |
| **代理配置** | `config.json` | 环境变量 | NewAPI 渠道设置 |
| **适用** | 任何环境 | 已有 Node 的机器 | 只想在 NewAPI 内部解决 |

### 怎么选

- **服务器部署** → [Go 版](go/)。单文件、零依赖、静态链接，扔上去就能跑。
- **本地已有 Node** → [Node 版](node/)。不用编译。
- **不想多跑一个进程** → [NewAPI 插件](newapi-plugin/)。但需要 NewAPI **rc50 或更高**（`relay` 字段和转换器 hook 是 rc50 引入的，rc41~rc49 会报 `unknown field "relay"`）。

---

## 快速开始（Go 版）

```bash
# 1. 确认架构
uname -m          # x86_64 → amd64；aarch64 → arm64

# 2. 上传对应版本
scp mistral-proxy-linux-arm64 user@server:/opt/mistral-proxy/mistral-proxy
ssh user@server 'chmod +x /opt/mistral-proxy/mistral-proxy'

# 3. 首次运行，自动生成 config.json
ssh user@server '/opt/mistral-proxy/mistral-proxy'
```

改配置后重启即可。完整说明见 [go/README.md](go/README.md)。

客户端配置：

- **Base URL**：`http://你的地址:8787/v1`
- **API Key**：你的 Mistral key（原样透传给上游）

---

## 转换规则

三种实现行为一致。

### 请求方向

| 处理 | 说明 |
|---|---|
| 数组 content 压平 | 含 `image_url` / `document_url` 时**保留数组**，避免多模态丢失 |
| tool id 重写 | 非 9 位字母数字的 id 重新生成，assistant 与 tool 消息同步映射 |
| `arguments` 转字符串 | 对象 → JSON 字符串 |
| 剥离字段 | `reasoning_content`、`reasoning`、`name`、`logprobs`、`top_logprobs`、`logit_bias`、`store`、`metadata`、`service_tier`、`stream_options` |
| 补 usage | `stream: true` 时设 `stream_options: {include_usage: true}` |

### 响应方向

| 处理 | 说明 |
|---|---|
| `content` 数组 → 字符串 | 只拼 `type: "text"` 的分块 |
| `thinking` 分块 → `reasoning_content` | **不混入正文**，多轮累加 |
| `arguments` 对象 → 字符串 | 非流式和流式都处理 |

### 其他路径

`/v1/models`、`/v1/embeddings` 等**原样透传**，不做任何转换。

---

## 设计原则

**只转换内容，认证信息原样透传。**

`Authorization`、`x-api-key` 等认证头从客户端到上游全程原样转发，不解析、不修改、不记录、不落盘。

代理不做认证、不做限流、不做缓存。部署时请用监听地址和防火墙控制访问来源。

---

## 背景

本项目的由来：

- **cc-switch issue [#9385](https://github.com/farion1231/cc-switch/issues/9385)** —— Mistral 托管 DeepSeek 时 `reasoning_content` 导致 422
- **cc-switch `claude_reasoning.rs:74`** —— 注释已指出问题：
  > Mistral 开推理后流式 `content` 是 thinking / text 分块数组，转换层还不解析（正文会丢）
- **NewAPI `relaykit/dto/openai_response.go:89`** —— `Content *string` 写死，无自定义 `UnmarshalJSON`
- **NewAPI `relay/channel/mistral/adaptor.go:27`** —— `ConvertClaudeRequest` 是 `panic("implement me")`，用内置 Mistral 渠道类型 + Claude 格式必崩
- **Mistral 官方 schema**（[`client-python`](https://github.com/mistralai/client-python)）：
  - `DeltaMessageContent = str | List[ContentChunk]`
  - `ContentChunk = ImageURLChunk | DocumentURLChunk | TextChunk | ReferenceChunk | FileChunk | ThinkChunk`
  - `ThinkChunk.thinking: List[Thinking]`

---

## 目录结构

```
mistral-proxy/
├── go/                  Go 版（推荐）
│   ├── main.go
│   ├── main_test.go
│   ├── e2e_test.go
│   ├── config.example.json
│   ├── go.mod
│   └── README.md
├── node/                Node 版
│   ├── mistral-proxy.mjs
│   ├── test-transform.mjs
│   ├── test-e2e.mjs
│   ├── test-proxy.mjs
│   ├── start.bat
│   └── README.md
├── newapi-plugin/       NewAPI 转换器插件
│   ├── plugin.js
│   ├── test-plugin.mjs
│   └── README.md
├── LICENSE
└── README.md
```

---

## 许可证

[MIT](LICENSE)
