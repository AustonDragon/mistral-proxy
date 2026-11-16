// Mistral → 标准 OpenAI 内容转换代理
//
// 职责只有一件事：把 Mistral 的非标准响应内容洗成标准 OpenAI 格式。
// 认证信息（Authorization 等）原样透传，不解析、不修改、不记录。
//
// Mistral 与标准 OpenAI 的 4 处内容差异：
//  1. 流式 delta.content 是数组（[{type:"text",text:"..."}]）而非字符串
//  2. 推理内容以 {type:"thinking", thinking:[...]} 分块混在 content 数组里
//  3. tool_calls[].function.arguments 可能是对象而非 JSON 字符串
//  4. tool_calls[].id 必须是 9 位字母数字，Claude Code 发的 toolu_xxx 会被拒
//
// 零第三方依赖。
package main

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ───────────────────────────── 配置 ─────────────────────────────

// Config 是配置文件结构，JSON 格式。
type Config struct {
	// Listen 监听地址，如 "127.0.0.1:8787"；"0.0.0.0:8787" 表示所有网卡
	Listen string `json:"listen"`
	// Upstream 上游地址，如 "https://api.mistral.ai"
	Upstream string `json:"upstream"`
	// Proxy 前置代理，如 "http://127.0.0.1:7890"；留空表示直连
	Proxy string `json:"proxy"`
	// Verbose 打印转换细节（不打印任何认证信息）
	Verbose bool `json:"verbose"`
	// Timeout 上游请求超时（秒），0 表示不限制（流式建议 0）
	Timeout int `json:"timeout"`
}

func defaultConfig() Config {
	return Config{
		Listen:   "127.0.0.1:8787",
		Upstream: "https://api.mistral.ai",
		Proxy:    "",
		Verbose:  false,
		Timeout:  0,
	}
}

func loadConfig() (Config, error) {
	cfg := defaultConfig()

	// 配置文件路径：-config 参数 > CONFIG 环境变量 > 可执行文件同目录 config.json
	path := ""
	flag.StringVar(&path, "config", os.Getenv("CONFIG"), "配置文件路径（默认可执行文件同目录 config.json）")
	flag.Parse()

	if path == "" {
		exe, err := os.Executable()
		if err == nil {
			path = filepath.Join(filepath.Dir(exe), "config.json")
		} else {
			path = "config.json"
		}
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// 首次运行：生成默认配置
			if werr := writeDefaultConfig(path, cfg); werr != nil {
				log.Printf("警告: 无法写入默认配置 %s: %v", path, werr)
			} else {
				log.Printf("已生成默认配置: %s", path)
			}
			return cfg, nil
		}
		return cfg, fmt.Errorf("读取配置 %s: %w", path, err)
	}

	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("解析配置 %s: %w", path, err)
	}

	cfg.Listen = strings.TrimSpace(cfg.Listen)
	cfg.Upstream = strings.TrimRight(strings.TrimSpace(cfg.Upstream), "/")
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8787"
	}
	if cfg.Upstream == "" {
		cfg.Upstream = "https://api.mistral.ai"
	}

	log.Printf("配置已加载: %s", path)
	return cfg, nil
}

func writeDefaultConfig(path string, cfg Config) error {
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}

// ───────────────────────────── 服务 ─────────────────────────────

type server struct {
	cfg    Config
	client *http.Client
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}

	s := &server{cfg: cfg, client: newHTTPClient(cfg)}

	log.Printf("Mistral → OpenAI 内容转换代理已启动")
	log.Printf("  监听: http://%s/v1", cfg.Listen)
	log.Printf("  上游: %s", cfg.Upstream)
	if proxyInUse(cfg) {
		log.Printf("  前置代理: %s", maskProxy(cfg.Proxy))
	} else {
		log.Printf("  前置代理: 直连")
	}
	log.Printf("  认证: 原样透传（不解析、不记录）")

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           s,
		ReadHeaderTimeout: 30 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}

func proxyInUse(cfg Config) bool {
	return cfg.Proxy != ""
}

func newHTTPClient(cfg Config) *http.Client {
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// 不主动要求 gzip：压缩后的响应无法改写
		DisableCompression: true,
		TLSClientConfig:    &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if proxyInUse(cfg) {
		pu, err := url.Parse(cfg.Proxy)
		switch {
		case err != nil:
			log.Printf("警告: 代理地址无法解析（%v），改为直连", err)
		case pu.Scheme != "http" && pu.Scheme != "https":
			log.Printf("警告: 不支持的代理协议 %q（只支持 http/https），改为直连", pu.Scheme)
		default:
			transport.Proxy = http.ProxyURL(pu)
		}
	}
	timeout := time.Duration(0)
	if cfg.Timeout > 0 {
		timeout = time.Duration(cfg.Timeout) * time.Second
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

func maskProxy(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if u.User != nil {
		return u.Scheme + "://***@" + u.Host
	}
	return u.Scheme + "://" + u.Host
}

// ───────────────────────────── 请求处理 ─────────────────────────────

// hopByHopHeaders 是 RFC 7230 规定的逐跳头，不应转发。
var hopByHopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"content-length":      true,
	"host":                true,
	// Accept-Encoding 由本程序统一改写为 identity，不转发客户端的值。
	"accept-encoding": true,
}

// maxDecompressedBytes 是单个响应解压后的输出上限，防 zip bomb。
const maxDecompressedBytes = 64 << 20

// splitCodings 把 Content-Encoding 拆成 coding 列表，去掉 identity 和空值。
// HTTP 允许堆叠编码（如 "gzip, zstd"），也允许重复头，语义等同逗号拼接。
func splitCodings(values []string) []string {
	var codings []string
	for _, v := range values {
		for _, c := range strings.Split(v, ",") {
			c = strings.ToLower(strings.TrimSpace(c))
			if c != "" && c != "identity" {
				codings = append(codings, c)
			}
		}
	}
	return codings
}

// decompressBody 按 Content-Encoding 逐层解压。
// 编码按声明顺序应用，解压要逆序。
// 正常情况下上游不会压缩（我们发 identity），这里是兜底。
func decompressBody(body io.Reader, values []string) (io.Reader, error) {
	codings := splitCodings(values)
	if len(codings) == 0 {
		return body, nil
	}
	// 从最后一层往前解
	for i := len(codings) - 1; i >= 0; i-- {
		coding := codings[i]
		var err error
		switch coding {
		case "gzip", "x-gzip":
			body, err = gzip.NewReader(body)
		case "deflate":
			body = flate.NewReader(body)
		default:
			// br / zstd 等标准库没有解码器
			return nil, fmt.Errorf("不支持的 Content-Encoding: %s", coding)
		}
		if err != nil {
			return nil, fmt.Errorf("解压 %s 失败: %w", coding, err)
		}
	}
	return body, nil
}

// readAllLimited 读取全部内容，超过上限则报错（防 zip bomb）。
func readAllLimited(r io.Reader, limit int64) ([]byte, error) {
	out, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(out)) > limit {
		return nil, fmt.Errorf("解压输出超过 %d MB 上限", limit>>20)
	}
	return out, nil
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	// 客户端可能填 http://host:8787/v1 或 http://host:8787
	path := r.URL.Path
	if !strings.HasPrefix(path, "/v1/") && path != "/v1" {
		path = "/v1" + path
	}
	target := s.cfg.Upstream + path
	isChat := strings.HasSuffix(path, "/chat/completions")

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "读取请求体失败: "+err.Error())
		return
	}

	// 只改内容，不动认证
	if isChat && len(body) > 0 {
		body = transformRequestBody(body)
	}

	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "构造上游请求失败: "+err.Error())
		return
	}

	// 原样转发客户端 header（含 Authorization / x-api-key 等认证头）
	for k, vs := range r.Header {
		if hopByHopHeaders[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	// 显式声明不压缩：我们要读明文 JSON 才能改写内容
	if isChat {
		req.Header.Set("Accept-Encoding", "identity")
	}
	req.ContentLength = int64(len(body))
	if req.Header.Get("Content-Type") == "" && len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("上游请求失败: %v", err)
		writeJSONError(w, http.StatusBadGateway, "上游不可达: "+err.Error())
		return
	}
	defer resp.Body.Close()

	// 上游可能无视 identity 仍然压缩，这里兜底解压
	respBody, err := decompressBody(resp.Body, resp.Header.Values("Content-Encoding"))
	if err != nil {
		log.Printf("解压上游响应失败: %v", err)
		writeJSONError(w, http.StatusBadGateway, "上游响应编码不支持: "+err.Error())
		return
	}

	if !isChat {
		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, respBody)
		return
	}

	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		s.streamSSE(w, resp, respBody, started)
		return
	}

	raw, err := readAllLimited(respBody, maxDecompressedBytes)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "读取上游响应失败: "+err.Error())
		return
	}
	out := transformResponseBody(raw)

	h := w.Header()
	copyResponseHeaders(h, resp.Header)
	h.Set("Content-Type", "application/json")
	h.Del("Content-Length")
	w.WriteHeader(resp.StatusCode)
	w.Write(out)
	if s.cfg.Verbose {
		log.Printf("← 非流式 %d %s (%s)", resp.StatusCode, path, time.Since(started))
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for k, vs := range src {
		lower := strings.ToLower(k)
		if lower == "content-length" || lower == "content-encoding" || hopByHopHeaders[lower] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"message": msg, "type": "proxy_error"},
	})
}

// ───────────────────────────── 流式 ─────────────────────────────

func (s *server) streamSSE(w http.ResponseWriter, resp *http.Response, body io.Reader, started time.Time) {
	h := w.Header()
	copyResponseHeaders(h, resp.Header)
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // 让 nginx 不缓冲
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	// 逐行读：SSE 事件以空行分隔，行式读取比攒整块更省内存也更稳
	reader := bufio.NewReaderSize(body, 64*1024)

	var event []string
	flush := func() {
		if len(event) == 0 {
			return
		}
		io.WriteString(w, rewriteEvent(event))
		if flusher != nil {
			flusher.Flush()
		}
		event = event[:0]
	}

	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")
			if trimmed == "" {
				flush()
			} else {
				event = append(event, trimmed)
			}
		}
		if err != nil {
			if err != io.EOF && s.cfg.Verbose {
				log.Printf("读取流失败: %v", err)
			}
			flush()
			break
		}
	}
	if s.cfg.Verbose {
		log.Printf("← 流式完成 %s", time.Since(started))
	}
}

func rewriteEvent(lines []string) string {
	var out strings.Builder
	for _, line := range lines {
		if !strings.HasPrefix(line, "data:") {
			out.WriteString(line)
			out.WriteString("\n")
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			out.WriteString(line)
			out.WriteString("\n")
			continue
		}
		if rewritten, ok := transformChunkJSON([]byte(payload)); ok {
			out.WriteString("data: ")
			out.Write(rewritten)
			out.WriteString("\n")
		} else {
			out.WriteString(line)
			out.WriteString("\n")
		}
	}
	out.WriteString("\n")
	return out.String()
}

// ───────────────────────────── 内容转换 ─────────────────────────────

const idChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

var (
	rngMu sync.Mutex
	rng   = rand.New(rand.NewSource(time.Now().UnixNano()))
)

func randomID() string {
	rngMu.Lock()
	defer rngMu.Unlock()
	b := make([]byte, 9)
	for i := range b {
		b[i] = idChars[rng.Intn(len(idChars))]
	}
	return string(b)
}

func isMistralID(s string) bool {
	if len(s) != 9 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

// flattenContent 把 Mistral 的 content（字符串或 ContentChunk 数组）拍平。
// thinking 分块单独提取，不混入正文。
func flattenContent(content any) (text, reasoning string) {
	switch v := content.(type) {
	case nil:
		return "", ""
	case string:
		return v, ""
	case []any:
		var t, r strings.Builder
		for _, item := range v {
			switch chunk := item.(type) {
			case string:
				t.WriteString(chunk)
			case map[string]any:
				typ, _ := chunk["type"].(string)
				switch typ {
				case "text", "":
					if s, ok := chunk["text"].(string); ok {
						t.WriteString(s)
					}
				case "thinking":
					r.WriteString(flattenThinking(chunk["thinking"]))
				}
				// image_url / document_url / reference / file / tool_reference
				// 在纯文本 delta.content 里放不下，丢弃
			}
		}
		return t.String(), r.String()
	}
	return "", ""
}

func flattenThinking(inner any) string {
	switch v := inner.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					b.WriteString(s)
				}
			}
		}
		return b.String()
	}
	return ""
}

// normalizeRequestContent 请求侧：数组 content 压成字符串。
// 含图片/文档时保留数组结构，避免多模态信息丢失。
func normalizeRequestContent(content any) any {
	arr, ok := content.([]any)
	if !ok {
		return content
	}
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			switch m["type"] {
			case "image_url", "image", "document_url":
				return content
			}
		}
	}
	text, _ := flattenContent(arr)
	return text
}

func remapToolCalls(msg map[string]any, idMap map[string]string) {
	remap := func(id string) string {
		if id == "" || isMistralID(id) {
			return id
		}
		if mapped, ok := idMap[id]; ok {
			return mapped
		}
		mapped := randomID()
		idMap[id] = mapped
		return mapped
	}

	if calls, ok := msg["tool_calls"].([]any); ok {
		for _, c := range calls {
			call, ok := c.(map[string]any)
			if !ok {
				continue
			}
			if id, ok := call["id"].(string); ok {
				call["id"] = remap(id)
			}
			stringifyArgs(call)
		}
	}
	if role, _ := msg["role"].(string); role == "tool" {
		if id, ok := msg["tool_call_id"].(string); ok {
			msg["tool_call_id"] = remap(id)
		}
	}
}

func stringifyArgs(holder map[string]any) {
	fn, ok := holder["function"].(map[string]any)
	if !ok {
		return
	}
	args, exists := fn["arguments"]
	if !exists {
		return
	}
	if _, isStr := args.(string); isStr {
		return
	}
	if b, err := json.Marshal(args); err == nil {
		fn["arguments"] = string(b)
	}
}

func transformRequest(body map[string]any) {
	idMap := map[string]string{}

	if msgs, ok := body["messages"].([]any); ok {
		for _, item := range msgs {
			msg, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if c, exists := msg["content"]; exists {
				msg["content"] = normalizeRequestContent(c)
			}
			remapToolCalls(msg, idMap)
			// Mistral 对未知字段是 extra_forbidden
			delete(msg, "reasoning_content")
			delete(msg, "reasoning")
			delete(msg, "name")
		}
	}

	for _, k := range []string{"logprobs", "top_logprobs", "logit_bias", "store", "metadata", "service_tier", "stream_options"} {
		delete(body, k)
	}
	if stream, _ := body["stream"].(bool); stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
}

func transformResponse(body map[string]any) {
	choices, ok := body["choices"].([]any)
	if !ok {
		return
	}
	for _, c := range choices {
		choice, ok := c.(map[string]any)
		if !ok {
			continue
		}
		msg, ok := choice["message"].(map[string]any)
		if !ok {
			continue
		}
		text, reasoning := flattenContent(msg["content"])
		msg["content"] = text
		if reasoning != "" {
			msg["reasoning_content"] = reasoning
		}
		delete(msg, "reasoning")
		if calls, ok := msg["tool_calls"].([]any); ok {
			for _, c := range calls {
				if call, ok := c.(map[string]any); ok {
					stringifyArgs(call)
				}
			}
		}
	}
}

func transformChunk(body map[string]any) {
	choices, ok := body["choices"].([]any)
	if !ok {
		return
	}
	for _, c := range choices {
		choice, ok := c.(map[string]any)
		if !ok {
			continue
		}
		delta, ok := choice["delta"].(map[string]any)
		if !ok {
			continue
		}
		if content, exists := delta["content"]; exists && content != nil {
			text, reasoning := flattenContent(content)
			delta["content"] = text
			if reasoning != "" {
				prev, _ := delta["reasoning_content"].(string)
				delta["reasoning_content"] = prev + reasoning
			}
		}
		if calls, ok := delta["tool_calls"].([]any); ok {
			for _, c := range calls {
				if call, ok := c.(map[string]any); ok {
					stringifyArgs(call)
				}
			}
		}
	}
}

func transformRequestBody(raw []byte) []byte {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw
	}
	transformRequest(body)
	out, err := json.Marshal(body)
	if err != nil {
		return raw
	}
	return out
}

func transformResponseBody(raw []byte) []byte {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw
	}
	transformResponse(body)
	out, err := json.Marshal(body)
	if err != nil {
		return raw
	}
	return out
}

func transformChunkJSON(raw []byte) ([]byte, bool) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, false
	}
	transformChunk(body)
	out, err := json.Marshal(body)
	if err != nil {
		return nil, false
	}
	return out, true
}
