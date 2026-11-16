package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestFlattenContent(t *testing.T) {
	cases := []struct {
		name      string
		in        any
		wantText  string
		wantThink string
	}{
		{"nil", nil, "", ""},
		{"字符串", "hello", "hello", ""},
		{"text 分块", []any{
			map[string]any{"type": "text", "text": "你好"},
			map[string]any{"type": "text", "text": "世界"},
		}, "你好世界", ""},
		{"thinking 分离", []any{
			map[string]any{"type": "thinking", "thinking": []any{
				map[string]any{"type": "text", "text": "思考中"},
			}},
			map[string]any{"type": "text", "text": "答案"},
		}, "答案", "思考中"},
		{"空数组", []any{}, "", ""},
		{"无 type 视为 text", []any{
			map[string]any{"text": "裸文本"},
		}, "裸文本", ""},
		{"图片分块丢弃", []any{
			map[string]any{"type": "text", "text": "看这个"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "x"}},
		}, "看这个", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			text, reasoning := flattenContent(c.in)
			if text != c.wantText {
				t.Errorf("text = %q, want %q", text, c.wantText)
			}
			if reasoning != c.wantThink {
				t.Errorf("reasoning = %q, want %q", reasoning, c.wantThink)
			}
		})
	}
}

func TestIsMistralID(t *testing.T) {
	cases := map[string]bool{
		"abcdefghi":               true,
		"ABC123xyz":               true,
		"toolu_01ABCdefGHIjklMNO": false,
		"abc":                     false,
		"abcdefghij":              false,
		"abcdefgh-":               false,
		"":                        false,
	}
	for id, want := range cases {
		if got := isMistralID(id); got != want {
			t.Errorf("isMistralID(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestTransformRequestToolCalls(t *testing.T) {
	body := map[string]any{
		"model": "mistral-large-latest",
		"messages": []any{
			map[string]any{"role": "user", "content": "天气如何"},
			map[string]any{
				"role":    "assistant",
				"content": "",
				"tool_calls": []any{
					map[string]any{
						"id":   "toolu_01ABCdefGHIjklMNO",
						"type": "function",
						"function": map[string]any{
							"name":      "get_weather",
							"arguments": map[string]any{"location": "Tokyo"},
						},
					},
				},
			},
			map[string]any{"role": "tool", "tool_call_id": "toolu_01ABCdefGHIjklMNO", "content": "晴"},
		},
	}
	transformRequest(body)

	msgs := body["messages"].([]any)
	asst := msgs[1].(map[string]any)
	call := asst["tool_calls"].([]any)[0].(map[string]any)
	id := call["id"].(string)

	if !isMistralID(id) {
		t.Errorf("tool id 未重写为 9 位: %q", id)
	}
	toolMsg := msgs[2].(map[string]any)
	if toolMsg["tool_call_id"] != id {
		t.Errorf("tool_call_id 未同步: %v vs %v", toolMsg["tool_call_id"], id)
	}
	args := call["function"].(map[string]any)["arguments"]
	if _, ok := args.(string); !ok {
		t.Errorf("arguments 未转字符串: %T", args)
	}
	if args != `{"location":"Tokyo"}` {
		t.Errorf("arguments = %v", args)
	}
}

func TestTransformRequestStripsFields(t *testing.T) {
	body := map[string]any{
		"model":  "m",
		"stream": true,
		"messages": []any{
			map[string]any{"role": "user", "content": "hi", "reasoning_content": "x", "name": "u"},
		},
		"logprobs":     true,
		"store":        false,
		"metadata":     map[string]any{"a": 1},
		"service_tier": "auto",
	}
	transformRequest(body)

	for _, k := range []string{"logprobs", "store", "metadata", "service_tier"} {
		if _, ok := body[k]; ok {
			t.Errorf("字段 %q 应被删除", k)
		}
	}
	msg := body["messages"].([]any)[0].(map[string]any)
	for _, k := range []string{"reasoning_content", "name"} {
		if _, ok := msg[k]; ok {
			t.Errorf("message 字段 %q 应被删除", k)
		}
	}
	so, ok := body["stream_options"].(map[string]any)
	if !ok || so["include_usage"] != true {
		t.Errorf("stream_options.include_usage 未设置: %v", body["stream_options"])
	}
}

func TestTransformRequestMultimodal(t *testing.T) {
	original := []any{
		map[string]any{"type": "text", "text": "描述这张图"},
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:..."}},
	}
	body := map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": original},
	}}
	transformRequest(body)

	got := body["messages"].([]any)[0].(map[string]any)["content"]
	arr, ok := got.([]any)
	if !ok {
		t.Fatalf("多模态 content 应保留数组，实际 %T", got)
	}
	if len(arr) != 2 {
		t.Errorf("数组长度 = %d, want 2", len(arr))
	}
}

func TestTransformResponse(t *testing.T) {
	body := map[string]any{
		"choices": []any{
			map[string]any{
				"message": map[string]any{
					"role": "assistant",
					"content": []any{
						map[string]any{"type": "thinking", "thinking": []any{
							map[string]any{"type": "text", "text": "思考中"},
						}},
						map[string]any{"type": "text", "text": "答案"},
					},
				},
			},
		},
	}
	transformResponse(body)

	msg := body["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "答案" {
		t.Errorf("content = %v, want 答案", msg["content"])
	}
	if msg["reasoning_content"] != "思考中" {
		t.Errorf("reasoning_content = %v, want 思考中", msg["reasoning_content"])
	}
}

func TestTransformChunk(t *testing.T) {
	body := map[string]any{
		"choices": []any{
			map[string]any{
				"delta": map[string]any{
					"content": []any{
						map[string]any{"type": "text", "text": "你好"},
						map[string]any{"type": "text", "text": "世界"},
					},
				},
			},
		},
	}
	transformChunk(body)

	delta := body["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)
	if delta["content"] != "你好世界" {
		t.Errorf("content = %v, want 你好世界", delta["content"])
	}
}

func TestTransformChunkThinkingAccumulates(t *testing.T) {
	mk := func(s string) map[string]any {
		return map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
			"content": []any{map[string]any{"type": "thinking", "thinking": []any{
				map[string]any{"type": "text", "text": s},
			}}},
		}}}}
	}
	b1, b2 := mk("第一段"), mk("第二段")
	transformChunk(b1)
	transformChunk(b2)

	d1 := b1["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)
	d2 := b2["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)
	if d1["reasoning_content"] != "第一段" || d2["reasoning_content"] != "第二段" {
		t.Errorf("thinking 提取错误: %v / %v", d1["reasoning_content"], d2["reasoning_content"])
	}
	if d1["content"] != "" || d2["content"] != "" {
		t.Errorf("正文不应含 thinking 内容")
	}
}

func TestTransformChunkEdges(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"无 choices", `{"id":"x"}`},
		{"choices 非数组", `{"choices":"x"}`},
		{"delta 缺失", `{"choices":[{"index":0}]}`},
		{"content 为 null", `{"choices":[{"delta":{"content":null}}]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, ok := transformChunkJSON([]byte(c.in)); !ok {
				t.Errorf("应能处理: %s", c.in)
			}
		})
	}
	if _, ok := transformChunkJSON([]byte("not json")); ok {
		t.Error("非 JSON 应返回 false")
	}
}

func TestRewriteEvent(t *testing.T) {
	lines := []string{`data: {"choices":[{"delta":{"content":[{"type":"text","text":"hi"}]}}]}`}
	out := rewriteEvent(lines)
	if !strings.HasSuffix(out, "\n\n") {
		t.Errorf("事件应以空行结尾: %q", out)
	}
	payload := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "data:"))
	var body map[string]any
	if err := json.Unmarshal([]byte(payload), &body); err != nil {
		t.Fatalf("解析失败: %v (raw=%s)", err, payload)
	}
	delta := body["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)
	if delta["content"] != "hi" {
		t.Errorf("content = %v, want hi", delta["content"])
	}
}

func TestRewriteEventPassthrough(t *testing.T) {
	for _, in := range []string{
		`data: [DONE]`,
		`data: `,
		`event: ping`,
		`data: not-json`,
	} {
		out := rewriteEvent([]string{in})
		if !strings.Contains(out, strings.TrimSpace(in)) {
			t.Errorf("应原样透传 %q，实际 %q", in, out)
		}
	}
}

func TestRewriteEventMultiLine(t *testing.T) {
	// 一个事件含 event: 和 data: 两行
	out := rewriteEvent([]string{
		"event: message",
		`data: {"choices":[{"delta":{"content":"x"}}]}`,
	})
	if !strings.Contains(out, "event: message") {
		t.Errorf("event 行应保留: %q", out)
	}
	if !strings.Contains(out, `"content":"x"`) {
		t.Errorf("data 行应保留: %q", out)
	}
}

func TestMaskProxy(t *testing.T) {
	if got := maskProxy("http://user:pass@127.0.0.1:7890"); strings.Contains(got, "pass") {
		t.Errorf("密码未隐藏: %s", got)
	} else if got != "http://***@127.0.0.1:7890" {
		t.Errorf("got %q", got)
	}
	if got := maskProxy("http://127.0.0.1:7890"); got != "http://127.0.0.1:7890" {
		t.Errorf("got %q", got)
	}
}

func TestSplitCodings(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{nil, nil},
		{[]string{""}, nil},
		{[]string{"identity"}, nil},
		{[]string{"gzip"}, []string{"gzip"}},
		{[]string{"gzip, zstd"}, []string{"gzip", "zstd"}},
		{[]string{"gzip", "zstd"}, []string{"gzip", "zstd"}},
		{[]string{" GZIP , identity , deflate "}, []string{"gzip", "deflate"}},
	}
	for _, c := range cases {
		got := splitCodings(c.in)
		if len(got) != len(c.want) {
			t.Errorf("splitCodings(%v) = %v, want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("splitCodings(%v) = %v, want %v", c.in, got, c.want)
				break
			}
		}
	}
}

func TestDecompressBodyStacked(t *testing.T) {
	// 先 gzip 再 deflate：Content-Encoding: gzip, deflate
	// 按规范编码从左到右应用，解压要从右往左
	original := []byte(`{"hello":"world"}`)

	var gzBuf bytes.Buffer
	gz := gzip.NewWriter(&gzBuf)
	gz.Write(original)
	gz.Close()

	var flBuf bytes.Buffer
	fl, _ := flate.NewWriter(&flBuf, flate.DefaultCompression)
	fl.Write(gzBuf.Bytes())
	fl.Close()

	r, err := decompressBody(bytes.NewReader(flBuf.Bytes()), []string{"gzip, deflate"})
	if err != nil {
		t.Fatalf("decompressBody: %v", err)
	}
	got, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != string(original) {
		t.Errorf("got %q, want %q", got, original)
	}
}

func TestDecompressBodyUnsupported(t *testing.T) {
	for _, enc := range []string{"br", "zstd", "gzip, br"} {
		if _, err := decompressBody(strings.NewReader("x"), []string{enc}); err == nil {
			t.Errorf("%q 应返回错误", enc)
		}
	}
}

func TestDecompressBodyIdentity(t *testing.T) {
	for _, enc := range [][]string{nil, {""}, {"identity"}} {
		r, err := decompressBody(strings.NewReader("plain"), enc)
		if err != nil {
			t.Fatalf("%v: %v", enc, err)
		}
		got, _ := io.ReadAll(r)
		if string(got) != "plain" {
			t.Errorf("%v: got %q", enc, got)
		}
	}
}

func TestReadAllLimited(t *testing.T) {
	// 正常范围内
	got, err := readAllLimited(strings.NewReader("hello"), 100)
	if err != nil || string(got) != "hello" {
		t.Errorf("got %q, err %v", got, err)
	}
	// 刚好等于上限
	if _, err := readAllLimited(strings.NewReader("12345"), 5); err != nil {
		t.Errorf("等于上限应允许: %v", err)
	}
	// 超过上限
	if _, err := readAllLimited(strings.NewReader("123456"), 5); err == nil {
		t.Error("超过上限应报错")
	}
}
