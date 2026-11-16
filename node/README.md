# Node 版

把 Mistral 的 Chat Completions 洗成标准 OpenAI 格式的本地代理。

转换逻辑与 [Go 版](../go/) 完全一致，区别只是运行时：需要 Node.js，不用编译。

## 和 Go 版的区别

| | Node 版 | [Go 版](../go/) |
|---|---|---|
| 依赖 | Node.js 18+ | 无 |
| 部署 | 需要 Node 环境 | 单文件二进制 |
| 配置 | 环境变量 | `config.json` |
| 内存 | ~50 MB | 8.7 MB 空载 |
| 适用 | 已有 Node 的机器 | 服务器首选 |

## 安装运行

```bash
node mistral-proxy.mjs
```

Windows 用户可双击 `start.bat`（需先改里面的代理地址）。

启动后：

- **Base URL**：`http://127.0.0.1:8787/v1`
- **API Key**：你的 Mistral key

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MISTRAL_BASE_URL` | `https://api.mistral.ai` | 上游地址 |
| `PORT` | `8787` | 监听端口 |
| `DEBUG` | 未设置 | 设为 `1` 打印转换细节 |
| `HTTPS_PROXY` | 未设置 | 访问 https 上游时的前置代理 |
| `HTTP_PROXY` | 未设置 | 访问 http 上游时的前置代理 |
| `ALL_PROXY` | 未设置 | 上面两个的兜底 |
| `NO_PROXY` | 未设置 | 逗号分隔，命中的主机直连 |

代理变量大小写都认。支持 `http://` 和 `https://` 代理，可带账号密码。

```bash
# 走本地代理
HTTPS_PROXY=http://127.0.0.1:7890 node mistral-proxy.mjs

# 连中转
MISTRAL_BASE_URL=https://your-relay.com node mistral-proxy.mjs
```

> **只支持 HTTP/HTTPS 代理，不支持 SOCKS5。** 填 `socks5://` 会提示并降级为直连。

## 测试

```bash
node test-transform.mjs   # 单元测试（25 项，不联网）
node test-e2e.mjs         # 端到端（起假上游，13 项）
node test-proxy.mjs       # 前置代理（起假代理，14 项）
```

## 转换规则

与 [Go 版](../go/README.md#转换规则) 一致：

**请求方向**
- 数组 content 压平为字符串（含 `image_url` / `document_url` 时保留数组）
- tool id 重写为 9 位字母数字，assistant 与 tool 消息同步
- `arguments` 对象 → JSON 字符串
- 剥掉 `reasoning_content`、`reasoning`、`name`、`logprobs`、`top_logprobs`、`logit_bias`、`store`、`metadata`、`service_tier`、`stream_options`
- `stream: true` 时补 `stream_options: {include_usage: true}`

**响应方向**
- `content` 数组 → 字符串
- `thinking` 分块 → `reasoning_content`（不混入正文）
- `arguments` 对象 → JSON 字符串

**其他路径**（`/v1/models`、`/v1/embeddings` 等）原样透传。

## 已知限制

- 只处理 `/v1/chat/completions`，其他路径透传
- 不支持 SOCKS5 代理
- 不支持 `br` / `zstd` 解压（Node 内置只支持 gzip/deflate）
- tool id 映射是单次请求内的，跨请求不保持
- 不做认证：任何能访问端口的人都能用它转发请求
