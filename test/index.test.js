import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelId,
  resolveEnvPlaceholder,
  normalizeBaseUrl,
  stripJsonComments,
  makeCacheKey,
  extractSnippetForSource,
  escapeMarkdown,
  escapeMarkdownUrl,
  buildCitationInsertions,
  insertMarkersByUtf8Index,
  formatOutput,
  isFatalClientError,
  runGoogleGrounding,
  FatalError,
} from "../index.js";
import plugin from "../index.js";

test("stripJsonComments strips comments AND trailing commas while preserving strings", () => {
  const rawJsonc = `{
    // Single-line comment with [1, 2,]
    "url": "https://example.com/a,}", /* Multi-line
    comment */
    "models": [
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash", // trailing comma in array
    ],
    "nested": {
      "enabled": true, /* inline comment */
    },
  }`;

  const cleaned = stripJsonComments(rawJsonc);
  const parsed = JSON.parse(cleaned);

  assert.equal(parsed.url, "https://example.com/a,}");
  assert.deepEqual(parsed.models, ["gemini-3.5-flash-lite", "gemini-3.8-flash"]);
  assert.equal(parsed.nested.enabled, true);
});

test("resolveEnvPlaceholder resolves both standalone and embedded placeholders", () => {
  process.env.TEST_GROUNDING_HOST = "my-gateway.local";
  process.env.TEST_GROUNDING_KEY = "sk-test-123";

  assert.equal(resolveEnvPlaceholder("{env:TEST_GROUNDING_KEY}"), "sk-test-123");
  assert.equal(
    resolveEnvPlaceholder("https://{env:TEST_GROUNDING_HOST}:8080/v1beta"),
    "https://my-gateway.local:8080/v1beta"
  );

  delete process.env.TEST_GROUNDING_HOST;
  delete process.env.TEST_GROUNDING_KEY;
});

test("normalizeBaseUrl normalizes root domains, /models suffixes, and trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://my-proxy.example.com/"), "https://my-proxy.example.com/v1beta");
  assert.equal(normalizeBaseUrl("https://my-proxy.example.com/v1beta/models/"), "https://my-proxy.example.com/v1beta");
  assert.equal(normalizeBaseUrl("https://my-proxy.example.com/v1"), "https://my-proxy.example.com/v1");
  assert.equal(
    normalizeBaseUrl("https://generativelanguage.googleapis.com/v1beta/"),
    "https://generativelanguage.googleapis.com/v1beta"
  );
});

test("makeCacheKey differentiates across query, context, model, and maxSources", () => {
  const kBase = makeCacheKey("OpenCode V2", "ctx", "gemini-3.5-flash-lite", 8);
  const kDiffModel = makeCacheKey("OpenCode V2", "ctx", "gemini-3.8-flash", 8);
  const kDiffMax = makeCacheKey("OpenCode V2", "ctx", "gemini-3.5-flash-lite", 15);
  const kSameNormalized = makeCacheKey("  opencode v2 ", "CTX", "google/gemini-3.5-flash-lite", 8);

  assert.notEqual(kBase, kDiffModel);
  assert.notEqual(kBase, kDiffMax);
  assert.equal(kBase, kSameNormalized);
});

test("insertMarkersByUtf8Index aligns multi-byte UTF-8 boundaries and steps before newlines", () => {
  // '你好世界\n第二行' -> '你'(0..2), '好'(3..5), '世'(6..8), '界'(9..11), '\n'(12)
  const text = "你好世界\n第二行";

  // Case 1: endIndex=4 lands in the middle of '好' (bytes 3,4,5) -> should align to byte 6 ('你好[1]世界')
  const aligned = insertMarkersByUtf8Index(text, [{ index: 4, marker: "[1]" }]);
  assert.equal(aligned, "你好[1]世界\n第二行");

  // Case 2: endIndex=13 includes trailing '\n' (byte 12) -> should step back before '\n' so '[2]' stays on line 1
  const beforeNewline = insertMarkersByUtf8Index(text, [{ index: 13, marker: "[2]" }]);
  assert.equal(beforeNewline, "你好世界[2]\n第二行");
});

test("escapeMarkdown and escapeMarkdownUrl prevent broken Markdown links", () => {
  assert.equal(escapeMarkdown("Rust [Programming]\nLanguage"), "Rust \\[Programming\\] Language");
  assert.equal(
    escapeMarkdownUrl("https://en.wikipedia.org/wiki/Rust_(programming_language)"),
    "https://en.wikipedia.org/wiki/Rust_%28programming_language%29"
  );
});

test("extractSnippetForSource extracts concise sentence from long paragraph", () => {
  const longParagraph = [
    "第一句是非常长的前置背景介绍，包含了大量无关的铺垫信息，用来测试当整段文字超过一百六十个字符时的分句提取效果，确保不会把整段文字全部塞进单张卡片里浪费上下文空间[1]。",
    "第二句是真正引用了第二个来源的核心事实结论，数据非常关键且简明扼要[2]。",
    "第三句则是完全无关的收尾补充说明，同样具有一定长度以确保总字数超过阈值[3]。",
  ].join("");

  const snippet2 = extractSnippetForSource(2, longParagraph);
  assert.equal(snippet2, "第二句是真正引用了第二个来源的核心事实结论，数据非常关键且简明扼要[2]。");
});

test("isFatalClientError distinguishes global auth failures from model-specific 400/403 errors", () => {
  assert.equal(isFatalClientError(401, { error: { message: "Unauthorized" } }), true);
  assert.equal(
    isFatalClientError(400, { error: { message: "API key not valid. Please pass a valid API key." } }),
    true
  );
  assert.equal(
    isFatalClientError(400, { error: { message: "Search grounding is not supported for this model." } }),
    false
  );
  assert.equal(
    isFatalClientError(403, { error: { message: "Model gemini-3-flash-preview is not enabled for this channel" } }),
    false
  );
});

test("formatOutput remaps citations and escapes Wikipedia-style parentheses in URLs", () => {
  const rawText = "Rust is memory-safe.";
  const metadata = {
    groundingChunks: [
      { web: { title: "Unused Source", uri: "https://example.com/unused" } },
      {
        web: {
          title: "Rust [Wiki]",
          uri: "https://en.wikipedia.org/wiki/Rust_(programming_language)",
        },
      },
    ],
    groundingSupports: [
      {
        segment: { startIndex: 0, endIndex: 20 },
        groundingChunkIndices: [1],
      },
    ],
    webSearchQueries: ["rust memory safety"],
  };

  const out = formatOutput(rawText, metadata, 8);
  assert.ok(out.content.includes("Rust is memory-safe.[1]"));
  assert.ok(
    out.content.includes("[1] [Rust \\[Wiki\\]](https://en.wikipedia.org/wiki/Rust_%28programming_language%29)")
  );
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].index, 1);
});

test("normalizeModelId strips provider prefix cleanly", () => {
  assert.equal(normalizeModelId("google/gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(normalizeModelId("  gemini-3.8-flash "), "gemini-3.8-flash");
  assert.equal(normalizeModelId(""), "");
});

test("runGoogleGrounding falls back on model-specific 400 and deduplicates concurrent requests", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 20));
    if (String(url).includes("bad-model")) {
      return new Response(
        JSON.stringify({ error: { code: 400, message: "Search grounding is not supported for bad-model" } }),
        { status: 400 }
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "Fallback succeeded." }] },
            groundingMetadata: {
              groundingChunks: [{ web: { title: "Official Doc", uri: "https://opencode.ai/docs" } }],
              groundingSupports: [{ segment: { startIndex: 0, endIndex: 19 }, groundingChunkIndices: [0] }],
              webSearchQueries: ["opencode v2"],
            },
          },
        ],
      }),
      { status: 200 }
    );
  };

  try {
    const runCtx = {
      options: {
        apiKey: "test-key",
        model: "bad-model",
        fallbackModels: ["good-model"],
        cacheTtlMs: 0,
      },
    };

    // Launch two identical concurrent calls to verify Singleflight deduplication
    const [res1, res2] = await Promise.all([
      runGoogleGrounding({ query: "test concurrent fallback" }, runCtx),
      runGoogleGrounding({ query: "test concurrent fallback" }, runCtx),
    ]);

    assert.equal(res1.model, "good-model");
    assert.equal(res2.model, "good-model");
    assert.ok(res1.content.includes("Fallback succeeded.[1]"));
    // Exactly 2 fetch calls total (1 to bad-model + 1 to good-model), NOT 4!
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runGoogleGrounding halts immediately on global invalid API key 400 error", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(
      JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }),
      { status: 400 }
    );
  };

  try {
    await assert.rejects(
      () =>
        runGoogleGrounding(
          { query: "test fatal auth" },
          {
            options: {
              apiKey: "invalid-key",
              model: "model-1",
              fallbackModels: ["model-2", "model-3"],
              cacheTtlMs: 0,
            },
          }
        ),
      (err) => err instanceof FatalError
    );
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin setup registers only google_grounding by default and websearch_cited when enabled", async () => {
  const registeredDefault = [];
  await plugin.setup({
    options: {},
    tool: {
      transform: async (fn) => {
        fn({
          namespace: () => {},
          add: (t) => registeredDefault.push(t.name),
        });
      },
    },
  });
  assert.deepEqual(registeredDefault, ["google_grounding"]);

  const registeredLegacy = [];
  await plugin.setup({
    options: { enableLegacyAlias: true },
    tool: {
      transform: async (fn) => {
        fn({
          namespace: () => {},
          add: (t) => registeredLegacy.push(t.name),
        });
      },
    },
  });
  assert.deepEqual(registeredLegacy, ["google_grounding", "websearch_cited"]);
});
