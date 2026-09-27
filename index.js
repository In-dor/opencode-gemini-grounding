import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Per-model request timeout (45s), overall fallback chain timeout (180s / 3 minutes), and cache TTL (10m)
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180000;
const DEFAULT_CACHE_TTL_MS = 600000;

// Default fallback chain when the primary model fails or encounters rate limits
const DEFAULT_FALLBACK_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];

/**
 * Custom error class for non-retryable fatal client / auth errors.
 */
class FatalError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "FatalError";
    this.status = status;
  }
}

/**
 * Normalizes a model identifier by stripping provider prefixes like 'google/' or 'indor/'.
 */
function normalizeModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  let clean = modelId.trim();
  if (clean.includes("/")) {
    clean = clean.split("/").pop() || clean;
  }
  return clean;
}

/**
 * Resolves potential '{env:VAR_NAME}' placeholders.
 */
function resolveEnvPlaceholder(val) {
  if (typeof val !== "string") return val;
  const match = val.match(/^\{env:([A-Za-z0-9_]+)\}$/);
  if (match) {
    return process.env[match[1]] || "";
  }
  return val;
}

/**
 * Fast string hashing for cache keys.
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Computes a unique cache key based on query and context.
 */
function makeCacheKey(query, context) {
  const normQuery = (query || "").trim().toLowerCase();
  const normContext = (context || "").trim().toLowerCase();
  const hash = hashString(`${normQuery}::${normContext}`);
  return `cache:v1:grounding:${hash}`;
}

/**
 * Reports progress safely to context.progress without throwing.
 */
async function reportProgress(progressFn, status) {
  if (typeof progressFn === "function") {
    try {
      await progressFn({ status });
    } catch {
      // Progress reporting errors should never disrupt core operations
    }
  }
}

/**
 * Extracts relevant snippet lines from grounded text that cite a specific source index [i].
 */
function extractSnippetForSource(displayIndex, text) {
  if (!text || !displayIndex) return "";
  const marker = `[${displayIndex}]`;
  const lines = text.split("\n");
  const matched = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Sources:") || trimmed.startsWith("Search queries:")) break;
    if (trimmed.includes(marker)) {
      matched.push(trimmed.replace(/^[*#-]+\s*/, ""));
      if (matched.length >= 2) break;
    }
  }
  return matched.join(" ");
}

/**
 * Strips JSONC comments while respecting string literals.
 */
function stripJsonComments(str) {
  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < str.length) {
        out += str[++i];
      } else if (ch === '"') {
        inString = false;
      }
    } else if (inSingleComment) {
      if (ch === "\n") {
        inSingleComment = false;
        out += ch;
      }
    } else if (inMultiComment) {
      if (ch === "*" && next === "/") {
        inMultiComment = false;
        i++;
      }
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === "/" && next === "/") {
        inSingleComment = true;
        i++;
      } else if (ch === "/" && next === "*") {
        inMultiComment = true;
        i++;
      } else {
        out += ch;
      }
    }
  }
  return out;
}

/**
 * Reads and parses a JSON or JSONC file safely.
 */
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    const clean = stripJsonComments(content);
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

/**
 * Resolves connection settings with full support for OpenCode V2 ctx.options,
 * environment variables, opencode.jsonc, and auth.json.
 */
function resolveConfig(pluginOptions = {}) {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
  const configPathJson = path.join(homeDir, ".config", "opencode", "opencode.json");
  const authPath = path.join(homeDir, ".local", "share", "opencode", "auth.json");

  const config = readJsonFile(configPath) || readJsonFile(configPathJson) || {};
  const auth = readJsonFile(authPath) || {};

  const googleProvider = config?.providers?.google || config?.provider?.google || {};
  const indorProvider = config?.providers?.indor || config?.provider?.indor || {};

  const baseURL =
    pluginOptions.baseURL ||
    process.env.OPENCODE_GOOGLE_BASE_URL ||
    googleProvider?.settings?.baseURL ||
    googleProvider?.options?.baseURL ||
    DEFAULT_GEMINI_BASE_URL;

  const rawApiKey =
    pluginOptions.apiKey ||
    process.env.OPENCODE_GOOGLE_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    auth?.google?.key ||
    auth?.indor?.key ||
    googleProvider?.settings?.apiKey ||
    googleProvider?.options?.apiKey ||
    indorProvider?.settings?.apiKey ||
    indorProvider?.options?.apiKey ||
    "";

  const apiKey = resolveEnvPlaceholder(rawApiKey);

  const model =
    pluginOptions.model ||
    process.env.OPENCODE_GOOGLE_MODEL ||
    googleProvider?.model ||
    googleProvider?.settings?.model ||
    googleProvider?.options?.websearch_cited?.model ||
    googleProvider?.options?.model ||
    DEFAULT_MODEL;

  const fallbackModels =
    Array.isArray(pluginOptions.fallbackModels) && pluginOptions.fallbackModels.length > 0
      ? pluginOptions.fallbackModels
      : DEFAULT_FALLBACK_MODELS;

  const timeoutMs =
    Number(pluginOptions.timeoutMs) ||
    Number(process.env.OPENCODE_GOOGLE_TIMEOUT_MS) ||
    DEFAULT_TOTAL_TIMEOUT_MS;

  const requestTimeoutMs =
    Number(pluginOptions.requestTimeoutMs) ||
    Number(process.env.OPENCODE_GOOGLE_REQUEST_TIMEOUT_MS) ||
    DEFAULT_REQUEST_TIMEOUT_MS;

  const cacheTtlMs =
    pluginOptions.cacheTtlMs !== undefined
      ? Number(pluginOptions.cacheTtlMs)
      : process.env.OPENCODE_GOOGLE_CACHE_TTL_MS !== undefined
      ? Number(process.env.OPENCODE_GOOGLE_CACHE_TTL_MS)
      : DEFAULT_CACHE_TTL_MS;

  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: (apiKey || "").trim(),
    model: normalizeModelId(model),
    fallbackModels,
    timeoutMs,
    requestTimeoutMs,
    cacheTtlMs,
  };
}

/**
 * Safely escapes markdown square brackets in titles to prevent broken link syntax.
 */
function escapeMarkdown(str) {
  if (!str) return "";
  return str.replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\r?\n/g, " ").trim();
}

/**
 * Extracts a clean hostname domain from a URL.
 */
function extractDomain(uri) {
  if (!uri) return "";
  try {
    return new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Maps grounding supports to citation insertion markers based on remapped display indices.
 */
function buildCitationInsertions(supports, remapTable) {
  if (!supports || supports.length === 0 || !remapTable || remapTable.size === 0) return [];

  const mergedMap = new Map();
  for (const support of supports) {
    const segment = support.segment;
    const indices = support.groundingChunkIndices;
    if (!segment || segment.endIndex == null || !indices || indices.length === 0) continue;

    const validDisplayIndices = new Set();
    for (const idx of indices) {
      if (remapTable.has(idx)) {
        validDisplayIndices.add(remapTable.get(idx));
      }
    }

    if (validDisplayIndices.size > 0) {
      if (!mergedMap.has(segment.endIndex)) {
        mergedMap.set(segment.endIndex, new Set());
      }
      const set = mergedMap.get(segment.endIndex);
      for (const dispIdx of validDisplayIndices) {
        set.add(dispIdx);
      }
    }
  }

  const insertions = [];
  for (const [endIndex, set] of mergedMap.entries()) {
    const sorted = Array.from(set).sort((a, b) => a - b);
    const marker = sorted.map((idx) => `[${idx}]`).join("");
    insertions.push({ index: endIndex, marker });
  }

  insertions.sort((a, b) => b.index - a.index);
  return insertions;
}

/**
 * Inserts citation markers into text at UTF-8 byte offsets.
 */
function insertMarkersByUtf8Index(text, insertions) {
  if (!insertions || insertions.length === 0) return text;
  const encoder = new TextEncoder();
  const responseBytes = encoder.encode(text);
  const parts = [];
  let lastIndex = responseBytes.length;

  for (const insertion of insertions) {
    const position = Math.max(0, Math.min(insertion.index, lastIndex));
    parts.unshift(responseBytes.subarray(position, lastIndex));
    parts.unshift(encoder.encode(insertion.marker));
    lastIndex = position;
  }
  parts.unshift(responseBytes.subarray(0, lastIndex));

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const finalBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    finalBytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(finalBytes);
}

/**
 * Formats grounding output with citations, sources list, and search queries.
 * Returns both structured sources and a formatted markdown text with hyperlinks.
 */
function formatOutput(rawText, metadata, maxSources = 8) {
  let text = rawText || "";
  const chunks = metadata?.groundingChunks || [];
  const supports = metadata?.groundingSupports || [];

  // Identify all chunk indices cited in supports
  const citedIndicesSet = new Set();
  for (const support of supports) {
    const indices = support.groundingChunkIndices;
    if (indices && Array.isArray(indices)) {
      for (const idx of indices) {
        if (typeof idx === "number" && idx >= 0 && idx < chunks.length) {
          citedIndicesSet.add(idx);
        }
      }
    }
  }

  let selectedChunkIndices = [];
  const remapTable = new Map(); // originalChunkIndex -> displayIndex (1-based)

  if (citedIndicesSet.size > 0) {
    // Sort cited indices in ascending order and cap to maxSources
    selectedChunkIndices = Array.from(citedIndicesSet)
      .sort((a, b) => a - b)
      .slice(0, maxSources);
    selectedChunkIndices.forEach((chunkIdx, i) => {
      remapTable.set(chunkIdx, i + 1);
    });
  } else if (chunks.length > 0) {
    // If no explicit supports were provided but chunks exist, take top maxSources
    const count = Math.min(chunks.length, maxSources);
    for (let i = 0; i < count; i++) {
      selectedChunkIndices.push(i);
      remapTable.set(i, i + 1);
    }
  }

  // Insert markers into text based on remapped display indices
  if (remapTable.size > 0 && supports.length > 0) {
    const insertions = buildCitationInsertions(supports, remapTable);
    if (insertions.length > 0) {
      text = insertMarkersByUtf8Index(text, insertions);
    }
  }

  const parts = [text.trim() || "No search results or information found."];
  const structuredSources = [];

  if (selectedChunkIndices.length > 0) {
    const sourceLines = selectedChunkIndices.map((chunkIdx) => {
      const chunk = chunks[chunkIdx];
      const displayIdx = remapTable.get(chunkIdx);
      const rawTitle = chunk.web?.title?.trim() || "";
      const uri = chunk.web?.uri?.trim() || "";
      const fallbackTitle = extractDomain(uri) || "Source";
      const title = rawTitle || fallbackTitle;
      const safeTitle = escapeMarkdown(title);
      structuredSources.push({
        index: displayIdx,
        title,
        uri,
      });
      return uri ? `[${displayIdx}] [${safeTitle}](${uri})` : `[${displayIdx}] ${safeTitle}`;
    });
    parts.push(`Sources:\n${sourceLines.join("\n")}`);
  }

  const queries = metadata?.webSearchQueries || [];
  if (queries.length > 0) {
    parts.push(`Search queries: ${queries.join("; ")}`);
  }

  const content = parts.join("\n\n");
  return {
    content,
    sources: structuredSources,
    queries,
    toString() {
      return this.content;
    },
  };
}

/**
 * Dispatches the generateContent call with googleSearch grounding enabled,
 * supporting dynamic model selection, per-request timeouts, automatic fallback,
 * context.progress reporting, and durable ctx.storage caching.
 */
async function runGoogleGrounding(args, runContext = {}) {
  const query = args.query?.trim();
  if (!query) {
    throw new Error("The 'query' parameter is required.");
  }

  // Discriminate runContext: supports either AbortSignal or context object
  let signal;
  let progress;
  let storage;
  let pluginOptions = {};

  if (runContext && typeof runContext.addEventListener === "function") {
    signal = runContext;
  } else if (runContext && typeof runContext === "object") {
    signal = runContext.signal;
    progress = runContext.progress;
    storage = runContext.storage;
    pluginOptions = runContext.options || {};
  }

  const config = resolveConfig(pluginOptions);
  if (!config.apiKey) {
    throw new FatalError(
      "Missing API key for Google grounding. Please configure it in opencode auth, opencode.jsonc plugin options, or set GOOGLE_API_KEY environment variable.",
      401
    );
  }

  const maxSources = Math.max(1, Math.min(Number(args.max_sources ?? 8), 20));

  // --- Scheme 3: Cache lookup via ctx.storage ---
  const cacheEnabled = config.cacheTtlMs > 0 && Boolean(storage && typeof storage.get === "function");
  const cacheKey = cacheEnabled ? makeCacheKey(query, args.context) : null;

  if (cacheEnabled && cacheKey) {
    try {
      const cached = await storage.get(cacheKey);
      if (cached && typeof cached === "object" && cached.timestamp) {
        if (Date.now() - cached.timestamp < config.cacheTtlMs) {
          await reportProgress(progress, "Found cached Google search results");
          return {
            content: cached.content,
            sources: cached.sources || [],
            model: cached.model || config.model,
            cached: true,
          };
        }
      }
    } catch {
      // Storage read errors should not abort search
    }
  }

  const prompt = [
    query,
    args.context ? `\nAdditional context:\n${args.context}` : "",
    "\nUse Google Search grounding to provide accurate, up-to-date information with source attribution.",
  ].join("");

  // Build candidate model list with requested model first (if any), normalized and deduplicated
  const requestedModel = normalizeModelId(args.model);
  const rawCandidates = requestedModel
    ? [requestedModel, config.model, ...config.fallbackModels]
    : [config.model, ...config.fallbackModels];

  const uniqueCandidates = Array.from(new Set(rawCandidates.map(normalizeModelId).filter(Boolean)));

  const totalController = new AbortController();
  const totalTimer = setTimeout(() => {
    totalController.abort(new Error(`Google grounding exceeded overall timeout of ${config.timeoutMs / 1000}s`));
  }, config.timeoutMs);

  const onExternalAbort = () => {
    totalController.abort(signal?.reason || new Error("Operation cancelled by user"));
  };
  if (signal) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let lastError = null;

  try {
    for (let i = 0; i < uniqueCandidates.length; i++) {
      const currentModel = uniqueCandidates[i];

      if (totalController.signal.aborted) {
        throw totalController.signal.reason || new Error("Google grounding request was cancelled or timed out.");
      }

      await reportProgress(progress, `Searching Google with ${currentModel}...`);

      const requestController = new AbortController();
      const requestTimer = setTimeout(() => {
        requestController.abort(
          new Error(`Google grounding request to model '${currentModel}' timed out after ${config.requestTimeoutMs / 1000}s`)
        );
      }, config.requestTimeoutMs);

      const onTotalAbortForRequest = () => {
        requestController.abort(totalController.signal.reason);
      };
      totalController.signal.addEventListener("abort", onTotalAbortForRequest, { once: true });

      const url = `${config.baseURL}/models/${currentModel}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": config.apiKey,
            "Authorization": `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            tools: [{ googleSearch: {} }],
          }),
          signal: requestController.signal,
        });

        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`Failed to parse response from ${currentModel} (${response.status}): ${text}`);
        }

        const statusCode = response.status || body?.error?.code;

        // Immediately abort on fatal, non-retryable authentication or client errors
        if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
          const msg = body?.error?.message || text;
          throw new FatalError(
            `Google grounding authentication/client error (${statusCode}) on model '${currentModel}': ${msg}`,
            statusCode
          );
        }

        if (!response.ok || body?.error) {
          const msg = body?.error?.message || text;
          throw new Error(`Google grounding request to ${currentModel} failed (${response.status}): ${msg}`);
        }

        const candidate = body.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const candidateParts = candidate?.content?.parts || [];
        let responseText = "";
        for (const part of candidateParts) {
          if (part.thought) continue;
          if (typeof part.text === "string") {
            responseText += part.text;
          }
        }

        // Surface safety filters or blocklists if response text is empty
        if (!responseText.trim() && finishReason && finishReason !== "STOP") {
          responseText = `[Search output blocked or truncated by provider: finishReason=${finishReason}]`;
        }

        await reportProgress(progress, "Rendering citations and sources...");

        const formatted = formatOutput(responseText, candidate?.groundingMetadata, maxSources);
        const result = {
          content: formatted.content,
          sources: formatted.sources,
          model: currentModel,
          cached: false,
        };

        // Cache result in ctx.storage if available
        if (cacheEnabled && cacheKey && storage && typeof storage.set === "function") {
          try {
            await storage.set(cacheKey, {
              content: result.content,
              sources: result.sources,
              model: result.model,
              timestamp: Date.now(),
            });
          } catch {
            // Storage write errors should not break search
          }
        }

        return result;
      } catch (err) {
        lastError = err;

        // Propagate fatal errors and external/overall cancellations immediately
        if (err instanceof FatalError) {
          throw err;
        }
        if (totalController.signal.aborted) {
          throw totalController.signal.reason || err;
        }

        // For retryable errors (429, 404, 5xx) or per-model timeouts, inform progress and continue
        const nextModel = uniqueCandidates[i + 1];
        if (nextModel) {
          await reportProgress(
            progress,
            `Model ${currentModel} encountered error, falling back to ${nextModel}...`
          );
        }
      } finally {
        clearTimeout(requestTimer);
        totalController.signal.removeEventListener("abort", onTotalAbortForRequest);
      }
    }

    throw lastError || new Error("All candidate models failed for Google grounding.");
  } finally {
    clearTimeout(totalTimer);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export default {
  id: "google-grounding",
  setup: async (ctx) => {
    const pluginOptions = ctx?.options || {};

    // 1. Tool domain registration (for direct tool invocations)
    if (ctx?.tool) {
      await ctx.tool.transform((tools) => {
        // Register Code Mode namespace if supported
        if (typeof tools.namespace === "function") {
          try {
            tools.namespace({
              name: "search",
              description: "Google Search grounding tools with academic-style inline citations",
            });
          } catch {
            // Optional namespace registration
          }
        }

        const toolDef = {
          description:
            "Search the web with Gemini Google Search grounding. Returns an up-to-date, source-backed answer with inline citations [1], [2] and a Sources list of URLs.",
          input: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The question or search query to answer with Google Search grounding.",
              },
              context: {
                type: "string",
                description: "Optional extra context, constraints, or known facts to guide the search.",
              },
              model: {
                type: "string",
                description:
                  "Optional Gemini model ID for grounding (e.g. 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'). Defaults to configured model with automatic fallback.",
              },
              max_sources: {
                type: "number",
                description: "Maximum number of grounded sources to return (1-20). Defaults to 8.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          options: {
            namespace: "search",
            codemode: true,
          },
          async execute(input, context) {
            const result = await runGoogleGrounding(input, {
              signal: context?.signal,
              progress: context?.progress?.bind(context),
              storage: ctx?.storage,
              options: pluginOptions,
            });
            return {
              content: result.content,
              metadata: {
                model: result.model,
                cached: Boolean(result.cached),
              },
            };
          },
        };

        tools.add({
          name: "google_grounding",
          ...toolDef,
        });

        // Also register websearch_cited as an alias so prompts expecting either name work
        tools.add({
          name: "websearch_cited",
          ...toolDef,
        });
      });
    }

    // 2. Websearch domain registration (for OpenCode V2 native web search integration)
    if (ctx?.websearch) {
      await ctx.websearch.transform((editor) => {
        editor.add({
          id: "google-grounding",
          name: "Google Gemini Grounding",
          execute: async ({ query }, context) => {
            const result = await runGoogleGrounding(
              { query },
              {
                signal: context?.signal,
                progress: context?.progress?.bind(context),
                storage: ctx?.storage,
                options: pluginOptions,
              }
            );

            if (result.sources && result.sources.length > 0) {
              return result.sources.map((s, idx) => {
                const url = s.uri || "";
                const title = s.title || `Source [${s.index}]`;
                // Card 0 carries the full synthesis so the model receives all facts in complete context.
                // Subsequent cards provide their own concise cited sentence snippets, avoiding the ~20,000-token
                // duplicate bloat while ensuring every discovered source appears as an individual clickable card in the UI.
                const snippet =
                  idx === 0
                    ? result.content
                    : (extractSnippetForSource(s.index, result.content) || `Cited reference: ${title}`);

                return {
                  url,
                  title,
                  content: snippet,
                  time: {},
                };
              });
            }

            return [
              {
                url: "",
                title: "Google Gemini Grounding Result",
                content: result.content,
                time: {},
              },
            ];
          },
        });

        // Automatically set as default OpenCode V2 websearch provider unless explicitly disabled
        if (pluginOptions.setDefaultWebsearch !== false && editor.default?.set) {
          editor.default.set("google-grounding");
        }
      });
    }
  },
};
