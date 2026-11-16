/**
 * Mistral → 标准 OpenAI 转换代理
 *
 * 解决的问题：Mistral 的 Chat Completions 与标准 OpenAI 格式有 4 处不兼容，
 * 会让 NewAPI / 各类 OpenAI 兼容客户端解析失败：
 *
 *   1. 流式 delta.content 是数组（[{type:"text",text:"..."}]）而不是字符串
 *      → Go 客户端报 "cannot unmarshal array into ... of type string"
 *   2. 推理内容以 {type:"thinking", thinking:[...]} 分块混在 content 数组里
 *      → 标准客户端不认识，正文可能被丢弃
 *   3. tool_calls[].function.arguments 可能是对象而不是 JSON 字符串
 *      → 标准客户端解析失败
 *   4. tool_calls[].id 必须是 9 位字母数字，Claude Code 发的 toolu_xxx 会被拒
 *      → 422
 *
 * 用法：
 *   node mistral-proxy.mjs
 *   然后客户端 base URL 填 http://127.0.0.1:8787/v1
 *
 * 环境变量：
 *   MISTRAL_BASE_URL   上游地址，默认 https://api.mistral.ai
 *   PORT               监听端口，默认 8787
 *   DEBUG              设为 1 打印转换细节
 */

import http from "node:http";
import https from "node:https";

const UPSTREAM = (process.env.MISTRAL_BASE_URL || "https://api.mistral.ai").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8787);
const DEBUG = process.env.DEBUG === "1";

const log = (...a) => DEBUG && console.log("[proxy]", ...a);

// ───────────────────────────── 工具函数 ─────────────────────────────

/** Mistral 要求 tool call id 是 9 位字母数字 */
const MISTRAL_ID_RE = /^[a-zA-Z0-9]{9}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomId() {
  let s = "";
  for (let i = 0; i < 9; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

/**
 * 把 Mistral 的 content（字符串或 ContentChunk 数组）拍平成标准 OpenAI 的字符串。
 * thinking 分块单独提取，放进 reasoning_content。
 *
 * ContentChunk 可能的 type：text / image_url / document_url / reference /
 * file / thinking / tool_reference。只有 text 和 thinking 对文本对话有意义。
 */
function flattenContent(content) {
  if (content == null) return { text: "", reasoning: "" };
  if (typeof content === "string") return { text: content, reasoning: "" };
  if (!Array.isArray(content)) return { text: "", reasoning: "" };

  let text = "";
  let reasoning = "";

  for (const chunk of content) {
    if (chunk == null) continue;
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    const type = chunk.type;

    if (type === "text" || type === undefined) {
      if (typeof chunk.text === "string") text += chunk.text;
      continue;
    }

    if (type === "thinking") {
      // thinking 字段本身是 Thinking[]，元素可能是 TextChunk / ToolReferenceChunk / ReferenceChunk
      const inner = chunk.thinking;
      if (typeof inner === "string") {
        reasoning += inner;
      } else if (Array.isArray(inner)) {
        for (const t of inner) {
          if (t && typeof t.text === "string") reasoning += t.text;
        }
      }
      continue;
    }

    // image_url / document_url / reference / file / tool_reference：
    // 标准 OpenAI 的 delta.content 里放不下，丢弃（正文对话场景不涉及）
    log("dropping content chunk of type:", type);
  }

  return { text, reasoning };
}

/** 请求侧：把数组形式的 content 压成字符串（Mistral 接受数组，但压平更稳） */
function normalizeRequestContent(content) {
  if (content == null || typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  // 含图片的必须保留数组结构，否则多模态会丢
  const hasMedia = content.some(
    (c) => c && (c.type === "image_url" || c.type === "image" || c.type === "document_url")
  );
  if (hasMedia) return content;

  const { text } = flattenContent(content);
  return text;
}

// ───────────────────────────── 请求改写 ─────────────────────────────

function transformRequest(body) {
  if (!body || typeof body !== "object") return body;

  const idMap = new Map();
  const remapId = (id) => {
    if (typeof id !== "string" || MISTRAL_ID_RE.test(id)) return id;
    if (!idMap.has(id)) idMap.set(id, randomId());
    return idMap.get(id);
  };

  if (!Array.isArray(body.messages)) return body;

  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;

    // 1. content 压平
    msg.content = normalizeRequestContent(msg.content);

    // 2. tool_calls：id 重写 + arguments 转字符串
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (!call) continue;
        if (call.id) call.id = remapId(call.id);
        if (call.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") {
            call.function.arguments = JSON.stringify(call.function.arguments);
          }
        }
      }
    }

    // 3. tool 消息的 tool_call_id 必须跟 assistant 里的 id 对上
    if (msg.role === "tool" && msg.tool_call_id) {
      msg.tool_call_id = remapId(msg.tool_call_id);
    }

    // 4. Mistral 对未知字段是 extra_forbidden，剥掉常见的非标准字段
    delete msg.reasoning_content;
    delete msg.reasoning;
    delete msg.name;
  }

  // Mistral 不接受这些 OpenAI 扩展字段
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.logit_bias;
  delete body.store;
  delete body.metadata;
  delete body.service_tier;
  delete body.stream_options; // 由本代理自己补 usage

  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  return body;
}

// ───────────────────────────── 响应改写 ─────────────────────────────

/** 非流式响应：choices[].message.content 数组 → 字符串 */
function transformResponse(json) {
  if (!json || !Array.isArray(json.choices)) return json;

  for (const choice of json.choices) {
    const msg = choice?.message;
    if (!msg) continue;

    const { text, reasoning } = flattenContent(msg.content);
    msg.content = text;
    if (reasoning) msg.reasoning_content = reasoning;
    delete msg.reasoning;

    // arguments 对象 → JSON 字符串
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (call?.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") {
            call.function.arguments = JSON.stringify(call.function.arguments);
          }
        }
      }
    }
  }
  return json;
}

/** 流式单个 chunk：delta.content 数组 → 字符串 */
function transformChunk(json) {
  if (!json || !Array.isArray(json.choices)) return json;

  for (const choice of json.choices) {
    const delta = choice?.delta;
    if (!delta) continue;

    if (delta.content !== undefined && delta.content !== null) {
      const { text, reasoning } = flattenContent(delta.content);
      delta.content = text;
      if (reasoning) {
        // 上游若已给 reasoning_content 就追加，否则新建
        delta.reasoning_content = (delta.reasoning_content || "") + reasoning;
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (call?.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") {
            call.function.arguments = JSON.stringify(call.function.arguments);
          }
        }
      }
    }
  }
  return json;
}

// ───────────────────────────── HTTP 服务 ─────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 解析前置代理配置。
 *   HTTPS_PROXY / https_proxy / ALL_PROXY / all_proxy   → 用于 https 上游
 *   HTTP_PROXY  / http_proxy  / ALL_PROXY / all_proxy   → 用于 http 上游
 *   NO_PROXY    / no_proxy                              → 命中的主机直连
 * 支持 http:// 和 https:// 代理；socks 需要额外依赖，这里不支持。
 */
function resolveProxy(targetProtocol) {
  const env = process.env;
  const noProxy = env.NO_PROXY || env.no_proxy || "";
  const host = new URL(UPSTREAM).hostname;
  if (noProxy) {
    const hit = noProxy
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .some((p) => p === "*" || host === p || host.endsWith("." + p.replace(/^\./, "")));
    if (hit) return null;
  }
  const candidates =
    targetProtocol === "https:"
      ? [env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy]
      : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
  const raw = candidates.find((v) => v && v.trim());
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      console.warn(`[proxy] 不支持的代理协议 ${u.protocol}（只支持 http/https），改为直连`);
      return null;
    }
    return u;
  } catch {
    console.warn(`[proxy] 代理地址无法解析: ${raw}，改为直连`);
    return null;
  }
}

/** 对 https 目标走 HTTP 代理时，用 CONNECT 建隧道 */
function connectViaProxy(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyMod = proxyUrl.protocol === "https:" ? https : http;
    const auth =
      proxyUrl.username || proxyUrl.password
        ? "Basic " +
          Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
          ).toString("base64")
        : null;

    const req = proxyMod.request({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: auth ? { "proxy-authorization": auth } : {},
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode} ${res.statusMessage || ""}`));
        return;
      }
      resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
}

async function forward(targetUrl, method, headers, bodyBuffer) {
  const url = new URL(targetUrl);
  const isHttps = url.protocol === "https:";
  const port = Number(url.port) || (isHttps ? 443 : 80);
  const proxyUrl = resolveProxy(url.protocol);

  // 情况 1：无代理，直连
  if (!proxyUrl) {
    return new Promise((resolve, reject) => {
      const mod = isHttps ? https : http;
      const req = mod.request(
        { hostname: url.hostname, port, path: url.pathname + url.search, method, headers },
        resolve
      );
      req.on("error", reject);
      if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
      req.end();
    });
  }

  // 情况 2：http 目标 + http 代理 → 直接把请求发给代理，path 用绝对 URL
  if (!isHttps) {
    return new Promise((resolve, reject) => {
      const proxyMod = proxyUrl.protocol === "https:" ? https : http;
      const proxyHeaders = { ...headers, host: url.host };
      if (proxyUrl.username || proxyUrl.password) {
        proxyHeaders["proxy-authorization"] =
          "Basic " +
          Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
          ).toString("base64");
      }
      const req = proxyMod.request(
        {
          hostname: proxyUrl.hostname,
          port: proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
          path: targetUrl,
          method,
          headers: proxyHeaders,
        },
        resolve
      );
      req.on("error", reject);
      if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
      req.end();
    });
  }

  // 情况 3：https 目标 + 代理 → CONNECT 隧道，再在隧道上跑 TLS
  const socket = await connectViaProxy(proxyUrl, url.hostname, port);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, port, path: url.pathname + url.search, method, headers, socket, agent: false },
      resolve
    );
    req.on("error", reject);
    if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let path = req.url || "/";

  // 客户端可能填 http://127.0.0.1:8787/v1 或 http://127.0.0.1:8787
  // 统一转发到上游 /v1/...
  if (!path.startsWith("/v1/")) {
    path = "/v1" + (path.startsWith("/") ? path : "/" + path);
  }

  const targetUrl = UPSTREAM + path;
  const isChat = path.includes("/chat/completions");

  let bodyBuffer = await readBody(req);
  let parsed = null;

  if (isChat && bodyBuffer.length) {
    try {
      parsed = JSON.parse(bodyBuffer.toString("utf8"));
      transformRequest(parsed);
      bodyBuffer = Buffer.from(JSON.stringify(parsed), "utf8");
      log("→ request transformed, stream =", parsed.stream === true);
    } catch (e) {
      console.error("[proxy] request parse failed, forwarding raw:", e.message);
      parsed = null;
    }
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers["accept-encoding"]; // 避免上游 gzip 后我们无法改
  headers["content-length"] = String(bodyBuffer.length);

  let upstream;
  try {
    upstream = await forward(targetUrl, req.method, headers, bodyBuffer);
  } catch (e) {
    console.error("[proxy] upstream error:", e.message);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `upstream unreachable: ${e.message}`, type: "proxy_error" } }));
    return;
  }

  const status = upstream.statusCode || 502;
  const respHeaders = { ...upstream.headers };
  delete respHeaders["content-length"];
  delete respHeaders["content-encoding"];

  const isStream = (respHeaders["content-type"] || "").includes("text/event-stream");

  if (!isChat) {
    // 非 chat 接口原样透传
    res.writeHead(status, respHeaders);
    upstream.pipe(res);
    return;
  }

  if (isStream) {
    res.writeHead(status, { ...respHeaders, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

    let buf = "";
    upstream.setEncoding("utf8");
    upstream.on("data", (chunk) => {
      buf += chunk;
      // SSE 事件以空行分隔
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        res.write(rewriteSseEvent(event) + "\n\n");
      }
    });
    upstream.on("end", () => {
      if (buf.trim()) res.write(rewriteSseEvent(buf) + "\n\n");
      res.end();
      log(`← stream done in ${Date.now() - started}ms`);
    });
    upstream.on("error", (e) => {
      console.error("[proxy] stream error:", e.message);
      res.end();
    });
    return;
  }

  // 非流式 chat：整体读取后改写
  const chunks = [];
  upstream.on("data", (c) => chunks.push(c));
  upstream.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let out = raw;
    try {
      out = JSON.stringify(transformResponse(JSON.parse(raw)));
    } catch (e) {
      console.error("[proxy] response parse failed, forwarding raw:", e.message);
    }
    res.writeHead(status, { ...respHeaders, "content-type": "application/json" });
    res.end(out);
    log(`← response done in ${Date.now() - started}ms`);
  });
});

function rewriteSseEvent(event) {
  const lines = event.split("\n");
  const out = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      out.push(line);
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      out.push(line);
      continue;
    }
    try {
      out.push("data: " + JSON.stringify(transformChunk(JSON.parse(payload))));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mistral → OpenAI 转换代理已启动`);
  console.log(`  监听: http://127.0.0.1:${PORT}/v1`);
  console.log(`  上游: ${UPSTREAM}`);
  const upstreamProto = new URL(UPSTREAM).protocol;
  const px = resolveProxy(upstreamProto);
  if (px) {
    const masked = px.username ? `${px.protocol}//***@${px.host}` : `${px.protocol}//${px.host}`;
    console.log(`  前置代理: ${masked}`);
  } else {
    console.log(`  前置代理: 直连`);
  }
  console.log(`  客户端 base URL 填: http://127.0.0.1:${PORT}/v1`);
  if (DEBUG) console.log("  DEBUG 模式已开启");
});
