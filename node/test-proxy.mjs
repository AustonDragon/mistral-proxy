/**
 * 验证前置代理支持：起一个假 HTTP 代理 + 假上游，检查三种路径都能通。
 *
 *   node test-proxy.mjs
 */

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_PORT = 8901;
const PROXY_PORT = 8902;
const FORWARD_PROXY_PORT = 8903;

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// ── 假上游 ──
const fakeUpstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "x", object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }],
    }));
  });
});

// ── 假 HTTP 代理：记录 CONNECT 和普通转发 ──
const proxyLog = { connect: 0, forward: 0, lastAuth: null };
const fakeProxy = http.createServer((req, res) => {
  proxyLog.forward++;
  proxyLog.lastAuth = req.headers["proxy-authorization"] || null;
  // 普通转发：req.url 是绝对 URL
  const target = new URL(req.url);
  const upstreamReq = http.request(
    { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstreamReq);
});

// CONNECT 隧道
fakeProxy.on("connect", (req, clientSocket, head) => {
  proxyLog.connect++;
  const [host, port] = req.url.split(":");
  const serverSocket = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => serverSocket.destroy());
});

await new Promise((r) => fakeUpstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
await new Promise((r) => fakeProxy.listen(FORWARD_PROXY_PORT, "127.0.0.1", r));
console.log(`假上游: ${UPSTREAM_PORT}  假代理: ${FORWARD_PROXY_PORT}`);

function startProxy(env) {
  const p = spawn(process.execPath, [path.join(__dirname, "mistral-proxy.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  return { proc: p, getOut: () => out };
}

function post(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
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

const reqBody = { model: "m", messages: [{ role: "user", content: "hi" }], stream: false };

console.log("\n【P1】HTTP 上游 + HTTP 代理（普通转发）");
{
  const { proc, getOut } = startProxy({
    MISTRAL_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    PORT: String(PROXY_PORT),
    HTTP_PROXY: `http://127.0.0.1:${FORWARD_PROXY_PORT}`,
    NO_PROXY: "",
  });
  await new Promise((r) => setTimeout(r, 700));
  ok("启动日志显示代理已启用", getOut().includes("前置代理: http://127.0.0.1"), getOut().split("\n").find((l) => l.includes("前置代理")) || "");
  const before = proxyLog.forward;
  const { status, body } = await post(PROXY_PORT, reqBody);
  ok("请求成功", status === 200, `实际 ${status}`);
  ok("经过代理转发", proxyLog.forward > before, `forward ${before} → ${proxyLog.forward}`);
  ok("响应已转换（content 是字符串）", JSON.parse(body).choices[0].message.content === "ok", body.slice(0, 120));
  proc.kill();
}

console.log("\n【P2】NO_PROXY 命中时直连");
{
  const { proc, getOut } = startProxy({
    MISTRAL_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    PORT: String(PROXY_PORT),
    HTTP_PROXY: `http://127.0.0.1:${FORWARD_PROXY_PORT}`,
    NO_PROXY: "127.0.0.1",
  });
  await new Promise((r) => setTimeout(r, 700));
  ok("启动日志显示直连", getOut().includes("前置代理: 直连"), getOut().split("\n").find((l) => l.includes("前置代理")) || "");
  const before = proxyLog.forward;
  const { status } = await post(PROXY_PORT, reqBody);
  ok("请求成功", status === 200, `实际 ${status}`);
  ok("未经过代理", proxyLog.forward === before, `forward ${before} → ${proxyLog.forward}`);
  proc.kill();
}

console.log("\n【P3】HTTPS 上游 + HTTP 代理（CONNECT 隧道）");
{
  // 用 http 上游模拟不了 CONNECT，这里只验证 CONNECT 代码路径被走到
  const { proc, getOut } = startProxy({
    MISTRAL_BASE_URL: "https://api.mistral.ai",
    PORT: String(PROXY_PORT),
    HTTPS_PROXY: `http://127.0.0.1:${FORWARD_PROXY_PORT}`,
    NO_PROXY: "",
  });
  await new Promise((r) => setTimeout(r, 700));
  ok("启动日志显示代理已启用", getOut().includes("前置代理: http://127.0.0.1"), getOut().split("\n").find((l) => l.includes("前置代理")) || "");
  const before = proxyLog.connect;
  // 会真的尝试连 api.mistral.ai，但我们只关心有没有走 CONNECT
  try { await post(PROXY_PORT, reqBody); } catch { /* 网络失败无所谓 */ }
  await new Promise((r) => setTimeout(r, 500));
  ok("走了 CONNECT 隧道", proxyLog.connect > before, `connect ${before} → ${proxyLog.connect}`);
  proc.kill();
}

console.log("\n【P4】代理地址带认证信息");
{
  const { proc, getOut } = startProxy({
    MISTRAL_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    PORT: String(PROXY_PORT),
    HTTP_PROXY: `http://user:pass@127.0.0.1:${FORWARD_PROXY_PORT}`,
    NO_PROXY: "",
  });
  await new Promise((r) => setTimeout(r, 700));
  const logLine = getOut().split("\n").find((l) => l.includes("前置代理")) || "";
  ok("日志里隐藏了账号密码", logLine.includes("***") && !logLine.includes("pass"), logLine);
  await post(PROXY_PORT, reqBody);
  ok("发送了 Proxy-Authorization", proxyLog.lastAuth !== null && proxyLog.lastAuth.startsWith("Basic "), String(proxyLog.lastAuth));
  proc.kill();
}

console.log("\n【P5】不支持的代理协议降级为直连");
{
  const { proc, getOut } = startProxy({
    MISTRAL_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    PORT: String(PROXY_PORT),
    HTTP_PROXY: "socks5://127.0.0.1:1080",
    NO_PROXY: "",
  });
  await new Promise((r) => setTimeout(r, 700));
  ok("提示不支持并降级", getOut().includes("不支持的代理协议"), getOut().split("\n").find((l) => l.includes("代理协议")) || "");
  ok("降级为直连", getOut().includes("前置代理: 直连"));
  const { status } = await post(PROXY_PORT, reqBody);
  ok("直连仍能工作", status === 200, `实际 ${status}`);
  proc.kill();
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);

fakeUpstream.close();
fakeProxy.close();
process.exit(fail === 0 ? 0 : 1);
