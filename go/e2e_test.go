package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeMistral 按真实 Mistral schema 返回数组 content，并记录收到的认证头。
func fakeMistral(t *testing.T, seenAuth *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seenAuth = r.Header.Get("Authorization")

		var req map[string]any
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &req)

		// 校验代理剥掉了 Mistral 不认的字段
		if msgs, ok := req["messages"].([]any); ok {
			for _, m := range msgs {
				if msg, ok := m.(map[string]any); ok {
					if _, has := msg["reasoning_content"]; has {
						w.WriteHeader(422)
						w.Write([]byte(`{"detail":[{"type":"extra_forbidden","loc":["body","messages","reasoning_content"]}]}`))
						return
					}
				}
			}
		}

		stream, _ := req["stream"].(bool)
		if stream {
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)
			chunks := []string{
				`{"choices":[{"index":0,"delta":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"思考中"}]}]}}]}`,
				`{"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"你好"}]}}]}`,
				`{"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"，世界"}]}}]}`,
				`{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
			}
			for _, c := range chunks {
				io.WriteString(w, "data: "+c+"\n\n")
				if flusher != nil {
					flusher.Flush()
				}
			}
			io.WriteString(w, "data: [DONE]\n\n")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": "cmpl-1", "object": "chat.completion", "model": "mistral-large-latest",
			"choices": []any{map[string]any{
				"index": 0, "finish_reason": "tool_calls",
				"message": map[string]any{
					"role":    "assistant",
					"content": []any{map[string]any{"type": "text", "text": "我来查一下"}},
					"tool_calls": []any{map[string]any{
						"id": "abcdefghi", "type": "function",
						"function": map[string]any{"name": "get_weather", "arguments": map[string]any{"location": "Tokyo"}},
					}},
				},
			}},
		})
	}))
}

func startProxy(t *testing.T, upstreamURL string) (*httptest.Server, func()) {
	t.Helper()
	cfg := defaultConfig()
	cfg.Upstream = upstreamURL
	s := &server{cfg: cfg, client: newHTTPClient(cfg)}
	srv := httptest.NewServer(s)
	return srv, srv.Close
}

func baseMessages() []any {
	return []any{
		map[string]any{"role": "user", "content": "你好"},
		map[string]any{
			"role": "assistant", "content": "",
			"tool_calls": []any{map[string]any{
				"id": "toolu_01ABCdefGHIjklMNO", "type": "function",
				"function": map[string]any{"name": "get_weather", "arguments": map[string]any{"location": "Tokyo"}},
			}},
		},
		map[string]any{"role": "tool", "tool_call_id": "toolu_01ABCdefGHIjklMNO", "content": "晴"},
	}
}

func postJSON(t *testing.T, proxyURL string, payload map[string]any, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", proxyURL+"/v1/chat/completions", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp, out
}

func TestE2EStream(t *testing.T) {
	var auth string
	up := fakeMistral(t, &auth)
	defer up.Close()
	proxy, stop := startProxy(t, up.URL)
	defer stop()

	resp, body := postJSON(t, proxy.URL, map[string]any{
		"model": "mistral-large-latest", "stream": true, "messages": baseMessages(),
	}, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}

	var contents []string
	var reasoning string
	scanner := bufio.NewScanner(strings.NewReader(string(body)))
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") || strings.Contains(line, "[DONE]") {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &chunk); err != nil {
			continue
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		delta, _ := choices[0].(map[string]any)["delta"].(map[string]any)
		if c, ok := delta["content"]; ok {
			s, isStr := c.(string)
			if !isStr {
				t.Fatalf("content 不是字符串: %T %v", c, c)
			}
			contents = append(contents, s)
		}
		if r, ok := delta["reasoning_content"].(string); ok {
			reasoning += r
		}
	}

	joined := strings.Join(contents, "")
	if joined != "你好，世界" {
		t.Errorf("正文 = %q, want 你好，世界", joined)
	}
	if reasoning != "思考中" {
		t.Errorf("reasoning = %q, want 思考中", reasoning)
	}
	if strings.Contains(joined, "思考中") {
		t.Error("正文不应含 thinking 内容")
	}
	if !strings.Contains(string(body), "[DONE]") {
		t.Error("应保留 [DONE]")
	}
}

func TestE2ENonStream(t *testing.T) {
	var auth string
	up := fakeMistral(t, &auth)
	defer up.Close()
	proxy, stop := startProxy(t, up.URL)
	defer stop()

	resp, body := postJSON(t, proxy.URL, map[string]any{
		"model": "mistral-large-latest", "stream": false, "messages": baseMessages(),
	}, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}

	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	msg := out["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "我来查一下" {
		t.Errorf("content = %v", msg["content"])
	}
	call := msg["tool_calls"].([]any)[0].(map[string]any)
	args := call["function"].(map[string]any)["arguments"]
	if _, ok := args.(string); !ok {
		t.Errorf("arguments 应为字符串: %T", args)
	}
}

func TestE2ERequestStripsReasoning(t *testing.T) {
	var auth string
	up := fakeMistral(t, &auth)
	defer up.Close()
	proxy, stop := startProxy(t, up.URL)
	defer stop()

	resp, body := postJSON(t, proxy.URL, map[string]any{
		"model": "m", "stream": false,
		"messages": []any{map[string]any{"role": "user", "content": "hi", "reasoning_content": "不该发出去"}},
	}, nil)
	if resp.StatusCode == 422 {
		t.Fatalf("reasoning_content 未被剥掉，上游返回 422: %s", body)
	}
	if resp.StatusCode != 200 {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

// 认证头必须原样透传，不解析、不修改
func TestE2EAuthPassthrough(t *testing.T) {
	var seenAuth string
	up := fakeMistral(t, &seenAuth)
	defer up.Close()
	proxy, stop := startProxy(t, up.URL)
	defer stop()

	cases := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{"Bearer", map[string]string{"Authorization": "Bearer sk-test-12345"}, "Bearer sk-test-12345"},
		{"特殊字符", map[string]string{"Authorization": "Bearer sk-a.b_c-d+e/f=g"}, "Bearer sk-a.b_c-d+e/f=g"},
		{"无认证", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			seenAuth = "<未收到>"
			resp, _ := postJSON(t, proxy.URL, map[string]any{
				"model": "m", "stream": false, "messages": baseMessages(),
			}, c.headers)
			if resp.StatusCode != 200 {
				t.Fatalf("status = %d", resp.StatusCode)
			}
			if seenAuth != c.want {
				t.Errorf("上游收到的 Authorization = %q, want %q", seenAuth, c.want)
			}
		})
	}
}

func TestE2EUpstreamDown(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	deadURL := "http://" + ln.Addr().String()
	ln.Close()

	proxy, stop := startProxy(t, deadURL)
	defer stop()

	done := make(chan struct{})
	go func() {
		defer close(done)
		resp, body := postJSON(t, proxy.URL, map[string]any{"model": "m", "messages": baseMessages()}, nil)
		if resp.StatusCode != http.StatusBadGateway {
			t.Errorf("status = %d, want 502; body = %s", resp.StatusCode, body)
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("上游不可达时请求挂住")
	}
}

// 非 chat 路径原样透传，不做内容转换
func TestE2ENonChatPassthrough(t *testing.T) {
	var auth string
	up := fakeMistral(t, &auth)
	defer up.Close()
	proxy, stop := startProxy(t, up.URL)
	defer stop()

	resp, err := http.Get(proxy.URL + "/v1/models")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

// 客户端不带 /v1 前缀也能工作
func TestE2EPathNormalization(t *testing.T) {
	var auth string
	up := fakeMistral(t, &auth)
	defer up.Close()
	proxy, stop := startProxy(t, up.URL)
	defer stop()

	body, _ := json.Marshal(map[string]any{"model": "m", "stream": false, "messages": baseMessages()})
	resp, err := http.Post(proxy.URL+"/chat/completions", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d（应自动补 /v1）", resp.StatusCode)
	}
}

// 上游无视 Accept-Encoding 仍然返回 gzip 时，必须能正确解压
func TestE2EGzipUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload := `{"choices":[{"message":{"role":"assistant","content":[{"type":"text","text":"压缩响应"}]}}]}`
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write([]byte(payload))
		gz.Close()
	}))
	defer up.Close()

	proxy, stop := startProxy(t, up.URL)
	defer stop()

	resp, body := postJSON(t, proxy.URL, map[string]any{
		"model": "m", "stream": false, "messages": baseMessages(),
	}, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("响应不是合法 JSON（可能未解压）: %v\n原始: %q", err, body)
	}
	msg := out["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "压缩响应" {
		t.Errorf("content = %v", msg["content"])
	}
}

// 代理应把 Accept-Encoding 改写成 identity，而不是转发客户端的值
func TestE2EAcceptEncodingIdentity(t *testing.T) {
	var seenEncoding string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenEncoding = r.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer up.Close()

	proxy, stop := startProxy(t, up.URL)
	defer stop()

	postJSON(t, proxy.URL, map[string]any{
		"model": "m", "stream": false, "messages": baseMessages(),
	}, map[string]string{"Accept-Encoding": "gzip, deflate, br"})

	if seenEncoding != "identity" {
		t.Errorf("Accept-Encoding 应为 identity，实际收到 %q", seenEncoding)
	}
}
