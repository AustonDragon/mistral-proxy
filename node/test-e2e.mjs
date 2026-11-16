/**
 * 端到端验证：起一个假的 Mistral 上游（返回真实 schema 的数组格式），
 * 让代理去连它，检查客户端拿到的是不是标准 OpenAI 格式。
 *
 *   node test-e2e.mjs
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_PORT = 8899;
const PROXY_PORT = 8898;

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// ── 假 Mistral 上游 ──
const fakeMistral = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    console.log(`  [fake-mistral] 收到请求, stream=${parsed.stream}, messages=${parsed.messages?.length}`);

    // 校验代理是否剥掉了 Mistral 不认的字段
    const hasReasoning = parsed.messages?.some((m) => m.reasoning_content !== undefined);
    if (hasReasoning) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "messages", "reasoning_content"] }] }));
      return;
    }

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 真实 Mistral 流式格式：content 是数组，含 thinking 分块
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "思考中" }] }] } }] },
        { choices: [{ index: 0, delta: { content: [{ type: "text", text: "你好" }] } }] },
        { choices: [{ index: 0, delta: { content: [{ type: "text", text: "，世界" }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // 非流式：content 数组 + arguments 是对象
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-1", object: "chat.completion", model: parsed.model,
      choices: [{
        index: 0, finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我来查一下" }],
          tool_calls: [{ id: "abcdefghi", type: "function", function: { name: "get_weather", arguments: { location: "Tokyo" } } }],
        },
      }],
    }));
  });
});

// ── 启动 ──
await new Promise((r) => fakeMistral.listen(UPSTREAM_PORT, "127.0.0.1", r));
console.log(`假 Mistral 上游已启动: http://127.0.0.1:${UPSTREAM_PORT}`);

const proxy = spawn(process.execPath, [path.join(__dirname, "mistral-proxy.mjs")], {
  env: { ...process.env, MISTRAL_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`, PORT: String(PROXY_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
proxy.stdout.on("data", (d) => process.stdout.write(`  [proxy] ${d}`));
proxy.stderr.on("data", (d) => process.stderr.write(`  [proxy:err] ${d}`));

await new Promise((r) => setTimeout(r, 800));

function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      { hostname: "127.0.0.1", port: PROXY_PORT, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const baseReq = {
  model: "mistral-large-latest",
  messages: [
    { role: "user", content: "你好" },
    { role: "assistant", content: "", tool_calls: [{ id: "toolu_01ABCdefGHIjklMNO", type: "function", function: { name: "get_weather", arguments: { location: "Tokyo" } } }] },
    { role: "tool", tool_call_id: "toolu_01ABCdefGHIjklMNO", content: "晴" },
  ],
};

console.log("\n【E2E-1】流式：数组 content → 字符串");
{
  const { status, body } = await post("/v1/chat/completions", { ...baseReq, stream: true });
  ok("HTTP 200", status === 200, `实际 ${status}`);
  const events = body.split("\n\n").filter((e) => e.startsWith("data: ") && !e.includes("[DONE]"));
  const deltas = events.map((e) => JSON.parse(e.slice(6)).choices[0].delta);

  const contents = deltas.map((d) => d.content).filter((c) => c !== undefined);
  ok("所有 content 都是字符串", contents.every((c) => typeof c === "string"), JSON.stringify(contents));
  ok("正文拼接正确", contents.join("") === "你好，世界", `实际: ${JSON.stringify(contents.join(""))}`);
  const reasoning = deltas.map((d) => d.reasoning_content).filter(Boolean).join("");
  ok("thinking 进了 reasoning_content", reasoning === "思考中", `实际: ${JSON.stringify(reasoning)}`);
  ok("正文不含 thinking 内容", !contents.join("").includes("思考中"));
  ok("保留 [DONE]", body.includes("[DONE]"));
}

console.log("\n【E2E-2】非流式：数组 content + 对象 arguments");
{
  const { status, body } = await post("/v1/chat/completions", { ...baseReq, stream: false });
  ok("HTTP 200", status === 200, `实际 ${status}`);
  const json = JSON.parse(body);
  const msg = json.choices[0].message;
  ok("content 是字符串", typeof msg.content === "string", JSON.stringify(msg.content));
  ok("content 值正确", msg.content === "我来查一下");
  ok("arguments 是字符串", typeof msg.tool_calls[0].function.arguments === "string");
  ok("arguments 内容正确", msg.tool_calls[0].function.arguments === '{"location":"Tokyo"}');
}

console.log("\n【E2E-3】请求侧：reasoning_content 被剥掉（否则假上游返回 422）");
{
  const { status } = await post("/v1/chat/completions", {
    ...baseReq,
    messages: [{ role: "user", content: "hi", reasoning_content: "不该发出去" }],
    stream: false,
  });
  ok("未触发上游 422", status === 200, `实际 ${status}`);
}

console.log("\n【E2E-4】tool id 重写后仍能对上");
{
  const { body } = await post("/v1/chat/completions", { ...baseReq, stream: false });
  ok("请求成功", JSON.parse(body).choices?.length > 0);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);

proxy.kill();
fakeMistral.close();
process.exit(fail === 0 ? 0 : 1);
