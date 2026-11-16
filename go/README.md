# Mistral → 标准 OpenAI 内容转换代理

单文件二进制，**零第三方依赖**，只做一件事：把 Mistral 的非标准响应内容洗成标准 OpenAI 格式。

认证信息（`Authorization`、`x-api-key` 等）全程原样透传，不解析、不修改、不记录。

---

## 目录

- [为什么需要它](#为什么需要它)
- [职责边界](#职责边界)
- [快速开始](#快速开始)
- [配置](#配置)
- [客户端配置](#客户端配置)
- [systemd 常驻](#systemd-常驻)
- [转换规则](#转换规则)
- [HTTP 压缩处理](#http-压缩处理)
- [常见问题](#常见问题)
- [测试](#测试)
- [重新编译](#重新编译)
- [已知限制](#已知限制)

---

## 为什么需要它

Mistral 的 Chat Completions 与标准 OpenAI 有 4 处不兼容，会让 NewAPI 等 OpenAI 兼容客户端解析失败或让上游拒绝请求：

| # | Mistral 行为 | 标准 OpenAI | 症状 |
|---|---|---|---|
| 1 | 流式 `delta.content` 是数组 `[{type:"text",text:"..."}]` | 字符串 | `cannot unmarshal array into ... of type string`，每条 chunk 刷屏 |
| 2 | `{type:"thinking"}` 分块混在 content 数组里 | 无此概念 | 正文丢失或解析失败 |
| 3 | `tool_calls[].function.arguments` 可能是对象 | JSON 字符串 | 解析失败 |
| 4 | tool id 必须是 9 位字母数字 | 无限制 | Claude Code 的 `toolu_xxx` 被拒 → 422 |

本代理在中间做双向转换，让客户端以为自己在跟标准 OpenAI 服务对话。

---

## 职责边界

| 做 | 不做 |
|---|---|
| 转换 Mistral 的非标准响应内容 | 不解析、不修改、不记录 API key |
| 修正 tool call id 格式 | 不校验、不替换认证头 |
| 剥离上游不认的字段 | 不缓存、不落盘任何请求内容 |
| 处理 HTTP 压缩（解压兜底） | 不做认证、不做限流 |

---

## 快速开始

### 1. 确认服务器架构

```bash
uname -m
```

| 输出 | 用哪个文件 |
|---|---|
| `x86_64` | `mistral-proxy-linux-amd64` |
| `aarch64` / `arm64` | `mistral-proxy-linux-arm64` |

> **传错架构会报 `failed to create new OS thread (errno=11)`**，因为 amd64 二进制在 ARM 上要靠 qemu 模拟，额外消耗线程配额。

### 2. 上传并运行

```bash
scp mistral-proxy-linux-arm64 user@server:/opt/mistral-proxy/mistral-proxy
ssh user@server 'chmod +x /opt/mistral-proxy/mistral-proxy && /opt/mistral-proxy/mistral-proxy'
```

首次运行会在**可执行文件同目录**生成 `config.json`，然后启动服务。

### 3. 修改配置

```bash
vi /opt/mistral-proxy/config.json
```

### 4. 验证

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer 你的key"
```

能返回模型列表就说明通了。

---

## 配置

配置文件默认在**可执行文件同目录**的 `config.json`，首次运行自动生成。

也可用 `-config` 参数或 `CONFIG` 环境变量指定路径：

```bash
./mistral-proxy -config /etc/mistral-proxy/config.json
```

### 完整配置

```json
{
  "listen": "127.0.0.1:8787",
  "upstream": "https://api.mistral.ai",
  "proxy": "",
  "verbose": false,
  "timeout": 0
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `listen` | string | `127.0.0.1:8787` | 监听地址 |
| `upstream` | string | `https://api.mistral.ai` | 上游地址，可指向官方或任何兼容中转 |
| `proxy` | string | `""` | 前置代理，如 `http://127.0.0.1:7890`；留空直连 |
| `verbose` | bool | `false` | 打印路径和耗时（**不含**任何请求内容） |
| `timeout` | int | `0` | 上游超时秒数；`0` 不限制，流式长对话建议保持 0 |

### `listen` 怎么选

| 场景 | 值 |
|---|---|
| NewAPI 和代理**同机** | `127.0.0.1:8787`（默认，最安全） |
| NewAPI 和代理**不同机** | `0.0.0.0:8787` + 防火墙限制来源 IP |

> **代理本身不做认证**。暴露到公网等于把你的 Mistral key 借给所有人用。跨机部署务必配防火墙。

### `proxy` 怎么填

必须带协议前缀：

```json
"proxy": "http://127.0.0.1:7890"
```

只写 `127.0.0.1:7890` 会解析失败，启动时打警告并降级为直连。

**只支持 HTTP/HTTPS 代理，不支持 SOCKS5。** 填 `socks5://` 会提示并降级为直连。Clash 的混合端口（默认 `7890`）两种协议都支持，用它就行。

代理地址可带账号密码，日志里会自动打码：

```json
"proxy": "http://user:pass@127.0.0.1:7890"
```

启动日志显示 `前置代理: http://***@127.0.0.1:7890`。

### 配置示例

**国内直连 + 走本地代理：**

```json
{
  "listen": "127.0.0.1:8787",
  "upstream": "https://api.mistral.ai",
  "proxy": "http://127.0.0.1:7890",
  "verbose": false,
  "timeout": 0
}
```

**连国内中转，不需要代理：**

```json
{
  "listen": "127.0.0.1:8787",
  "upstream": "https://your-relay.example.com",
  "proxy": "",
  "verbose": false,
  "timeout": 0
}
```

**跨机部署：**

```json
{
  "listen": "0.0.0.0:8787",
  "upstream": "https://api.mistral.ai",
  "proxy": "http://127.0.0.1:7890",
  "verbose": false,
  "timeout": 0
}
```

---

## 客户端配置

在 NewAPI / Claude Code / 任何 OpenAI 兼容客户端里：

- **Base URL**：`http://你的地址:8787/v1`
- **API Key**：你的 Mistral key（原样透传给上游）

路径前缀会自动补全，`/chat/completions` 和 `/v1/chat/completions` 都能用。

---

## systemd 常驻

```bash
sudo tee /etc/systemd/system/mistral-proxy.service > /dev/null <<'EOF'
[Unit]
Description=Mistral to OpenAI transform proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/mistral-proxy/mistral-proxy
WorkingDirectory=/opt/mistral-proxy
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/mistral-proxy

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now mistral-proxy
sudo systemctl status mistral-proxy
```

查看日志：

```bash
journalctl -u mistral-proxy -f
```

---

## 转换规则

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

## HTTP 压缩处理

### 为什么需要处理

`\x1f` 是 gzip 数据的第一个字节（magic number `1f 8b`）。如果上游压缩了响应而代理不解压，`json.Unmarshal` 会报：

```
invalid character '\x1f' looking for beginning of value
```

### 处理策略

**1. 请求侧强制 `identity`**

```go
if isChat {
    req.Header.Set("Accept-Encoding", "identity")
}
```

不转发客户端的 `Accept-Encoding`，改为显式声明「不压缩」。比删除更明确——有些服务器在没收到该头时会用默认行为（可能压缩）。

**2. 响应侧兜底解压**

个别中转会无视 `identity` 仍然压缩。代理按 `Content-Encoding` 逐层解压：

| 编码 | 支持 |
|---|---|
| `gzip` / `x-gzip` | ✅ |
| `deflate` | ✅ |
| `identity` / 空 | ✅ 原样 |
| `br` / `zstd` | ❌ 返回明确错误 |

**3. 堆叠编码**

`Content-Encoding: gzip, deflate` 这种按**逆序**解压（编码从左到右应用，解压从右往左）。

**4. zip bomb 防护**

解压输出上限 64 MB，超过直接报错，防止「压缩 1KB 解压出 1GB」。

### 为什么不支持 br/zstd

Go 标准库没有解码器，引入第三方库会导致：

- 二进制从 6.4 MB 涨到 9 MB
- `go.mod` 不再是单行，`go.sum` 出现
- 编译需要联网拉依赖（国内可能失败）
- 多一个供应链风险

强制 `identity` 后，正常情况根本不会触发解压路径。真遇到 br/zstd，返回明确错误比默默解压更好排查。

---

## 常见问题

### `failed to create new OS thread (errno=11)`

**原因**：传错架构（amd64 二进制跑在 ARM 上，靠 qemu 模拟消耗额外线程），或服务器进程数配额太小。

**解决**：

```bash
# 1. 确认架构
uname -m

# 2. 换对应版本后如果还报，提高配额
ulimit -u 4096

# 永久生效：/etc/security/limits.conf 加
# *    soft    nproc    4096
# *    hard    nproc    8192
```

systemd 部署的话在 service 文件加：

```ini
[Service]
LimitNPROC=4096
```

### `invalid character '\x1f' looking for beginning of value`

**原因**：上游返回了 gzip 压缩数据但没被解压。

**解决**：用带压缩处理的版本（当前版本已包含）。如果还报，开 `verbose: true` 看日志确认 `Content-Encoding` 是什么——如果是 `br` 或 `zstd`，需要改成 gzip 或联系中转方。

### 连不上 / 502

按顺序排查：

```bash
# 1. 代理是否在跑
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer 你的key"

# 2. 前置代理是否可用
curl -x http://127.0.0.1:7890 https://api.mistral.ai/v1/models \
  -H "Authorization: Bearer 你的key"

# 3. 监听地址对不对
ss -tlnp | grep 8787
```

### 显示 `前置代理: 直连` 但配置里填了 proxy

三种可能：

1. 配置文件名/路径不对（默认是可执行文件同目录的 `config.json`）
2. JSON 格式错误（启动时会报 `解析配置 ...`）
3. `proxy` 值没有 `http://` 前缀

### 内存占用

实测（Windows，仅供参考）：

| 场景 | WorkingSet |
|---|---|
| 空载 | 8.7 MB |
| 20 并发 × 5 轮流式（100 请求） | 19 MB（稳定，无增长） |

8.7 MB 是 Go 运行时的基线，压不下去。19 MB 对服务器程序来说很小，不用优化。

---

## 测试

```bash
go test ./... -v
```

### 测试覆盖

**`main_test.go`（单元测试）**

- `TestFlattenContent` —— content 拍平的 7 种情况
- `TestIsMistralID` —— id 格式判断
- `TestTransformRequestToolCalls` —— tool id 重写 + 同步映射
- `TestTransformRequestStripsFields` —— 字段剥离
- `TestTransformRequestMultimodal` —— 多模态保留
- `TestTransformResponse` —— 非流式转换
- `TestTransformChunk` / `TestTransformChunkThinkingAccumulates` —— 流式转换 + thinking 累加
- `TestTransformChunkEdges` —— 边界情况
- `TestRewriteEvent` / `TestRewriteEventPassthrough` / `TestRewriteEventMultiLine` —— SSE 事件改写
- `TestSplitCodings` —— 编码声明解析
- `TestDecompressBodyStacked` —— gzip + deflate 双层解压
- `TestDecompressBodyUnsupported` —— br/zstd 报错
- `TestDecompressBodyIdentity` —— 不压缩时原样
- `TestReadAllLimited` —— 解压上限边界
- `TestMaskProxy` —— 代理密码打码

**`e2e_test.go`（端到端，起假上游）**

- `TestE2EStream` —— 流式转换，验证正文不含 thinking
- `TestE2ENonStream` —— 非流式转换
- `TestE2ERequestStripsReasoning` —— reasoning_content 剥离（否则上游 422）
- `TestE2EAuthPassthrough` —— **认证头原样透传**（Bearer / 特殊字符 / 无认证）
- `TestE2EUpstreamDown` —— 上游不可达返回 502 不挂住
- `TestE2ENonChatPassthrough` —— 非 chat 路径透传
- `TestE2EPathNormalization` —— 路径前缀自动补全
- `TestE2EGzipUpstream` —— 上游强压 gzip 时正确解压
- `TestE2EAcceptEncodingIdentity` —— 上游收到的是 `identity`

---

## 重新编译

```bash
# Linux amd64（服务器最常见）
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o mistral-proxy-linux-amd64 .

# Linux arm64（ARM 云服务器、树莓派）
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o mistral-proxy-linux-arm64 .

# Windows
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o mistral-proxy-windows-amd64.exe .
```

| 参数 | 作用 |
|---|---|
| `CGO_ENABLED=0` | 静态链接，不依赖服务器 glibc 版本 |
| `-s` | 去掉符号表 |
| `-w` | 去掉 DWARF 调试信息 |

`-s -w` 只影响体积（9.2 MB → 6.5 MB），不影响运行时性能。

### 依赖验证

```bash
$ cat go.mod
module mistralproxy

go 1.21

$ go list -m all
mistralproxy

$ go list -f '{{join .Imports "\n"}}' . | grep '\.'
（无输出）
```

**零第三方依赖**，全部标准库。

---

## 已知限制

- 只处理 `/v1/chat/completions`，其他路径透传
- 不支持 SOCKS 代理（只支持 HTTP/HTTPS）
- 不支持 `br` / `zstd` 解压（保持零依赖）
- tool id 映射是**单次请求内**的，跨请求不保持
- 不做认证：任何能访问端口的人都能用它转发请求，请用 `listen` 和防火墙控制访问来源
- 不做限流、不做缓存

---

## 相关背景

本项目的由来：

- **cc-switch issue #9385** —— Mistral 托管 DeepSeek 时 `reasoning_content` 导致 422
- **cc-switch `claude_reasoning.rs:74`** —— 注释已指出问题：
  > Mistral 开推理后流式 `content` 是 thinking / text 分块数组，转换层还不解析（正文会丢）
- **NewAPI `relaykit/dto/openai_response.go:89`** —— `Content *string` 写死，无自定义 `UnmarshalJSON`
- **NewAPI `relay/channel/mistral/adaptor.go:27`** —— `ConvertClaudeRequest` 是 `panic("implement me")`，用 Mistral 渠道类型 + Claude 格式必崩
- **Mistral 官方 schema**（`client-python`）：
  - `DeltaMessageContent = str | List[ContentChunk]`
  - `ContentChunk = ImageURLChunk | DocumentURLChunk | TextChunk | ReferenceChunk | FileChunk | ThinkChunk`
  - `ThinkChunk.thinking: List[Thinking]`
