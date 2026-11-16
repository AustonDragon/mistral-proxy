/**
 * 验证 NewAPI 插件：检查 manifest 合法、hook 契约正确、转换逻辑无误。
 *
 *   node test-plugin.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}

// ── 加载插件（提供最小 utils 模拟）──
const src = readFileSync(path.join(__dirname, "plugin.js"), "utf8");
const utils = {
  json: { clone: (v) => JSON.parse(JSON.stringify(v)) },
};
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(src + "\nexport { utils as __u };").toString("base64")
).catch(async () => {
  // data: URL 里不能直接引用外部 utils，用 Function 构造
  const factory = new Function("utils", src.replace(/^export /gm, ""));
  return factory(utils);
});

// 上面两种方式取其一
let plugin;
if (mod && mod.meta) {
  plugin = mod;
} else {
  // 用 Function 方式重新加载
  const stripped = src.replace(/^export /gm, "");
  const factory = new Function(
    "utils",
    stripped + "\nreturn { meta, convertRequest, convertResponse, convertStreamEvent };"
  );
  plugin = factory(utils);
}

const { meta, convertRequest, convertResponse, convertStreamEvent } = plugin;

console.log("\n【1】manifest 合法性");
ok("apiVersion 是 1", meta.apiVersion === 1);
ok("key 存在且 ≤30 字符", typeof meta.key === "string" && meta.key.length <= 30, meta.key);
ok("version 是 semver", /^\d+\.\d+\.\d+$/.test(meta.version), meta.version);
ok("author.name 存在", meta.author && typeof meta.author.name === "string");
ok("name 是 LocalizedText 且含 en", meta.name && typeof meta.name === "object" && typeof meta.name.en === "string");
ok("description 含 en", meta.description && typeof meta.description.en === "string");
ok("relay 是数组", Array.isArray(meta.relay));
ok("有一个 plugin 转换路由", meta.relay.some((r) => r.converter === "plugin"));
const route = meta.relay.find((r) => r.converter === "plugin");
ok("incoming_path 是 /v1/chat/completions", route.incoming_path === "/v1/chat/completions", route.incoming_path);
ok("upstream_path 以 / 开头", route.upstream_path.startsWith("/"), route.upstream_path);
ok("没有非法字段 routes", meta.routes === undefined);
ok("没有非法字段 protocols", meta.protocols === undefined);
ok("没有非法字段 channelTypes", meta.channelTypes === undefined);

console.log("\n【2】三个转换 hook 都已导出");
ok("convertRequest 是函数", typeof convertRequest === "function");
ok("convertResponse 是函数", typeof convertResponse === "function");
ok("convertStreamEvent 是函数", typeof convertStreamEvent === "function");

console.log("\n【3】convertRequest：tool id 重写 + arguments 转字符串");
{
  const req = {
    body: {
      model: "mistral-large-latest",
      messages: [
        { role: "user", content: "天气如何" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "toolu_01ABCdefGHIjklMNO", type: "function", function: { name: "get_weather", arguments: { location: "Tokyo" } } },
          ],
        },
        { role: "tool", tool_call_id: "toolu_01ABCdefGHIjklMNO", content: "晴" },
      ],
    },
  };
  const out = convertRequest({}, req);
  ok("返回 {body}", out && out.body);
  const msgs = out.body.messages;
  const newId = msgs[1].tool_calls[0].id;
  ok("tool id 重写为 9 位字母数字", /^[a-zA-Z0-9]{9}$/.test(newId), newId);
  eq("tool 消息 id 同步", msgs[2].tool_call_id, newId);
  eq("arguments 转字符串", msgs[1].tool_calls[0].function.arguments, '{"location":"Tokyo"}');
  ok("原始请求未被修改", req.body.messages[1].tool_calls[0].id === "toolu_01ABCdefGHIjklMNO");
}

console.log("\n【4】convertRequest：剥掉 Mistral 不认的字段");
{
  const out = convertRequest({}, {
    body: {
      model: "m", stream: true,
      messages: [{ role: "user", content: "hi", reasoning_content: "x", name: "u" }],
      logprobs: true, store: false, metadata: { a: 1 }, service_tier: "auto",
    },
  });
  const b = out.body;
  ok("去掉 message.reasoning_content", b.messages[0].reasoning_content === undefined);
  ok("去掉 message.name", b.messages[0].name === undefined);
  ok("去掉 logprobs", b.logprobs === undefined);
  ok("去掉 store", b.store === undefined);
  ok("去掉 metadata", b.metadata === undefined);
  ok("去掉 service_tier", b.service_tier === undefined);
  eq("stream 时补 include_usage", b.stream_options, { include_usage: true });
}

console.log("\n【5】convertRequest：多模态 content 保留数组");
{
  const multimodal = [
    { type: "text", text: "描述这张图" },
    { type: "image_url", image_url: { url: "data:..." } },
  ];
  const out = convertRequest({}, { body: { messages: [{ role: "user", content: multimodal }] } });
  eq("含图片时不动", out.body.messages[0].content, multimodal);
}

console.log("\n【6】convertResponse：数组 content → 字符串");
{
  const out = convertResponse({}, {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: [{ type: "text", text: "你好" }] } }],
    }),
  });
  eq("content 是字符串", out.body.choices[0].message.content, "你好");
  eq("contentType 正确", out.contentType, "application/json");
}

console.log("\n【7】convertResponse：thinking 进 reasoning_content");
{
  const out = convertResponse({}, {
    status: 200,
    headers: {},
    body: JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: [{ type: "text", text: "思考中" }] },
            { type: "text", text: "答案" },
          ],
        },
      }],
    }),
  });
  const msg = out.body.choices[0].message;
  eq("正文只含 text", msg.content, "答案");
  eq("thinking 进 reasoning_content", msg.reasoning_content, "思考中");
}

console.log("\n【8】convertResponse：非 JSON 原样返回");
{
  const out = convertResponse({}, { status: 502, headers: { "content-type": "text/html" }, body: "<html>bad gateway</html>" });
  eq("body 原样", out.body, "<html>bad gateway</html>");
  eq("contentType 保留", out.contentType, "text/html");
}

console.log("\n【9】convertStreamEvent：数组 content → 字符串");
{
  const out = convertStreamEvent({}, {
    data: JSON.stringify({ choices: [{ delta: { content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }] } }] }),
  });
  ok("返回 events", Array.isArray(out.events) && out.events.length === 1);
  const chunk = JSON.parse(out.events[0].data);
  eq("content 是字符串", chunk.choices[0].delta.content, "你好世界");
}

console.log("\n【10】convertStreamEvent：thinking 分离");
{
  const out = convertStreamEvent({}, {
    data: JSON.stringify({
      choices: [{
        delta: {
          content: [
            { type: "thinking", thinking: [{ type: "text", text: "思考" }] },
            { type: "text", text: "正文" },
          ],
        },
      }],
    }),
  });
  const d = JSON.parse(out.events[0].data).choices[0].delta;
  eq("正文只含 text", d.content, "正文");
  eq("thinking 进 reasoning_content", d.reasoning_content, "思考");
}

console.log("\n【11】convertStreamEvent：边界");
{
  eq("[DONE] 返回空对象", convertStreamEvent({}, { data: "[DONE]" }), {});
  eq("done 返回空对象", convertStreamEvent({}, { done: true }), {});
  eq("空 data 返回空对象", convertStreamEvent({}, { data: "" }), {});
  const nonJson = convertStreamEvent({}, { data: "not json" });
  ok("非 JSON 原样透传", nonJson.events && nonJson.events[0].data === "not json");
  const noChoices = convertStreamEvent({}, { data: JSON.stringify({ id: "x" }) });
  eq("无 choices 不崩", JSON.parse(noChoices.events[0].data), { id: "x" });
}

console.log("\n【12】convertStreamEvent：保留 event 名");
{
  const out = convertStreamEvent({}, { event: "message", data: JSON.stringify({ choices: [{ delta: { content: "a" } }] }) });
  eq("event 名保留", out.events[0].event, "message");
}

console.log("\n【13】convertStreamEvent：tool_calls 的 arguments 对象转字符串");
{
  const out = convertStreamEvent({}, {
    data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "abc", function: { name: "f", arguments: { a: 1 } } }] } }] }),
  });
  const call = JSON.parse(out.events[0].data).choices[0].delta.tool_calls[0];
  eq("arguments 转字符串", call.function.arguments, '{"a":1}');
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
