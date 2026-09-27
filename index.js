import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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

  const model =
    process.env.OPENCODE_GOOGLE_MODEL ||
    googleProvider?.options?.websearch_cited?.model ||
    DEFAULT_MODEL;

  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: apiKey.trim(),
    model: model.trim(),
    timeoutMs: 60000,
  };
}

/**
 * Maps grounding supports to citation insertion markers sorted by endIndex descending.
 */
function buildCitationInsertions(metadata) {
  const supports = metadata?.groundingSupports;
  if (!supports || supports.length === 0) return [];

  const mergedMap = new Map();
  for (const support of supports) {
    const segment = support.segment;
    const indices = support.groundingChunkIndices;
    if (!segment || segment.endIndex == null || !indices || indices.length === 0) continue;

    if (!mergedMap.has(segment.endIndex)) {
      mergedMap.set(segment.endIndex, new Set());
    }
    const set = mergedMap.get(segment.endIndex);
    for (const idx of indices) {
      set.add(idx);
    }
  }

  const insertions = [];
  for (const [endIndex, set] of mergedMap.entries()) {
    const sorted = Array.from(set).sort((a, b) => a - b);
    const marker = sorted.map((idx) => `[${idx + 1}]`).join("");
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
    const position = Math.min(insertion.index, lastIndex);
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
 */
function formatOutput(rawText, metadata, maxSources = 8) {
  let text = rawText || "";
  const chunks = metadata?.groundingChunks || [];
  const sources = chunks.slice(0, maxSources).map((c, i) => ({
    index: i + 1,
    title: c.web?.title || "Untitled",
    uri: c.web?.uri || "",
  }));
  const hasSources = sources.length > 0;

  if (hasSources && metadata) {
    const insertions = buildCitationInsertions(metadata);
    if (insertions.length > 0) {
      text = insertMarkersByUtf8Index(text, insertions);
    }
  }

  const parts = [text.trim() || "No search results or information found."];

  if (hasSources) {
    const sourceLines = sources.map((s) => `[${s.index}] ${s.title} (${s.uri})`);
    parts.push(`Sources:\n${sourceLines.join("\n")}`);
  }

  const queries = metadata?.webSearchQueries || [];
  if (queries.length > 0) {
    parts.push(`Search queries: ${queries.join("; ")}`);
  }

  return parts.join("\n\n");
}

/**
 * Dispatches the generateContent call with googleSearch grounding enabled.
 */
async function runGoogleGrounding(args, signal) {
  const query = args.query?.trim();
  if (!query) {
    throw new Error("The 'query' parameter is required.");
  }

  const config = resolveConfig();
  if (!config.apiKey) {
    throw new Error(
      "Missing API key for Google grounding. Please configure it in opencode auth or set GOOGLE_API_KEY environment variable."
    );
  }

  const maxSources = Math.max(1, Math.min(Number(args.max_sources ?? 8), 20));
  const prompt = [
    query,
    args.context ? `\nAdditional context:\n${args.context}` : "",
    "\nUse Google Search grounding to provide accurate, up-to-date information with source attribution.",
  ].join("");

  const url = `${config.baseURL}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Google grounding request timed out")), config.timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
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
      signal: controller.signal,
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Failed to parse response from Google grounding (${response.status}): ${text}`);
    }

    if (!response.ok || body?.error) {
      const msg = body?.error?.message || text;
      throw new Error(`Google grounding request failed (${response.status}): ${msg}`);
    }

    const candidate = body.candidates?.[0];
    const candidateParts = candidate?.content?.parts || [];
    let responseText = "";
    for (const part of candidateParts) {
      if (part.thought) continue;
      if (typeof part.text === "string") {
        responseText += part.text;
      }
    }

    const formatted = formatOutput(responseText, candidate?.groundingMetadata, maxSources);
    return formatted;
  } finally {
    clearTimeout(timer);
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
            max_sources: {
              type: "number",
              description: "Maximum number of grounded sources to return (1-20). Defaults to 8.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const content = await runGoogleGrounding(input, context?.signal);
          return { content };
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
