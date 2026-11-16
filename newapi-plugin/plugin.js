// Mistral 格式修正插件
//
// Mistral 的 Chat Completions 与标准 OpenAI 有 4 处不兼容，会让 NewAPI 的
// OpenAI 解析器失败或让上游拒绝请求：
//
//   1. 流式 delta.content 是数组（[{type:"text",text:"..."}]）而非字符串
//   2. 推理内容以 {type:"thinking", thinking:[...]} 分块混在 content 数组里
//   3. tool_calls[].function.arguments 可能是对象而非 JSON 字符串
//   4. tool_calls[].id 必须是 9 位字母数字，Claude Code 发的 toolu_xxx 会被拒
//
// 本插件挂在 converter: "plugin" 路由上，双向转换。

const MISTRAL_ID_RE = /^[a-zA-Z0-9]{9}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomId() {
  let s = "";
  for (let i = 0; i < 9; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

/**
 * 把 Mistral 的 content（字符串或 ContentChunk 数组）拍平成标准 OpenAI 的字符串。
 * thinking 分块单独提取。
 *
 * ContentChunk 的 type 可能是：text / image_url / document_url / reference /
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
    // 标准 OpenAI 的 delta.content 里放不下，丢弃（文本对话场景不涉及）
  }

  return { text, reasoning };
}

/** 请求侧：把数组形式的 content 压成字符串（含图片时保留数组） */
function normalizeRequestContent(content) {
  if (content == null || typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  const hasMedia = content.some(
    (c) => c && (c.type === "image_url" || c.type === "image" || c.type === "document_url")
  );
  if (hasMedia) return content;

  return flattenContent(content).text;
}

/** 请求改写：tool id 重写、arguments 转字符串、剥掉 Mistral 不认的字段 */
function transformRequestBody(body) {
  if (!body || typeof body !== "object") return body;

  const idMap = new Map();
  const remapId = (id) => {
    if (typeof id !== "string" || MISTRAL_ID_RE.test(id)) return id;
    if (!idMap.has(id)) idMap.set(id, randomId());
    return idMap.get(id);
  };

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;

      msg.content = normalizeRequestContent(msg.content);

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

      if (msg.role === "tool" && msg.tool_call_id) {
        msg.tool_call_id = remapId(msg.tool_call_id);
      }

      delete msg.reasoning_content;
      delete msg.reasoning;
      delete msg.name;
    }
  }

  // Mistral 对未知字段是 extra_forbidden
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.logit_bias;
  delete body.store;
  delete body.metadata;
  delete body.service_tier;
  delete body.stream_options;

  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  return body;
}

/** 非流式响应：choices[].message.content 数组 → 字符串 */
function transformResponseBody(json) {
  if (!json || !Array.isArray(json.choices)) return json;

  for (const choice of json.choices) {
    const msg = choice && choice.message;
    if (!msg) continue;

    const flat = flattenContent(msg.content);
    msg.content = flat.text;
    if (flat.reasoning) msg.reasoning_content = flat.reasoning;
    delete msg.reasoning;

    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (call && call.function && call.function.arguments != null) {
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
    const delta = choice && choice.delta;
    if (!delta) continue;

    if (delta.content !== undefined && delta.content !== null) {
      const flat = flattenContent(delta.content);
      delta.content = flat.text;
      if (flat.reasoning) {
        delta.reasoning_content = (delta.reasoning_content || "") + flat.reasoning;
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (call && call.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") {
            call.function.arguments = JSON.stringify(call.function.arguments);
          }
        }
      }
    }
  }

  return json;
}

export const meta = {
  apiVersion: 1,
  key: "mistral-fix",
  name: { en: "Mistral format fix", zh: "Mistral 格式修正" },
  description: {
    en: "Converts Mistral's chunked content arrays and strict tool-call ids to standard OpenAI format",
    zh: "把 Mistral 的分块 content 数组和严格工具调用 id 转成标准 OpenAI 格式",
  },
  version: "1.0.0",
  author: { name: "local" },
  models: [],
  relay: [
    {
      incoming_path: "/v1/chat/completions",
      upstream_path: "/v1/chat/completions",
      converter: "plugin",
    },
  ],
};

// ───────────────────────────── 转换 hook ─────────────────────────────

export function convertRequest(ctx, request) {
  // request.body 是客户端发来的 OpenAI Chat Completions 请求
  const body = transformRequestBody(utils.json.clone(request.body));
  return { body };
}

export function convertResponse(ctx, response) {
  let json;
  try {
    json = JSON.parse(response.body);
  } catch {
    // 不是 JSON（错误页等），原样返回
    return { body: response.body, contentType: response.headers["content-type"] || "application/json" };
  }
  return { body: transformResponseBody(json), contentType: "application/json" };
}

export function convertStreamEvent(ctx, input) {
  if (input.done) return {};

  const data = input.data;
  if (typeof data !== "string" || data === "" || data === "[DONE]") {
    return {};
  }

  let json;
  try {
    json = JSON.parse(data);
  } catch {
    // 无法解析的事件原样透传
    return { events: [{ event: input.event, data }] };
  }

  return {
    events: [{ event: input.event, data: JSON.stringify(transformChunk(json)) }],
  };
}
