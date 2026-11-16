/**
 * 离线验证转换逻辑：用 Mistral 官方 schema 构造样本，检查输出是否符合标准 OpenAI 格式。
 * 不联网，不需要 API key。
 *
 *   node test-transform.mjs
 */

// 从主文件复制核心函数（保持同步，改动主文件时记得同步这里）
const MISTRAL_ID_RE = /^[a-zA-Z0-9]{9}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomId() {
  let s = "";
  for (let i = 0; i < 9; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

function flattenContent(content) {
  if (content == null) return { text: "", reasoning: "" };
  if (typeof content === "string") return { text: content, reasoning: "" };
  if (!Array.isArray(content)) return { text: "", reasoning: "" };
  let text = "";
  let reasoning = "";
  for (const chunk of content) {
    if (chunk == null) continue;
    if (typeof chunk === "string") { text += chunk; continue; }
    const type = chunk.type;
    if (type === "text" || type === undefined) {
      if (typeof chunk.text === "string") text += chunk.text;
      continue;
    }
    if (type === "thinking") {
      const inner = chunk.thinking;
      if (typeof inner === "string") reasoning += inner;
      else if (Array.isArray(inner)) {
        for (const t of inner) if (t && typeof t.text === "string") reasoning += t.text;
      }
      continue;
    }
  }
  return { text, reasoning };
}

function normalizeRequestContent(content) {
  if (content == null || typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const hasMedia = content.some((c) => c && (c.type === "image_url" || c.type === "image" || c.type === "document_url"));
  if (hasMedia) return content;
  return flattenContent(content).text;
}

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
    msg.content = normalizeRequestContent(msg.content);
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (!call) continue;
        if (call.id) call.id = remapId(call.id);
        if (call.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") call.function.arguments = JSON.stringify(call.function.arguments);
        }
      }
    }
    if (msg.role === "tool" && msg.tool_call_id) msg.tool_call_id = remapId(msg.tool_call_id);
    delete msg.reasoning_content;
    delete msg.reasoning;
    delete msg.name;
  }
  delete body.logprobs; delete body.top_logprobs; delete body.logit_bias;
  delete body.store; delete body.metadata; delete body.service_tier; delete body.stream_options;
  if (body.stream) body.stream_options = { include_usage: true };
  return body;
}

function transformResponse(json) {
  if (!json || !Array.isArray(json.choices)) return json;
  for (const choice of json.choices) {
    const msg = choice?.message;
    if (!msg) continue;
    const { text, reasoning } = flattenContent(msg.content);
    msg.content = text;
    if (reasoning) msg.reasoning_content = reasoning;
    delete msg.reasoning;
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (call?.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") call.function.arguments = JSON.stringify(call.function.arguments);
        }
      }
    }
  }
  return json;
}

function transformChunk(json) {
  if (!json || !Array.isArray(json.choices)) return json;
  for (const choice of json.choices) {
    const delta = choice?.delta;
    if (!delta) continue;
    if (delta.content !== undefined && delta.content !== null) {
      const { text, reasoning } = flattenContent(delta.content);
      delta.content = text;
      if (reasoning) delta.reasoning_content = (delta.reasoning_content || "") + reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (call?.function && call.function.arguments != null) {
          if (typeof call.function.arguments !== "string") call.function.arguments = JSON.stringify(call.function.arguments);
        }
      }
    }
  }
  return json;
}

// ───────────────────────────── 测试 ─────────────────────────────

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}
function assert(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

console.log("\n【1】流式 chunk: content 数组 → 字符串");
check(
  "text 分块拼接",
  transformChunk({ choices: [{ delta: { content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }] } }] }).choices[0].delta.content,
  "你好世界"
);
check(
  "纯字符串保持不变",
  transformChunk({ choices: [{ delta: { content: "hello" } }] }).choices[0].delta.content,
  "hello"
);
check(
  "null content 不报错",
  transformChunk({ choices: [{ delta: { content: null } }] }).choices[0].delta.content,
  null
);
check(
  "空数组 → 空字符串",
  transformChunk({ choices: [{ delta: { content: [] } }] }).choices[0].delta.content,
  ""
);

console.log("\n【2】thinking 分块 → reasoning_content，不污染正文");
const thinkChunk = transformChunk({
  choices: [{
    delta: {
      content: [
        { type: "thinking", thinking: [{ type: "text", text: "让我想想" }] },
        { type: "text", text: "答案是42" },
      ],
    },
  }],
}).choices[0].delta;
check("正文只含 text", thinkChunk.content, "答案是42");
check("thinking 进 reasoning_content", thinkChunk.reasoning_content, "让我想想");

console.log("\n【3】多轮 thinking 累加");
let acc = {};
for (const raw of [
  { choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "第一段" }] }] } }] },
  { choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "第二段" }] }] } }] },
]) {
  const d = transformChunk(raw).choices[0].delta;
  acc.reasoning_content = (acc.reasoning_content || "") + (d.reasoning_content || "");
}
check("两段 thinking 累加", acc.reasoning_content, "第一段第二段");

console.log("\n【4】非流式响应");
const nonStream = transformResponse({
  choices: [{ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }],
});
check("message.content 数组 → 字符串", nonStream.choices[0].message.content, "hi");
assert("没有残留 reasoning 字段", nonStream.choices[0].message.reasoning === undefined);

console.log("\n【5】tool_calls: id 重写 + arguments 转字符串");
const req = transformRequest({
  model: "mistral-large-latest",
  messages: [
    { role: "user", content: "天气如何" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "toolu_01ABCdefGHIjklMNO", type: "function", function: { name: "get_weather", arguments: { location: "Tokyo" } } }],
    },
    { role: "tool", tool_call_id: "toolu_01ABCdefGHIjklMNO", content: "晴" },
  ],
});
const callId = req.messages[1].tool_calls[0].id;
assert("tool id 已重写为 9 位字母数字", /^[a-zA-Z0-9]{9}$/.test(callId), `实际: ${callId}`);
check("tool 消息的 tool_call_id 同步重写", req.messages[2].tool_call_id, callId);
check("arguments 对象 → JSON 字符串", req.messages[1].tool_calls[0].function.arguments, '{"location":"Tokyo"}');

console.log("\n【6】同一会话内 id 映射稳定");
const req2 = transformRequest({
  messages: [
    { role: "assistant", content: "", tool_calls: [{ id: "toolu_X", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "toolu_X", content: "r" },
  ],
});
check("assistant 与 tool 的 id 一致", req2.messages[0].tool_calls[0].id, req2.messages[1].tool_call_id);

console.log("\n【7】请求侧剥掉 Mistral 不认的字段");
const req3 = transformRequest({
  model: "m", stream: true,
  messages: [{ role: "user", content: "hi", reasoning_content: "x", name: "u" }],
  logprobs: true, store: false, metadata: { a: 1 }, service_tier: "auto",
});
assert("去掉 message.reasoning_content", req3.messages[0].reasoning_content === undefined);
assert("去掉 message.name", req3.messages[0].name === undefined);
assert("去掉 logprobs", req3.logprobs === undefined);
assert("去掉 store", req3.store === undefined);
assert("去掉 metadata", req3.metadata === undefined);
assert("去掉 service_tier", req3.service_tier === undefined);
check("stream 时补 include_usage", req3.stream_options, { include_usage: true });

console.log("\n【8】多模态 content 保留数组结构");
const multimodal = [{ type: "text", text: "描述这张图" }, { type: "image_url", image_url: { url: "data:..." } }];
check("含图片时不动", transformRequest({ messages: [{ role: "user", content: multimodal }] }).messages[0].content, multimodal);

console.log("\n【9】边界：非法输入不崩");
check("null body", transformRequest(null), null);
check("无 messages", transformRequest({ model: "m" }).model, "m");
check("delta 无 content", transformChunk({ choices: [{ delta: { role: "assistant" } }] }).choices[0].delta.role, "assistant");
check("choices 为空", transformChunk({ choices: [] }).choices, []);

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
