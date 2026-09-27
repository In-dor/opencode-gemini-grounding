import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Per-model request timeout (45s) and overall fallback chain timeout (180s / 3 minutes)
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180000;

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
 * Resolves connection settings from env vars, opencode.jsonc, and auth.json.
 */
function resolveConfig() {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
  const configPathJson = path.join(homeDir, ".config", "opencode", "opencode.json");
  const authPath = path.join(homeDir, ".local", "share", "opencode", "auth.json");

  const config = readJsonFile(configPath) || readJsonFile(configPathJson) || {};
  const auth = readJsonFile(authPath) || {};

  const googleProvider = config?.providers?.google || config?.provider?.google || {};
  const indorProvider = config?.providers?.indor || config?.provider?.indor || {};

  const baseURL =
    process.env.OPENCODE_GOOGLE_BASE_URL ||
    googleProvider?.settings?.baseURL ||
    googleProvider?.options?.baseURL ||
    DEFAULT_GEMINI_BASE_URL;

  const apiKey =
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

  // Dynamic model lookup priority:
  // 1. env OPENCODE_GOOGLE_MODEL
  // 2. providers.google.model / settings.model
  // 3. providers.google.options.websearch_cited.model / options.model
  // 4. DEFAULT_MODEL (gemini-3.5-flash-lite)
  const model =
    process.env.OPENCODE_GOOGLE_MODEL ||
    googleProvider?.model ||
    googleProvider?.settings?.model ||
    googleProvider?.options?.websearch_cited?.model ||
    googleProvider?.options?.model ||
    DEFAULT_MODEL;

  const timeoutMs = Number(process.env.OPENCODE_GOOGLE_TIMEOUT_MS) || DEFAULT_TOTAL_TIMEOUT_MS;
  const requestTimeoutMs = Number(process.env.OPENCODE_GOOGLE_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: apiKey.trim(),
    model: normalizeModelId(model),
    timeoutMs,
    requestTimeoutMs,
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
 * Ensures consistent 1-to-1 indexing between inline markers and Sources list,
 * using Markdown hyperlinks to prevent long redirect URLs from cluttering.
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

  if (selectedChunkIndices.length > 0) {
    const sourceLines = selectedChunkIndices.map((chunkIdx) => {
      const chunk = chunks[chunkIdx];
      const displayIdx = remapTable.get(chunkIdx);
      const rawTitle = chunk.web?.title?.trim() || "";
      const uri = chunk.web?.uri?.trim() || "";
      const fallbackTitle = extractDomain(uri) || "Source";
      const title = rawTitle || fallbackTitle;
      const safeTitle = escapeMarkdown(title);
      return uri ? `[${displayIdx}] [${safeTitle}](${uri})` : `[${displayIdx}] ${safeTitle}`;
    });
    parts.push(`Sources:\n${sourceLines.join("\n")}`);
  }

  const queries = metadata?.webSearchQueries || [];
  if (queries.length > 0) {
    parts.push(`Search queries: ${queries.join("; ")}`);
  }

  return parts.join("\n\n");
}

/**
 * Dispatches the generateContent call with googleSearch grounding enabled,
 * supporting dynamic model selection, per-request timeouts, and an automatic fallback chain.
 */
async function runGoogleGrounding(args, signal) {
  const query = args.query?.trim();
  if (!query) {
    throw new Error("The 'query' parameter is required.");
  }

  const config = resolveConfig();
  if (!config.apiKey) {
    throw new FatalError(
      "Missing API key for Google grounding. Please configure it in opencode auth or set GOOGLE_API_KEY environment variable.",
      401
    );
  }

  const maxSources = Math.max(1, Math.min(Number(args.max_sources ?? 8), 20));
  const prompt = [
    query,
    args.context ? `\nAdditional context:\n${args.context}` : "",
    "\nUse Google Search grounding to provide accurate, up-to-date information with source attribution.",
  ].join("");

  // Build candidate model list with requested model first (if any), normalized and deduplicated
  const requestedModel = normalizeModelId(args.model);
  const rawCandidates = requestedModel
    ? [requestedModel, config.model, ...DEFAULT_FALLBACK_MODELS]
    : [config.model, ...DEFAULT_FALLBACK_MODELS];

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
    for (const currentModel of uniqueCandidates) {
      if (totalController.signal.aborted) {
        throw totalController.signal.reason || new Error("Google grounding request was cancelled or timed out.");
      }

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

        const formatted = formatOutput(responseText, candidate?.groundingMetadata, maxSources);
        return {
          content: formatted,
          model: currentModel,
        };
      } catch (err) {
        lastError = err;

        // Propagate fatal errors and external/overall cancellations immediately
        if (err instanceof FatalError) {
          throw err;
        }
        if (totalController.signal.aborted) {
          throw totalController.signal.reason || err;
        }

        // For retryable errors (429, 404, 5xx) or per-model timeouts, continue to next candidate
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
    await ctx.tool.transform((tools) => {
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
        async execute(input, context) {
          const result = await runGoogleGrounding(input, context?.signal);
          return {
            content: result.content,
            metadata: {
              model: result.model,
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
  },
};
