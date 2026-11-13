import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeModelId,
  resolveEnvPlaceholder,
  resolvePlaceholders,
  normalizeBaseUrl,
  isOfficialGoogleEndpoint,
  buildRequestHeaders,
  makeCacheKey,
  extractSnippetForSource,
  stripJsonComments,
  readCredentialFromSqlite,
  resolveConfig,
  formatOutput,
  isFatalClientError,
  runGoogleGrounding,
  escapeMarkdown,
  escapeMarkdownUrl,
  buildCitationInsertions,
  insertMarkersByUtf8Index,
  FatalError,
} from "../index.js";
import plugin from "../index.js";

function withIsolatedEnv(fn) {
  return async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-grounding-test-"));
    const xdgConfig = path.join(tmpRoot, "config");
    const xdgData = path.join(tmpRoot, "data");
    fs.mkdirSync(xdgConfig, { recursive: true });
    fs.mkdirSync(xdgData, { recursive: true });

    const envKeys = [
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG",
      "OPENCODE_GOOGLE_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
      "OPENCODE_GOOGLE_BASE_URL",
      "OPENCODE_GOOGLE_MODEL",
      "OPENCODE_GOOGLE_FALLBACK_MODELS",
      "OPENCODE_GOOGLE_THINKING_LEVEL",
      "OPENCODE_GOOGLE_AUTH_MODE",
      "OPENCODE_GOOGLE_TIMEOUT_MS",
      "OPENCODE_GOOGLE_REQUEST_TIMEOUT_MS",
      "OPENCODE_GOOGLE_CACHE_TTL_MS",
    ];
    const saved = new Map();
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_DATA_HOME = xdgData;

    try {
      await fn(t, { tmpRoot, xdgConfig, xdgData });
    } finally {
      for (const [key, val] of saved.entries()) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  };
}

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

test("resolveEnvPlaceholder / resolvePlaceholders resolves {file:...} with absolute, relative, and missing paths", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-file-ph-"));
  try {
    const absSecret = path.join(tmpDir, "abs-secret.txt");
    const relDir = path.join(tmpDir, "sub");
    fs.mkdirSync(relDir, { recursive: true });
    const relSecret = path.join(relDir, "key.txt");

    fs.writeFileSync(absSecret, "  AIza-abs-secret \n", "utf-8");
    fs.writeFileSync(relSecret, "AIza-rel-secret\r\n", "utf-8");

    assert.equal(resolveEnvPlaceholder(`{file:${absSecret}}`), "AIza-abs-secret");
    assert.equal(resolvePlaceholders("{file:./sub/key.txt}", tmpDir), "AIza-rel-secret");
    assert.equal(resolvePlaceholders("Bearer {file:./sub/key.txt}", tmpDir), "Bearer AIza-rel-secret");
    assert.equal(resolvePlaceholders("{file:./does-not-exist.txt}", tmpDir), "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

test("makeCacheKey differentiates across query, context, model, maxSources, and custom baseURL", () => {
  const kBase = makeCacheKey("OpenCode V2", "ctx", "gemini-3.5-flash-lite", 8);
  const kDiffModel = makeCacheKey("OpenCode V2", "ctx", "gemini-3.8-flash", 8);
  const kDiffMax = makeCacheKey("OpenCode V2", "ctx", "gemini-3.5-flash-lite", 15);
  const kSameNormalized = makeCacheKey("  opencode v2 ", "CTX", "google/gemini-3.5-flash-lite#xhigh", 8);
  const kOfficialBase = makeCacheKey(
    "OpenCode V2",
    "ctx",
    "gemini-3.5-flash-lite",
    8,
    "https://generativelanguage.googleapis.com/v1beta/"
  );
  const kCustomProxy = makeCacheKey("OpenCode V2", "ctx", "gemini-3.5-flash-lite", 8, "https://proxy.example.com");

  assert.notEqual(kBase, kDiffModel);
  assert.notEqual(kBase, kDiffMax);
  assert.equal(kBase, kSameNormalized);
  assert.equal(kBase, kOfficialBase);
  assert.notEqual(kBase, kCustomProxy);
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
  assert.equal(isFatalClientError(401, null, "Unauthorized"), true);
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

test("normalizeModelId strips provider prefix AND OpenCode V2 #variant suffix cleanly", () => {
  assert.equal(normalizeModelId("google/gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(normalizeModelId("google/gemini-4-hydrogen#xhigh"), "gemini-4-hydrogen");
  assert.equal(normalizeModelId("indor/gemini-3.8-flash#low"), "gemini-3.8-flash");
  assert.equal(normalizeModelId("gemini-4-hydrogen#high"), "gemini-4-hydrogen");
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

test(
  "resolveConfig v1.5.0 defaults, OPENCODE_GOOGLE_FALLBACK_MODELS, GOOGLE_GENERATIVE_AI_API_KEY, and project configs",
  withIsolatedEnv(async (_t, { tmpRoot }) => {
    const defaults = resolveConfig({}, { directory: tmpRoot });
    assert.equal(defaults.model, "gemini-4-hydrogen");
    assert.equal(defaults.requestTimeoutMs, 60000);
    assert.equal(defaults.timeoutMs, 180000);
    assert.equal(defaults.thinkingLevel, undefined);
    assert.deepEqual(defaults.fallbackModels, [
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.7-flash",
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ]);

    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "gai-env-key";
    process.env.OPENCODE_GOOGLE_FALLBACK_MODELS = "gemini-4-hydrogen, gemini-3.8-flash";
    process.env.OPENCODE_GOOGLE_THINKING_LEVEL = "medium";

    const projDir = path.join(tmpRoot, "project");
    fs.mkdirSync(path.join(projDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, ".opencode", "opencode.jsonc"),
      `{
        "providers": {
          "google": {
            "settings": {
              "baseURL": "https://proj-proxy.example.com",
              "headers": { "X-Project": "yes" }
            }
          }
        }
      }`
    );

    const resolved = resolveConfig({}, { directory: projDir });
    assert.equal(resolved.apiKey, "gai-env-key");
    assert.equal(resolved.baseURL, "https://proj-proxy.example.com/v1beta");
    assert.deepEqual(resolved.fallbackModels, ["gemini-4-hydrogen", "gemini-3.8-flash"]);
    assert.equal(resolved.thinkingLevel, "MEDIUM");
    assert.deepEqual(resolved.headers, { "X-Project": "yes" });
  })
);

test(
  "readCredentialFromSqlite and resolveConfig read active/migrated key, metadata, and oauth credentials from opencode.db",
  withIsolatedEnv(async (_t, { xdgData }) => {
    const dbDir = path.join(xdgData, "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE credential (
        id TEXT PRIMARY KEY,
        integration_id TEXT,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        connector_id TEXT,
        method_id TEXT,
        active INTEGER,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
    `);

    // Migrated V1 record (active: null) when no active:1 row exists
    db.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cred_migrated",
      "indor",
      "Migrated Key",
      JSON.stringify({ type: "key", key: "migrated-v1-key" }),
      null,
      1000,
      1000
    );

    // Migrated V1 record (active: null) vs explicitly active record (active: 1)
    db.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cred_old",
      "google",
      "Old Migrated",
      JSON.stringify({ type: "key", key: "old-migrated-key" }),
      null,
      1000,
      1000
    );

    db.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cred_oauth",
      "google",
      "Google OAuth",
      JSON.stringify({ type: "oauth", methodID: "oauth", refresh: "r1", access: "oauth-access-token", expires: 9999999999999 }),
      1,
      2000,
      2000
    );

    db.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "cred_gg",
      "google-grounding",
      "Google Grounding",
      JSON.stringify({
        type: "key",
        key: "ui-saved-key",
        metadata: { baseURL: "https://ui-proxy.example.com", model: "gemini-3.8-flash" },
      }),
      1,
      3000,
      3000
    );
    db.close();

    const indorCred = readCredentialFromSqlite("indor", dbPath);
    assert.equal(indorCred.apiKey, "migrated-v1-key");

    const ggCred = readCredentialFromSqlite("google-grounding", dbPath);
    assert.equal(ggCred.apiKey, "ui-saved-key");
    assert.equal(ggCred.baseURL, "https://ui-proxy.example.com");
    assert.equal(ggCred.model, "gemini-3.8-flash");
    assert.equal(ggCred.authType, "key");

    const googleCred = readCredentialFromSqlite("google", dbPath);
    assert.equal(googleCred.apiKey, "oauth-access-token");
    assert.equal(googleCred.authType, "oauth");

    // resolveConfig automatically picks up opencode.db from XDG_DATA_HOME/opencode/opencode.db
    const cfg = resolveConfig({});
    assert.equal(cfg.apiKey, "ui-saved-key");
    assert.equal(cfg.baseURL, "https://ui-proxy.example.com/v1beta");
    assert.equal(cfg.model, "gemini-3.8-flash");
    assert.equal(cfg.authType, "key");
  })
);

test(
  "auth header routing: official Google sends x-goog-api-key only, third-party sends both, oauth sends Bearer only",
  withIsolatedEnv(async () => {
    const officialHeaders = buildRequestHeaders({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AQ.official-key",
      authType: "key",
      authMode: "auto",
    });
    assert.equal(officialHeaders["x-goog-api-key"], "AQ.official-key");
    assert.equal(officialHeaders["Authorization"], undefined);

    const proxyHeaders = buildRequestHeaders({
      baseURL: "https://my-oneapi.example.com/v1beta",
      apiKey: "sk-proxy-key",
      authType: "key",
      authMode: "auto",
    });
    assert.equal(proxyHeaders["x-goog-api-key"], "sk-proxy-key");
    assert.equal(proxyHeaders["Authorization"], "Bearer sk-proxy-key");

    const oauthHeaders = buildRequestHeaders({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "ya29.oauth-token",
      authType: "oauth",
      authMode: "auto",
    });
    assert.equal(oauthHeaders["x-goog-api-key"], undefined);
    assert.equal(oauthHeaders["Authorization"], "Bearer ya29.oauth-token");

    const forcedBearer = buildRequestHeaders({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "key-1",
      authType: "key",
      authMode: "bearer",
      headers: { "X-Custom-Header": "abc" },
    });
    assert.equal(forcedBearer["x-goog-api-key"], undefined);
    assert.equal(forcedBearer["Authorization"], "Bearer key-1");
    assert.equal(forcedBearer["X-Custom-Header"], "abc");
  })
);

test(
  "thinkingConfig is omitted by default and only injected for Gemini 3/4 when explicitly configured",
  withIsolatedEnv(async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies = [];

    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Answer text." }] },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      // 1. Default: no thinkingConfig
      await runGoogleGrounding(
        { query: "default thinking" },
        { options: { apiKey: "k", model: "gemini-4-hydrogen", cacheTtlMs: 0 } }
      );
      assert.equal(capturedBodies[0].generationConfig, undefined);

      // 2. Explicit thinkingLevel on Gemini 4
      await runGoogleGrounding(
        { query: "explicit low thinking" },
        { options: { apiKey: "k", model: "gemini-4-hydrogen", thinkingLevel: "low", cacheTtlMs: 0 } }
      );
      assert.deepEqual(capturedBodies[1].generationConfig, {
        thinkingConfig: { thinkingLevel: "LOW" },
      });

      // 3. Explicit thinkingLevel on Gemini 2.5 -> omitted cleanly
      await runGoogleGrounding(
        { query: "gemini 2.5" },
        { options: { apiKey: "k", model: "gemini-2.5-flash", thinkingLevel: "high", cacheTtlMs: 0 } }
      );
      assert.equal(capturedBodies[2].generationConfig, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  "Singleflight deduplicates concurrent calls WITH AbortSignals and isolates individual abort",
  withIsolatedEnv(async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let fetchAborted = false;
    let notifyFetchStarted = null;

    globalThis.fetch = async (_url, init) => {
      fetchCalls++;
      notifyFetchStarted?.();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    finishReason: "STOP",
                    content: { parts: [{ text: "Shared result ok." }] },
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }, 40);

        init.signal?.addEventListener("abort", () => {
          fetchAborted = true;
          clearTimeout(timer);
          reject(init.signal.reason || new Error("Aborted"));
        });
      });
    };

    try {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const opts = { options: { apiKey: "k", model: "gemini-4-hydrogen", cacheTtlMs: 0 } };

      const p1 = runGoogleGrounding({ query: "shared abort test" }, { ...opts, signal: c1.signal });
      const p2 = runGoogleGrounding({ query: "shared abort test" }, { ...opts, signal: c2.signal });

      // Abort only caller 1
      c1.abort(new Error("Caller 1 cancelled"));

      await assert.rejects(() => p1, /Caller 1 cancelled/);
      const res2 = await p2;

      assert.equal(fetchCalls, 1);
      assert.equal(fetchAborted, false);
      assert.ok(res2.content.includes("Shared result ok."));

      // Now verify when ALL callers abort AFTER fetch started, underlying fetch IS aborted
      const started = new Promise((r) => {
        notifyFetchStarted = r;
      });
      const c3 = new AbortController();
      const c4 = new AbortController();
      const p3 = runGoogleGrounding({ query: "all abort test" }, { ...opts, signal: c3.signal });
      const p4 = runGoogleGrounding({ query: "all abort test" }, { ...opts, signal: c4.signal });

      await started;
      c3.abort(new Error("c3 abort"));
      assert.equal(fetchAborted, false);
      c4.abort(new Error("c4 abort"));

      await assert.rejects(() => p3, /c3 abort/);
      await assert.rejects(() => p4, /c4 abort/);
      assert.equal(fetchAborted, true);
      assert.equal(fetchCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  "non-JSON 401 immediately throws FatalError and long errors with key= are truncated and redacted",
  withIsolatedEnv(async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response("Unauthorized plain text gateway error", { status: 401 });
    };

    try {
      await assert.rejects(
        () =>
          runGoogleGrounding(
            { query: "plain 401" },
            {
              options: {
                apiKey: "k",
                model: "m1",
                fallbackModels: ["m2", "m3"],
                cacheTtlMs: 0,
              },
            }
          ),
        (err) => err instanceof FatalError && err.status === 401
      );
      assert.equal(fetchCalls, 1);

      // Now verify 500 error truncation <= 500 chars and key= redaction
      fetchCalls = 0;
      const longBody = `Upstream failed at https://api.example.com?key=AIzaSecretValue12345&foo=bar ${"x".repeat(900)}`;
      globalThis.fetch = async () => {
        fetchCalls++;
        return new Response(longBody, { status: 502 });
      };

      await assert.rejects(
        () =>
          runGoogleGrounding(
            { query: "long error" },
            { options: { apiKey: "k", model: "m1", fallbackModels: [], cacheTtlMs: 0 } }
          ),
        (err) => {
          assert.ok(!(err instanceof FatalError));
          assert.ok(!err.message.includes("AIzaSecretValue12345"));
          assert.ok(err.message.includes("key=***"));
          assert.ok(err.message.length < 620);
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  "empty/MAX_TOKENS output triggers fallback without polluting cache, and expired cache triggers storage.remove",
  withIsolatedEnv(async () => {
    const originalFetch = globalThis.fetch;
    const store = new Map();
    const removedKeys = [];
    const storage = {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        store.set(k, v);
      },
      remove: async (k) => {
        removedKeys.push(k);
        store.delete(k);
      },
    };

    // Pre-seed expired cache entry
    const expiredKey = makeCacheKey("empty fallback query", undefined, "gemini-4-hydrogen", 8);
    store.set(expiredKey, { content: "stale", sources: [], model: "old", timestamp: Date.now() - 9999999 });

    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (String(url).includes("gemini-4-hydrogen")) {
        // Return MAX_TOKENS with only thought part (no body text)
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "MAX_TOKENS",
                content: { parts: [{ text: "internal thought only", thought: true }] },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Recovered answer from flash." }] },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const res = await runGoogleGrounding(
        { query: "empty fallback query", max_sources: "invalid" },
        {
          storage,
          options: {
            apiKey: "k",
            model: "gemini-4-hydrogen",
            fallbackModels: ["gemini-3.8-flash"],
            cacheTtlMs: 60000,
          },
        }
      );

      assert.equal(calls, 2);
      assert.equal(res.model, "gemini-3.8-flash");
      assert.ok(res.content.includes("Recovered answer from flash."));
      assert.ok(removedKeys.includes(expiredKey));
      assert.equal(store.get(expiredKey).model, "gemini-3.8-flash");

      // Also verify that if ALL models return empty/blocked output, nothing is written to storage
      store.clear();
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 });

      await assert.rejects(() =>
        runGoogleGrounding(
          { query: "blocked query" },
          {
            storage,
            options: {
              apiKey: "k",
              model: "m1",
              fallbackModels: ["m2"],
              cacheTtlMs: 60000,
            },
          }
        )
      );
      assert.equal(store.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  "plugin.setup registers google-grounding integration form/env, preserves websearch default, and filters card URLs",
  withIsolatedEnv(async () => {
    const originalFetch = globalThis.fetch;
    const integrationUpdates = [];
    const methodUpdates = [];
    const websearchProviders = [];
    let currentDefault = "exa";

    await plugin.setup({
      options: {},
      integration: {
        transform: async (fn) => {
          fn({
            update: (id, cb) => {
              const obj = { id, name: id };
              cb(obj);
              integrationUpdates.push(obj);
            },
            method: {
              update: (entry) => methodUpdates.push(entry),
            },
          });
        },
        connection: {
          active: async (id) => (id === "google-grounding" ? { type: "credential", id: "cred_1" } : undefined),
          resolve: async () => ({
            type: "key",
            key: "live-integration-key",
            metadata: { baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-4-hydrogen" },
          }),
        },
      },
      websearch: {
        transform: async (fn) => {
          fn({
            add: (p) => websearchProviders.push(p),
            default: {
              get: () => currentDefault,
              set: (val) => {
                currentDefault = val;
              },
            },
          });
        },
      },
    });

    assert.equal(integrationUpdates[0].id, "google-grounding");
    assert.equal(integrationUpdates[0].name, "Google Gemini Grounding");
    assert.equal(integrationUpdates[0].metadata.websearch, true);

    const keyMethod = methodUpdates.find((m) => m.method.type === "key");
    const envMethod = methodUpdates.find((m) => m.method.type === "env");
    assert.ok(keyMethod);
    assert.ok(Array.isArray(keyMethod.method.form));
    assert.deepEqual(
      keyMethod.method.form.map((f) => f.key),
      ["baseURL", "model"]
    );
    assert.ok(keyMethod.method.form.every((f) => f.type === "string" && f.required === false));
    assert.deepEqual(envMethod.method.names, [
      "OPENCODE_GOOGLE_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
    ]);

    // Existing default ("exa") must NOT be overwritten when setDefaultWebsearch is omitted
    assert.equal(currentDefault, "exa");

    // Verify websearch card URL filtering & fallback
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Test answer[1]." }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { title: "Bad Local", uri: "ftp://invalid.local/file" } },
                  { web: { title: "Good HTTPS", uri: "https://example.com/article" } },
                ],
                groundingSupports: [
                  { segment: { startIndex: 0, endIndex: 14 }, groundingChunkIndices: [0, 1] },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );

    try {
      const cards = await websearchProviders[0].execute({ query: "test cards" }, {});
      assert.equal(cards.length, 1);
      assert.equal(cards[0].url, "https://example.com/article");

      // When no valid http(s) URLs exist, fallback card must still have valid https:// URL
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: "No sources answer." }] },
              },
            ],
          }),
          { status: 200 }
        );
      const fallbackCards = await websearchProviders[0].execute({ query: "plain query" }, {});
      assert.equal(fallbackCards.length, 1);
      assert.match(fallbackCards[0].url, /^https:\/\/www\.google\.com\/search\?q=plain%20query$/);

      // Verify OpenChamber OW(form) compatibility and OpenCode na/ta compatibility
      const openChamberFields = [];
      for (const field of keyMethod.method.form) {
        assert.equal(field.type, "string");
        assert.ok(!field.options?.length);
        assert.ok(!field.when?.length);
        openChamberFields.push({
          key: field.key,
          label: field.title ?? field.key,
          required: field.required === true,
          url: field.format === "uri",
        });
      }
      assert.deepEqual(openChamberFields, [
        { key: "baseURL", label: "Base URL (Optional)", required: false, url: true },
        { key: "model", label: "Preferred Model (Optional)", required: false, url: false },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Verify setDefaultWebsearch: undefined -> sets when editor.default.get() === undefined, preserves false, overrides on true
    let defState = undefined;
    await plugin.setup({
      options: {},
      websearch: {
        transform: async (fn) =>
          fn({
            add: () => {},
            default: {
              get: () => defState,
              set: (v) => {
                defState = v;
              },
            },
          }),
      },
    });
    assert.equal(defState, "google-grounding");

    defState = false;
    await plugin.setup({
      options: {},
      websearch: {
        transform: async (fn) =>
          fn({
            add: () => {},
            default: {
              get: () => defState,
              set: (v) => {
                defState = v;
              },
            },
          }),
      },
    });
    assert.equal(defState, false);

    await plugin.setup({
      options: { setDefaultWebsearch: true },
      websearch: {
        transform: async (fn) =>
          fn({
            add: () => {},
            default: {
              get: () => defState,
              set: (v) => {
                defState = v;
              },
            },
          }),
      },
    });
    assert.equal(defState, "google-grounding");
  })
);

test(
  "runGoogleGrounding resolves runtime ctx.provider/ctx.config, relative {file:...} in project config, and handles malformed chunks",
  withIsolatedEnv(async (_t, { tmpRoot }) => {
    const originalFetch = globalThis.fetch;
    const projDir = path.join(tmpRoot, "my-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "api.secret"), "file-secret-key\n", "utf-8");
    fs.writeFileSync(
      path.join(projDir, "opencode.jsonc"),
      `{
        "providers": {
          "google": {
            "settings": {
              "apiKey": "{file:./api.secret}"
            }
          }
        }
      }`,
      "utf-8"
    );

    const cfgFromProj = resolveConfig({}, { directory: projDir });
    assert.equal(cfgFromProj.apiKey, "file-secret-key");

    // Verify formatOutput handles null/malformed groundingChunks safely
    const outMalformed = formatOutput("Text.", {
      groundingChunks: [null, { web: {} }, { web: { title: "Valid", uri: "https://valid.test/page" } }],
    });
    assert.equal(outMalformed.sources.length, 3);
    assert.equal(outMalformed.sources[0].title, "Source 1");
    assert.equal(outMalformed.sources[2].title, "Valid");

    let seenHeaders = null;
    let seenUrl = null;
    globalThis.fetch = async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Provider runtime ok." }] },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const res = await runGoogleGrounding(
        { query: "provider runtime test" },
        {
          directory: projDir,
          provider: {
            get: async ({ providerID }) =>
              providerID === "google"
                ? {
                    data: {
                      headers: { "X-From-Provider": "v2" },
                      settings: { baseURL: "https://runtime-gateway.example.com" },
                    },
                  }
                : undefined,
          },
          configApi: {
            get: async () => ({
              data: {
                providers: {
                  google: { model: "gemini-3.8-flash" },
                },
              },
            }),
          },
          options: { cacheTtlMs: 0 },
        }
      );

      assert.equal(res.model, "gemini-3.8-flash");
      assert.ok(seenUrl.startsWith("https://runtime-gateway.example.com/v1beta/models/gemini-3.8-flash:generateContent"));
      assert.equal(seenHeaders["X-From-Provider"], "v2");
      assert.equal(seenHeaders["x-goog-api-key"], "file-secret-key");
      assert.equal(seenHeaders["Authorization"], "Bearer file-secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);
