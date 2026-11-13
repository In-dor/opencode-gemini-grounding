import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DEFAULT_MODEL = "gemini-4-hydrogen";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Per-model request timeout (60s), overall fallback chain timeout (180s / 3 minutes), and cache TTL (10m)
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_TOTAL_TIMEOUT_MS = 180000;
const DEFAULT_CACHE_TTL_MS = 600000;
const MAX_SNIPPET_LENGTH = 280;

// Default fallback chain when the primary model fails or encounters rate limits
const DEFAULT_FALLBACK_MODELS = [
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];

const VALID_THINKING_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "XHIGH"]);
const VALID_AUTH_MODES = new Set(["auto", "x-goog-api-key", "bearer", "both"]);

// In-memory file cache keyed by filePath -> { mtimeMs, data }
const jsonFileCache = new Map();

// In-memory SQLite credential cache keyed by `${dbPath}::${integrationId}` -> { stamp, data }
const sqliteCredentialCache = new Map();

// In-flight request deduplication map keyed by cacheKey -> subscriber-managed entry
const inFlightRequests = new Map();

let cachedSqliteLoader;

/**
 * Custom error class for non-retryable fatal authentication or client errors.
 */
export class FatalError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "FatalError";
    this.status = status;
  }
}

/**
 * Normalizes a model identifier by stripping provider prefixes (e.g. 'google/')
 * and OpenCode V2 '#variant' suffixes (e.g. 'google/gemini-4-hydrogen#xhigh' -> 'gemini-4-hydrogen').
 */
export function normalizeModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  let clean = modelId.trim();
  if (clean.includes("/")) {
    clean = clean.split("/").pop() || clean;
  }
  const hashIdx = clean.indexOf("#");
  if (hashIdx !== -1) {
    clean = clean.slice(0, hashIdx);
  }
  return clean.trim();
}

/**
 * Resolves '{env:VAR_NAME}' and '{file:path/to/secret}' placeholders
 * (both standalone and embedded in strings).
 * Supports '~/...' expansion, absolute paths, and relative paths against baseDir.
 */
export function resolveEnvPlaceholder(val, baseDir = process.cwd()) {
  if (typeof val !== "string") return val;

  let resolved = val.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] || "");

  resolved = resolved.replace(/\{file:([^}]+)\}/g, (_, rawPath) => {
    const trimmed = String(rawPath || "").trim();
    if (!trimmed) return "";

    let targetPath;
    if (trimmed === "~") {
      targetPath = os.homedir();
    } else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      targetPath = path.join(os.homedir(), trimmed.slice(2));
    } else if (path.isAbsolute(trimmed)) {
      targetPath = trimmed;
    } else {
      targetPath = path.resolve(baseDir || process.cwd(), trimmed);
    }

    try {
      return fs.readFileSync(targetPath, "utf-8").trim();
    } catch {
      return "";
    }
  });

  return resolved;
}

export const resolvePlaceholders = resolveEnvPlaceholder;

/**
 * Normalizes a Gemini API baseURL:
 * - Resolves '{env:VAR}' and '{file:...}' placeholders
 * - Strips trailing slashes and accidental '/models' suffix
 * - Automatically appends '/v1beta' if the URL has only a root pathname ('/')
 */
export function normalizeBaseUrl(rawUrl, baseDir = process.cwd()) {
  const resolved = resolveEnvPlaceholder(rawUrl || "", baseDir).trim().replace(/\/+$/, "");
  if (!resolved) return DEFAULT_GEMINI_BASE_URL;

  const withoutModels = resolved.replace(/\/models$/i, "");
  if (/\/v1(?:beta|alpha)?$/i.test(withoutModels)) {
    return withoutModels;
  }

  try {
    const parsed = new URL(withoutModels);
    if (!parsed.pathname || parsed.pathname === "/") {
      return `${withoutModels}/v1beta`;
    }
  } catch {
    // Keep as-is if not a standard URL
  }
  return withoutModels;
}

/**
 * Returns true if baseURL points to an official Google Gemini / Vertex endpoint.
 */
export function isOfficialGoogleEndpoint(baseURL) {
  if (!baseURL || typeof baseURL !== "string") return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return (
      host === "generativelanguage.googleapis.com" ||
      host === "aiplatform.googleapis.com" ||
      host.endsWith(".googleapis.com")
    );
  } catch {
    return /^(?:https?:\/\/)?(?:[^/]+\.)?googleapis\.com(?:[:/]|$)/i.test(baseURL.trim());
  }
}

/**
 * Builds request headers while avoiding dual-auth header conflicts on official Google endpoints.
 */
export function buildRequestHeaders(config) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (config?.headers && typeof config.headers === "object") {
    for (const [k, v] of Object.entries(config.headers)) {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        headers[k] = String(v);
      }
    }
  }

  const mode = VALID_AUTH_MODES.has(config?.authMode) ? config.authMode : "auto";
  const authType = config?.authType || "key";
  const apiKey = config?.apiKey || "";

  if (!apiKey) return headers;

  let sendXGoog = false;
  let sendBearer = false;

  if (mode === "x-goog-api-key") {
    sendXGoog = true;
  } else if (mode === "bearer") {
    sendBearer = true;
  } else if (mode === "both") {
    sendXGoog = true;
    sendBearer = true;
  } else {
    // "auto": OAuth uses Bearer only; official Google API keys use x-goog-api-key only;
    // custom third-party proxies keep dual headers for maximum compatibility.
    if (authType === "oauth") {
      sendBearer = true;
    } else if (isOfficialGoogleEndpoint(config?.baseURL)) {
      sendXGoog = true;
    } else {
      sendXGoog = true;
      sendBearer = true;
    }
  }

  if (sendXGoog) {
    headers["x-goog-api-key"] = apiKey;
  }
  if (sendBearer) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * Computes a collision-resistant SHA-256 cache key across query, context, model, maxSources,
 * and (when non-default) baseURL.
 */
export function makeCacheKey(query, context = "", model = "", maxSources = 8, baseURL = "") {
  const normQuery = String(query || "").trim().toLowerCase();
  const normContext = String(context || "").trim().toLowerCase();
  const normModel = normalizeModelId(model).toLowerCase();
  const parsedMax = Number(maxSources);
  const normMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 8;
  const normBase = baseURL ? normalizeBaseUrl(baseURL).toLowerCase() : "";
  const isDefaultBase = !normBase || normBase === DEFAULT_GEMINI_BASE_URL.toLowerCase();

  const payload = isDefaultBase
    ? JSON.stringify([normQuery, normContext, normModel, normMax])
    : JSON.stringify([normQuery, normContext, normModel, normMax, normBase]);

  const hash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
  return `cache:v2:grounding:${hash}`;
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
 * Extracts concise sentence-level snippets from grounded text that cite a specific source index [i].
 */
export function extractSnippetForSource(displayIndex, text) {
  if (!text || !displayIndex) return "";
  const marker = `[${displayIndex}]`;
  const lines = text.split("\n");
  const matched = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("Sources:") || trimmed.startsWith("Search queries:")) break;
    if (!trimmed.includes(marker)) continue;

    // Strip markdown list bullets, numbered lists, headings, and blockquotes
    const cleanLine = trimmed.replace(/^(?:[*+-]|\d+[.)]|#+|>)\s*/, "").trim();

    if (cleanLine.length <= 60) {
      matched.push(cleanLine);
    } else {
      // Split into sentences while keeping citation markers [i] and punctuation grouped together
      const sentences = cleanLine
        .split(
          /(?<=[。！？!?])(?![\d\[\]])\s*|(?<=(?:\[\d+\])+)(?![\d\[\]。！？.!?])\s*|(?<=\.)(?=\s+[A-Z\u4e00-\u9fa5])\s*/g
        )
        .map((s) => s.trim())
        .filter(Boolean);

      for (const sentence of sentences) {
        if (sentence.includes(marker)) {
          matched.push(sentence);
          if (matched.length >= 2) break;
        }
      }
    }

    if (matched.length >= 2) break;
  }

  const combined = matched.join(" ").trim();
  if (combined.length > MAX_SNIPPET_LENGTH) {
    return `${combined.slice(0, MAX_SNIPPET_LENGTH - 3).trim()}...`;
  }
  return combined;
}

/**
 * Strips JSONC comments (// and /* *\/) AND trailing commas before } or ] while respecting string literals.
 */
export function stripJsonComments(str) {
  if (typeof str !== "string") return "";

  // Pass 1: Remove single-line and multi-line comments outside string literals
  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;
  let noComments = "";

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (inString) {
      noComments += ch;
      if (ch === "\\" && i + 1 < str.length) {
        noComments += str[++i];
      } else if (ch === '"') {
        inString = false;
      }
    } else if (inSingleComment) {
      if (ch === "\n") {
        inSingleComment = false;
        noComments += ch;
      }
    } else if (inMultiComment) {
      if (ch === "*" && next === "/") {
        inMultiComment = false;
        i++;
      }
    } else {
      if (ch === '"') {
        inString = true;
        noComments += ch;
      } else if (ch === "/" && next === "/") {
        inSingleComment = true;
        i++;
      } else if (ch === "/" && next === "*") {
        inMultiComment = true;
        i++;
      } else {
        noComments += ch;
      }
    }
  }

  // Pass 2: Remove trailing commas before } or ] outside string literals
  let out = "";
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < noComments.length) {
        out += noComments[++i];
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === ",") {
        let j = i + 1;
        while (j < noComments.length && /\s/.test(noComments[j])) {
          j++;
        }
        const nextNonWs = noComments[j];
        if (nextNonWs === "}" || nextNonWs === "]") {
          // Skip trailing comma
          continue;
        }
        out += ch;
      } else {
        out += ch;
      }
    }
  }

  return out;
}

/**
 * Reads and parses a JSON or JSONC file safely with mtimeMs-based in-memory caching.
 */
function readJsonFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = jsonFileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const clean = stripJsonComments(content);
    const data = JSON.parse(clean);
    jsonFileCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    jsonFileCache.delete(filePath);
    return null;
  }
}

function getDefaultOpenCodeDirs() {
  const homeDir = os.homedir();
  const configDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(homeDir, ".config", "opencode");
  const dataDir = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "opencode")
    : path.join(homeDir, ".local", "share", "opencode");
  return { configDir, dataDir };
}

function loadSqliteDriver() {
  if (cachedSqliteLoader !== undefined) return cachedSqliteLoader;

  try {
    const mod = require("node:sqlite");
    if (mod?.DatabaseSync) {
      cachedSqliteLoader = { Ctor: mod.DatabaseSync, kind: "node" };
      return cachedSqliteLoader;
    }
  } catch {
    // Fallback to bun:sqlite under Bun runtime
  }

  try {
    const mod = require("bun:sqlite");
    if (mod?.Database) {
      cachedSqliteLoader = { Ctor: mod.Database, kind: "bun" };
      return cachedSqliteLoader;
    }
  } catch {
    // SQLite driver not available
  }

  cachedSqliteLoader = null;
  return null;
}

function getFileStamp(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function parseCredentialValue(rawValue, integrationId) {
  if (!rawValue) return null;
  let parsed = rawValue;
  if (typeof rawValue === "string") {
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const baseURL = typeof parsed.metadata?.baseURL === "string" ? parsed.metadata.baseURL.trim() : "";
  const model = typeof parsed.metadata?.model === "string" ? parsed.metadata.model.trim() : "";

  if (parsed.type === "key" && typeof parsed.key === "string" && parsed.key.trim()) {
    const key = parsed.key.trim();
    return {
      integrationId,
      authType: "key",
      key,
      apiKey: key,
      baseURL,
      model,
      metadata: parsed.metadata || {},
    };
  }

  if (parsed.type === "oauth" && typeof parsed.access === "string" && parsed.access.trim()) {
    const access = parsed.access.trim();
    return {
      integrationId,
      authType: "oauth",
      key: access,
      apiKey: access,
      baseURL,
      model,
      metadata: parsed.metadata || {},
    };
  }

  return null;
}

/**
 * Reads an active credential from OpenCode V2.2.6+ SQLite database (`opencode.db` `credential` table)
 * in safe read-only mode with mtimeMs/WAL-aware caching.
 */
export function readCredentialFromSqlite(integrationId, dbPath) {
  const ids = Array.isArray(integrationId) ? integrationId : [integrationId];
  const cleanIds = ids.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim());
  if (cleanIds.length === 0) return null;

  const { dataDir } = getDefaultOpenCodeDirs();
  const resolvedDbPath = dbPath ? path.resolve(dbPath) : path.join(dataDir, "opencode.db");

  const dbFileStamp = getFileStamp(resolvedDbPath);
  if (dbFileStamp === "missing") {
    return null;
  }
  const stamp = `${dbFileStamp}|${getFileStamp(`${resolvedDbPath}-wal`)}`;

  const uncachedIds = [];
  for (const id of cleanIds) {
    const cacheKey = `${resolvedDbPath}::${id}`;
    const cached = sqliteCredentialCache.get(cacheKey);
    if (cached && cached.stamp === stamp) {
      if (cached.data) return { ...cached.data };
    } else {
      uncachedIds.push(id);
    }
  }

  if (uncachedIds.length === 0) {
    return null;
  }

  const driver = loadSqliteDriver();
  if (!driver) return null;

  let db;
  try {
    db =
      driver.kind === "node"
        ? new driver.Ctor(resolvedDbPath, { readOnly: true })
        : new driver.Ctor(resolvedDbPath, { readonly: true });

    const stmt = db.prepare(
      "SELECT integration_id, value, active, time_created, id FROM credential WHERE integration_id = ? ORDER BY COALESCE(active, 0) DESC, active DESC, time_created DESC, id DESC LIMIT 1"
    );

    let firstMatch = null;
    for (const id of cleanIds) {
      const cacheKey = `${resolvedDbPath}::${id}`;
      const cached = sqliteCredentialCache.get(cacheKey);
      let entryData;
      if (cached && cached.stamp === stamp) {
        entryData = cached.data;
      } else {
        const row = stmt.get(id);
        entryData = row ? parseCredentialValue(row.value, row.integration_id || id) : null;
        sqliteCredentialCache.set(cacheKey, { stamp, data: entryData });
      }
      if (!firstMatch && entryData) {
        firstMatch = { ...entryData };
      }
    }

    return firstMatch;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors
    }
  }
}

function collectOpenCodeConfigDocuments(directory, configDir) {
  const docs = [];
  const seen = new Set();

  const pushFile = (filePath) => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const data = readJsonFile(resolved);
    if (data && typeof data === "object") {
      docs.push({ data, baseDir: path.dirname(resolved) });
    }
  };

  // 1. Global OpenCode config (lowest precedence)
  pushFile(path.join(configDir, "opencode.json"));
  pushFile(path.join(configDir, "opencode.jsonc"));

  if (process.env.OPENCODE_CONFIG) {
    pushFile(process.env.OPENCODE_CONFIG);
  }

  // 2. Project OpenCode configs along ancestor chain (direct opencode.json(c) then .opencode/opencode.json(c))
  if (directory && typeof directory === "string") {
    const ancestors = [];
    let current = path.resolve(directory);
    while (true) {
      ancestors.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    for (const dir of ancestors) {
      pushFile(path.join(dir, "opencode.json"));
      pushFile(path.join(dir, "opencode.jsonc"));
    }
    for (const dir of ancestors) {
      pushFile(path.join(dir, ".opencode", "opencode.json"));
      pushFile(path.join(dir, ".opencode", "opencode.jsonc"));
    }
  }

  return docs;
}

function extractProviderFields(providerObj, baseDir) {
  if (!providerObj || typeof providerObj !== "object") return {};

  const rawBaseURL =
    providerObj?.settings?.baseURL ||
    providerObj?.options?.baseURL ||
    providerObj?.baseURL ||
    "";
  const rawApiKey =
    providerObj?.settings?.apiKey ||
    providerObj?.options?.apiKey ||
    providerObj?.apiKey ||
    "";
  const rawModel =
    providerObj?.model ||
    providerObj?.settings?.model ||
    providerObj?.options?.websearch_cited?.model ||
    providerObj?.options?.model ||
    "";

  const headers = {};
  for (const sourceHeaders of [
    providerObj?.options?.headers,
    providerObj?.settings?.headers,
    providerObj?.headers,
  ]) {
    if (sourceHeaders && typeof sourceHeaders === "object" && !Array.isArray(sourceHeaders)) {
      for (const [k, v] of Object.entries(sourceHeaders)) {
        if (v !== undefined && v !== null) {
          const val = typeof v === "string" ? resolveEnvPlaceholder(v, baseDir).trim() : String(v);
          if (val) headers[k] = val;
        }
      }
    }
  }

  return {
    baseURL: rawBaseURL ? resolveEnvPlaceholder(rawBaseURL, baseDir).trim() : "",
    apiKey: rawApiKey ? resolveEnvPlaceholder(rawApiKey, baseDir).trim() : "",
    model: rawModel ? resolveEnvPlaceholder(rawModel, baseDir).trim() : "",
    integrationID: typeof providerObj?.integrationID === "string" ? providerObj.integrationID.trim() : "",
    headers,
  };
}

function resolveAuthJsonEntry(auth, ids, baseDir) {
  if (!auth || typeof auth !== "object") return null;
  for (const id of ids) {
    const entry = auth[id];
    if (!entry || typeof entry !== "object") continue;
    if ((entry.type === "oauth" || entry.access) && typeof entry.access === "string" && entry.access.trim()) {
      return {
        integrationId: id,
        authType: "oauth",
        apiKey: resolveEnvPlaceholder(entry.access, baseDir).trim(),
        baseURL: typeof entry.metadata?.baseURL === "string" ? resolveEnvPlaceholder(entry.metadata.baseURL, baseDir).trim() : "",
        model: typeof entry.metadata?.model === "string" ? resolveEnvPlaceholder(entry.metadata.model, baseDir).trim() : "",
      };
    }
    if (typeof entry.key === "string" && entry.key.trim()) {
      return {
        integrationId: id,
        authType: "key",
        apiKey: resolveEnvPlaceholder(entry.key, baseDir).trim(),
        baseURL: typeof entry.metadata?.baseURL === "string" ? resolveEnvPlaceholder(entry.metadata.baseURL, baseDir).trim() : "",
        model: typeof entry.metadata?.model === "string" ? resolveEnvPlaceholder(entry.metadata.model, baseDir).trim() : "",
      };
    }
  }
  return null;
}

function resolvePositiveNumber(val, fallback) {
  if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
    return fallback;
  }
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function resolveNonNegativeNumber(val, fallback) {
  if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
    return fallback;
  }
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function normalizeThinkingLevel(val) {
  if (typeof val !== "string") return undefined;
  const upper = val.trim().toUpperCase();
  return VALID_THINKING_LEVELS.has(upper) ? upper : undefined;
}

function normalizeAuthMode(val) {
  if (typeof val !== "string") return "auto";
  const lower = val.trim().toLowerCase();
  return VALID_AUTH_MODES.has(lower) ? lower : "auto";
}

function parseFallbackModelsOption(pluginOptions) {
  if (Array.isArray(pluginOptions?.fallbackModels) && pluginOptions.fallbackModels.length > 0) {
    return pluginOptions.fallbackModels;
  }
  if (typeof pluginOptions?.fallbackModels === "string" && pluginOptions.fallbackModels.trim()) {
    const parsed = pluginOptions.fallbackModels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  if (typeof process.env.OPENCODE_GOOGLE_FALLBACK_MODELS === "string" && process.env.OPENCODE_GOOGLE_FALLBACK_MODELS.trim()) {
    const parsed = process.env.OPENCODE_GOOGLE_FALLBACK_MODELS
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_FALLBACK_MODELS;
}

function buildFinalConfig(pluginOptions = {}, sources = {}) {
  const baseDir = sources.baseDir || process.cwd();
  const googleProvider = sources.googleProvider || {};
  const indorProvider = sources.indorProvider || {};
  const customProvider = sources.customProvider || {};
  const primaryCredential = sources.primaryCredential || null;
  const secondaryCredential = sources.secondaryCredential || null;
  const authEntry = sources.authEntry || null;

  // --- Resolve API Key & Auth Type ---
  let apiKey = "";
  let authType = "key";

  if (typeof pluginOptions.apiKey === "string" && pluginOptions.apiKey.trim()) {
    const resolved = resolveEnvPlaceholder(pluginOptions.apiKey, baseDir).trim();
    if (resolved) {
      apiKey = resolved;
      authType = pluginOptions.authType === "oauth" ? "oauth" : "key";
    }
  }
  if (!apiKey && process.env.OPENCODE_GOOGLE_API_KEY?.trim()) {
    apiKey = process.env.OPENCODE_GOOGLE_API_KEY.trim();
  }
  if (!apiKey && primaryCredential?.apiKey) {
    apiKey = primaryCredential.apiKey;
    authType = primaryCredential.authType || "key";
  }
  if (!apiKey) {
    const envFallback =
      process.env.GOOGLE_API_KEY?.trim() ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      "";
    if (envFallback) {
      apiKey = envFallback;
    }
  }
  if (!apiKey && secondaryCredential?.apiKey) {
    apiKey = secondaryCredential.apiKey;
    authType = secondaryCredential.authType || "key";
  }
  if (!apiKey && authEntry?.apiKey) {
    apiKey = authEntry.apiKey;
    authType = authEntry.authType || "key";
  }
  if (!apiKey) {
    apiKey = customProvider.apiKey || googleProvider.apiKey || indorProvider.apiKey || "";
  }

  // --- Resolve Base URL ---
  const rawBaseURL =
    (typeof pluginOptions.baseURL === "string" && pluginOptions.baseURL.trim()
      ? resolveEnvPlaceholder(pluginOptions.baseURL, baseDir).trim()
      : "") ||
    process.env.OPENCODE_GOOGLE_BASE_URL?.trim() ||
    primaryCredential?.baseURL ||
    secondaryCredential?.baseURL ||
    authEntry?.baseURL ||
    customProvider.baseURL ||
    googleProvider.baseURL ||
    indorProvider.baseURL ||
    DEFAULT_GEMINI_BASE_URL;

  // --- Resolve Model ---
  const rawModel =
    (typeof pluginOptions.model === "string" && pluginOptions.model.trim()
      ? resolveEnvPlaceholder(pluginOptions.model, baseDir).trim()
      : "") ||
    process.env.OPENCODE_GOOGLE_MODEL?.trim() ||
    primaryCredential?.model ||
    secondaryCredential?.model ||
    authEntry?.model ||
    customProvider.model ||
    googleProvider.model ||
    indorProvider.model ||
    DEFAULT_MODEL;

  // --- Merge Headers ---
  const headers = {
    ...(indorProvider.headers || {}),
    ...(googleProvider.headers || {}),
    ...(customProvider.headers || {}),
  };
  if (pluginOptions.headers && typeof pluginOptions.headers === "object" && !Array.isArray(pluginOptions.headers)) {
    for (const [k, v] of Object.entries(pluginOptions.headers)) {
      if (v !== undefined && v !== null) {
        const val = typeof v === "string" ? resolveEnvPlaceholder(v, baseDir).trim() : String(v);
        if (val) headers[k] = val;
      }
    }
  }

  const fallbackModels = parseFallbackModelsOption(pluginOptions);

  const timeoutMs = resolvePositiveNumber(
    pluginOptions.timeoutMs ?? process.env.OPENCODE_GOOGLE_TIMEOUT_MS,
    DEFAULT_TOTAL_TIMEOUT_MS
  );
  const requestTimeoutMs = resolvePositiveNumber(
    pluginOptions.requestTimeoutMs ?? process.env.OPENCODE_GOOGLE_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  const cacheTtlMs = resolveNonNegativeNumber(
    pluginOptions.cacheTtlMs !== undefined ? pluginOptions.cacheTtlMs : process.env.OPENCODE_GOOGLE_CACHE_TTL_MS,
    DEFAULT_CACHE_TTL_MS
  );

  const thinkingLevel = normalizeThinkingLevel(
    pluginOptions.thinkingLevel || process.env.OPENCODE_GOOGLE_THINKING_LEVEL
  );
  const authMode = normalizeAuthMode(pluginOptions.authMode || process.env.OPENCODE_GOOGLE_AUTH_MODE);

  return {
    baseURL: normalizeBaseUrl(rawBaseURL, baseDir),
    apiKey: (apiKey || "").trim(),
    authType,
    authMode,
    headers,
    model: normalizeModelId(rawModel) || DEFAULT_MODEL,
    fallbackModels,
    thinkingLevel,
    timeoutMs,
    requestTimeoutMs,
    cacheTtlMs,
    keyInQuery: Boolean(pluginOptions.keyInQuery),
  };
}

function resolveDiskSourcesSync(pluginOptions = {}, runtimeOptions = {}) {
  const { configDir, dataDir } = getDefaultOpenCodeDirs();
  const directory = runtimeOptions.directory || pluginOptions.directory || process.cwd();
  const dbPath = runtimeOptions.dbPath || pluginOptions.dbPath || path.join(dataDir, "opencode.db");
  const authPath = runtimeOptions.authPath || path.join(dataDir, "auth.json");

  const configDocs = collectOpenCodeConfigDocuments(directory, configDir);
  const auth = readJsonFile(authPath) || {};

  const mergeProviderDocs = (providerName) => {
    const merged = { baseURL: "", apiKey: "", model: "", integrationID: "", headers: {} };
    if (!providerName) return merged;
    for (const doc of configDocs) {
      const pObj = doc.data?.providers?.[providerName] || doc.data?.provider?.[providerName];
      if (!pObj) continue;
      const extracted = extractProviderFields(pObj, doc.baseDir);
      if (extracted.baseURL) merged.baseURL = extracted.baseURL;
      if (extracted.apiKey) merged.apiKey = extracted.apiKey;
      if (extracted.model) merged.model = extracted.model;
      if (extracted.integrationID) merged.integrationID = extracted.integrationID;
      Object.assign(merged.headers, extracted.headers);
    }
    return merged;
  };

  const googleProvider = mergeProviderDocs("google");
  const indorProvider = mergeProviderDocs("indor");
  const customProvider =
    pluginOptions.providerId && pluginOptions.providerId !== "google" && pluginOptions.providerId !== "indor"
      ? mergeProviderDocs(pluginOptions.providerId)
      : {};

  const primaryIds = Array.from(
    new Set(["google-grounding", pluginOptions.integrationId].filter((id) => typeof id === "string" && id.trim()))
  );
  const secondaryIds = Array.from(
    new Set(
      [googleProvider.integrationID, "google", "indor"].filter((id) => typeof id === "string" && id.trim())
    )
  );

  const primaryCredential = readCredentialFromSqlite(primaryIds, dbPath);
  const secondaryCredential = readCredentialFromSqlite(secondaryIds, dbPath);
  const authEntry = resolveAuthJsonEntry(
    auth,
    [...primaryIds, ...secondaryIds],
    path.dirname(authPath)
  );

  return {
    baseDir: directory,
    dbPath,
    authPath,
    primaryIds,
    secondaryIds,
    googleProvider,
    indorProvider,
    customProvider,
    primaryCredential,
    secondaryCredential,
    authEntry,
  };
}

/**
 * Synchronously resolves connection settings with support for OpenCode V2 options,
 * environment variables, `{env:...}` & `{file:...}` placeholders, project & global `opencode.json(c)`,
 * OpenCode V2.2.6+ SQLite `opencode.db`, and legacy `auth.json`.
 */
export function resolveConfig(pluginOptions = {}, runtimeOptions = {}) {
  const sources = resolveDiskSourcesSync(pluginOptions, runtimeOptions);
  return buildFinalConfig(pluginOptions, sources);
}

async function resolveFromIntegrationApi(integrationApi, integrationIds, baseDir) {
  if (!integrationApi?.connection) return null;
  for (const id of integrationIds) {
    try {
      const conn = await integrationApi.connection.active(id);
      if (!conn || conn.type === "env") continue;
      const resolved = await integrationApi.connection.resolve(conn);
      if (!resolved || typeof resolved !== "object") continue;

      const baseURL =
        typeof resolved.metadata?.baseURL === "string"
          ? resolveEnvPlaceholder(resolved.metadata.baseURL, baseDir).trim()
          : "";
      const model =
        typeof resolved.metadata?.model === "string"
          ? resolveEnvPlaceholder(resolved.metadata.model, baseDir).trim()
          : "";

      if (resolved.type === "oauth" && typeof resolved.access === "string" && resolved.access.trim()) {
        return {
          integrationId: id,
          authType: "oauth",
          apiKey: resolveEnvPlaceholder(resolved.access, baseDir).trim(),
          baseURL,
          model,
          metadata: resolved.metadata || {},
        };
      }
      if (resolved.type === "key" && typeof resolved.key === "string" && resolved.key.trim()) {
        return {
          integrationId: id,
          authType: "key",
          apiKey: resolveEnvPlaceholder(resolved.key, baseDir).trim(),
          baseURL,
          model,
          metadata: resolved.metadata || {},
        };
      }
    } catch {
      // Ignore integration API errors and fall back to local DB/config
    }
  }
  return null;
}

/**
 * Asynchronously resolves connection settings, enriching synchronous disk/env resolution
 * with live OpenCode V2 plugin runtime APIs (`ctx.integration`, `ctx.provider`, `ctx.config`).
 */
async function resolveConfigAsync(pluginOptions = {}, runtimeContext = {}) {
  const disk = resolveDiskSourcesSync(pluginOptions, runtimeContext);
  const directory = disk.baseDir;

  // Query live ctx.config if available
  if (typeof runtimeContext.configApi?.get === "function") {
    try {
      const cfgRes = await runtimeContext.configApi.get();
      const cfgData = cfgRes?.data || cfgRes;
      if (cfgData && typeof cfgData === "object") {
        const gObj = cfgData?.providers?.google || cfgData?.provider?.google;
        if (gObj) {
          const extracted = extractProviderFields(gObj, directory);
          if (extracted.baseURL) disk.googleProvider.baseURL = extracted.baseURL;
          if (extracted.apiKey) disk.googleProvider.apiKey = extracted.apiKey;
          if (extracted.model) disk.googleProvider.model = extracted.model;
          if (extracted.integrationID) disk.googleProvider.integrationID = extracted.integrationID;
          Object.assign(disk.googleProvider.headers, extracted.headers);
        }
      }
    } catch {
      // Ignore config API errors
    }
  }

  // Query live ctx.provider.get({ providerID: "google" }) if available
  if (typeof runtimeContext.provider?.get === "function") {
    try {
      const provRes = await runtimeContext.provider.get({ providerID: "google" });
      const provData = provRes?.data || provRes;
      if (provData && typeof provData === "object") {
        const extracted = extractProviderFields(provData, directory);
        if (extracted.baseURL) disk.googleProvider.baseURL = extracted.baseURL;
        if (extracted.apiKey) disk.googleProvider.apiKey = extracted.apiKey;
        if (extracted.model) disk.googleProvider.model = extracted.model;
        if (extracted.integrationID) {
          disk.googleProvider.integrationID = extracted.integrationID;
          if (!disk.secondaryIds.includes(extracted.integrationID)) {
            disk.secondaryIds.unshift(extracted.integrationID);
          }
        }
        Object.assign(disk.googleProvider.headers, extracted.headers);
      }
    } catch {
      // Ignore provider API errors (e.g. ProviderNotFoundError)
    }
  }

  // Query live ctx.integration.connection.active + resolve if available
  if (runtimeContext.integration?.connection) {
    const primaryRuntimeCred = await resolveFromIntegrationApi(
      runtimeContext.integration,
      disk.primaryIds,
      directory
    );
    if (primaryRuntimeCred) {
      disk.primaryCredential = primaryRuntimeCred;
    }

    const secondaryRuntimeCred = await resolveFromIntegrationApi(
      runtimeContext.integration,
      disk.secondaryIds,
      directory
    );
    if (secondaryRuntimeCred) {
      disk.secondaryCredential = secondaryRuntimeCred;
    }
  }

  return buildFinalConfig(pluginOptions, disk);
}

/**
 * Truncates long error text and masks sensitive credentials/query keys before surfacing errors.
 */
function sanitizeErrorText(text, maxLength = 500) {
  if (typeof text !== "string") return "";
  const masked = text
    .replace(/([?&]key=)[^&\s"']+/gi, "$1***")
    .replace(/(["']?(?:api[_-]?key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?Bearer\s+)[^\s"',}]+/gi, "$1***")
    .replace(/(["']?(?:api[_-]?key|x-goog-api-key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1***");
  if (masked.length <= maxLength) return masked;
  return `${masked.slice(0, maxLength - 3)}...`;
}

/**
 * Determines whether an HTTP error from a model endpoint is a global fatal authentication/account
 * error (which should abort immediately) vs a model-specific failure (which should fall back).
 */
export function isFatalClientError(statusCode, errorBody, rawText = "") {
  if (statusCode === 401) return true;
  if (statusCode !== 400 && statusCode !== 403) return false;

  const detailsStr = JSON.stringify(errorBody?.error || {});
  const combined = `${errorBody?.error?.message || ""} ${detailsStr} ${rawText}`;

  // Global API key / credential / billing errors should halt immediately
  return /api[_\s-]?key[_\s-]?(?:not[_\s-]?valid|invalid|expired|missing)|API_KEY_INVALID|unauthenticated|invalid[_\s-]?credentials|account[_\s-]?disabled|billing[_\s-]?not[_\s-]?enabled/i.test(
    combined
  );
}

/**
 * Safely escapes markdown square brackets and whitespace in link titles.
 */
export function escapeMarkdown(str) {
  if (!str) return "";
  return str
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Escapes parentheses and spaces in URLs so Markdown link syntax [title](url) never breaks.
 */
export function escapeMarkdownUrl(uri) {
  if (!uri) return "";
  return uri
    .trim()
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s+/g, "%20");
}

/**
 * Validates and normalizes an http(s) URL for OpenChamber card rendering.
 */
function sanitizeHttpUrl(uri) {
  if (!uri || typeof uri !== "string") return "";
  const trimmed = uri.trim().replace(/\s+/g, "%20");
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return trimmed;
    }
  } catch {
    return "";
  }
  return "";
}

/**
 * Extracts a clean hostname domain from a URL, ignoring generic Google redirect domains.
 */
function extractDomain(uri) {
  if (!uri) return "";
  try {
    const hostname = new URL(uri).hostname.replace(/^www\./, "");
    if (hostname === "vertexaisearch.cloud.google.com") return "";
    return hostname;
  } catch {
    return "";
  }
}

/**
 * Maps grounding supports to citation insertion markers based on remapped display indices.
 */
export function buildCitationInsertions(supports, remapTable) {
  if (!supports || supports.length === 0 || !remapTable || remapTable.size === 0) return [];

  const mergedMap = new Map();
  for (const support of supports) {
    const segment = support?.segment;
    const indices = support?.groundingChunkIndices;
    if (!segment || segment.endIndex == null || !Array.isArray(indices) || indices.length === 0) continue;

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
 * Aligns positions to valid UTF-8 code point boundaries and steps back before trailing newlines.
 */
export function insertMarkersByUtf8Index(text, insertions) {
  if (!insertions || insertions.length === 0) return text;
  const encoder = new TextEncoder();
  const responseBytes = encoder.encode(text);
  const parts = [];
  let lastIndex = responseBytes.length;

  for (const insertion of insertions) {
    let position = Math.max(0, Math.min(insertion.index, lastIndex));

    // Align position if it lands on a UTF-8 continuation byte (0b10xxxxxx)
    while (position < lastIndex && (responseBytes[position] & 0xc0) === 0x80) {
      position++;
    }
    while (position > 0 && position < responseBytes.length && (responseBytes[position] & 0xc0) === 0x80) {
      position--;
    }

    // Step back before trailing CR/LF so markers never wrap onto the start of the next line
    while (position > 0 && (responseBytes[position - 1] === 0x0a || responseBytes[position - 1] === 0x0d)) {
      position--;
    }

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
export function formatOutput(rawText, metadata, maxSources = 8) {
  let text = rawText || "";
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
  const supports = Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports : [];
  const parsedMax = Number(maxSources);
  const safeMaxSources = Number.isFinite(parsedMax) ? Math.max(1, Math.min(Math.floor(parsedMax), 20)) : 8;

  // Identify all chunk indices cited in supports
  const citedIndicesSet = new Set();
  for (const support of supports) {
    const indices = support?.groundingChunkIndices;
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
    // Sort cited indices in ascending order and cap to safeMaxSources
    selectedChunkIndices = Array.from(citedIndicesSet)
      .sort((a, b) => a - b)
      .slice(0, safeMaxSources);
    selectedChunkIndices.forEach((chunkIdx, i) => {
      remapTable.set(chunkIdx, i + 1);
    });
  } else if (chunks.length > 0) {
    // If no explicit supports were provided but chunks exist, take top safeMaxSources
    const count = Math.min(chunks.length, safeMaxSources);
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
      const rawTitle = chunk?.web?.title?.trim() || "";
      const uri = chunk?.web?.uri?.trim() || "";
      const fallbackTitle = extractDomain(uri) || `Source ${displayIdx}`;
      const title = rawTitle || fallbackTitle;
      const safeTitle = escapeMarkdown(title);
      const safeUri = escapeMarkdownUrl(uri);
      structuredSources.push({
        index: displayIdx,
        title,
        uri,
      });
      return safeUri ? `[${displayIdx}] [${safeTitle}](${safeUri})` : `[${displayIdx}] ${safeTitle}`;
    });
    parts.push(`Sources:\n${sourceLines.join("\n")}`);
  }

  const queries = Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries : [];
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
 * Internal execution logic for Google Search grounding with fallback chain.
 */
async function executeGroundingWithFallback({
  query,
  context,
  requestedModel,
  maxSources,
  config,
  signal,
  progress,
  storage,
  cacheEnabled,
  cacheKey,
}) {
  const currentDate = new Date().toISOString().slice(0, 10);
  const prompt = [
    query,
    context ? `\nAdditional context:\n${context}` : "",
    `\nCurrent date: ${currentDate}. Use Google Search grounding to provide accurate, up-to-date information with source attribution.`,
  ].join("");

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
    if (signal.aborted) {
      clearTimeout(totalTimer);
      throw signal.reason || new Error("Operation cancelled by user");
    }
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

      const querySuffix = config.keyInQuery ? `?key=${encodeURIComponent(config.apiKey)}` : "";
      const url = `${config.baseURL}/models/${currentModel}:generateContent${querySuffix}`;
      const headers = buildRequestHeaders(config);

      const requestBody = {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        tools: [{ googleSearch: {} }],
      };

      if (config.thinkingLevel && /^gemini-[34]/i.test(currentModel)) {
        requestBody.generationConfig = {
          thinkingConfig: {
            thinkingLevel: config.thinkingLevel,
          },
        };
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: requestController.signal,
        });

        const text = await response.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }

        const statusCode = response.status || body?.error?.code;

        // Halt immediately on global authentication / invalid API key errors (even non-JSON 401/403)
        if (isFatalClientError(statusCode, body, text)) {
          const rawMsg = body?.error?.message || text || response.statusText || "Authentication error";
          const msg = sanitizeErrorText(String(rawMsg), 500);
          throw new FatalError(
            `Google grounding authentication/client error (${statusCode}) on model '${currentModel}': ${msg}`,
            statusCode
          );
        }

        if (body === null) {
          const safeText = sanitizeErrorText(text, 500);
          throw new Error(`Failed to parse response from ${currentModel} (${response.status}): ${safeText}`);
        }

        if (!response.ok || body?.error) {
          const rawMsg = body?.error?.message || text || response.statusText || "Request failed";
          const msg = sanitizeErrorText(String(rawMsg), 500);
          throw new Error(`Google grounding request to ${currentModel} failed (${response.status}): ${msg}`);
        }

        if (body?.promptFeedback?.blockReason) {
          throw new Error(
            `Prompt blocked on model '${currentModel}': blockReason=${body.promptFeedback.blockReason}`
          );
        }

        const candidate = body.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const candidateParts = candidate?.content?.parts || [];
        let responseText = "";
        for (const part of candidateParts) {
          if (part?.thought) continue;
          if (typeof part?.text === "string") {
            responseText += part.text;
          }
        }

        const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
        const hasGroundingChunks = Array.isArray(groundingChunks) && groundingChunks.length > 0;
        const hasBodyText = responseText.trim().length > 0;

        if (!hasBodyText && (!hasGroundingChunks || (finishReason && finishReason !== "STOP"))) {
          throw new Error(
            `Model '${currentModel}' returned empty output${finishReason ? ` (finishReason=${finishReason})` : ""}`
          );
        }

        await reportProgress(progress, "Rendering citations and sources...");

        const formatted = formatOutput(responseText, candidate?.groundingMetadata, maxSources);
        const result = {
          content: formatted.content,
          sources: formatted.sources,
          model: currentModel,
          cached: false,
        };

        // Cache result in ctx.storage ONLY when non-empty body text was produced
        if (hasBodyText && cacheEnabled && cacheKey && storage && typeof storage.set === "function") {
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
        if (err instanceof Error && err.message && config.keyInQuery && err.message.includes("key=")) {
          err.message = sanitizeErrorText(err.message, 500);
        }
        lastError = err;

        // Propagate fatal auth errors and external/overall cancellations immediately
        if (err instanceof FatalError) {
          throw err;
        }
        if (totalController.signal.aborted) {
          throw totalController.signal.reason || err;
        }

        // For retryable or model-specific errors (429, 400 unsupported model, 404, 5xx, empty output) or timeouts, fall back
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

/**
 * Dispatches the generateContent call with googleSearch grounding enabled,
 * supporting dynamic model selection, per-request timeouts, automatic fallback,
 * context.progress reporting, subscriber-refcounted in-flight deduplication, and durable ctx.storage caching.
 */
export async function runGoogleGrounding(args, runContext = {}) {
  const query = args?.query?.trim();
  if (!query) {
    throw new Error("The 'query' parameter is required.");
  }

  // Discriminate runContext: supports either AbortSignal or context object
  let signal;
  let progress;
  let storage;
  let pluginOptions = {};
  let runtimeExtras = {};

  if (runContext && typeof runContext.addEventListener === "function") {
    signal = runContext;
  } else if (runContext && typeof runContext === "object") {
    signal = runContext.signal;
    progress = runContext.progress;
    storage = runContext.storage;
    pluginOptions = runContext.options || {};
    runtimeExtras = {
      integration: runContext.integration,
      provider: runContext.provider,
      configApi: runContext.configApi || (typeof runContext.config?.get === "function" ? runContext.config : undefined),
      directory: runContext.directory,
      dbPath: runContext.dbPath,
      authPath: runContext.authPath,
    };
  }

  if (signal?.aborted) {
    throw signal.reason || new Error("Operation cancelled by user");
  }

  const hasLiveRuntimeApis = Boolean(
    runtimeExtras.configApi?.get ||
      runtimeExtras.provider?.get ||
      runtimeExtras.integration?.connection
  );
  const config = hasLiveRuntimeApis
    ? await resolveConfigAsync(pluginOptions, runtimeExtras)
    : resolveConfig(pluginOptions, runtimeExtras);

  if (signal?.aborted) {
    throw signal.reason || new Error("Operation cancelled by user");
  }

  if (!config.apiKey) {
    throw new FatalError(
      "Missing API key for Google grounding. Please configure it in OpenChamber WebSearch settings, opencode.db/auth.json, opencode.jsonc plugin options, or set GOOGLE_API_KEY / OPENCODE_GOOGLE_API_KEY environment variable.",
      401
    );
  }

  const parsedMaxSources = Number(args.max_sources);
  const maxSources = Number.isFinite(parsedMaxSources)
    ? Math.max(1, Math.min(Math.floor(parsedMaxSources), 20))
    : 8;

  const requestedModel = normalizeModelId(args.model);
  const effectivePrimaryModel = requestedModel || config.model;
  const dedupeKey = makeCacheKey(query, args.context, effectivePrimaryModel, maxSources, config.baseURL);

  // --- Cache lookup via ctx.storage ---
  const cacheEnabled = config.cacheTtlMs > 0 && Boolean(storage && typeof storage.get === "function");
  const cacheKey = cacheEnabled ? dedupeKey : null;

  if (cacheEnabled && cacheKey) {
    try {
      const cached = await storage.get(cacheKey);
      if (signal?.aborted) {
        throw signal.reason || new Error("Operation cancelled by user");
      }
      if (cached && typeof cached === "object" && cached.timestamp) {
        if (Date.now() - cached.timestamp < config.cacheTtlMs) {
          await reportProgress(progress, "Found cached Google search results");
          return {
            content: cached.content,
            sources: cached.sources || [],
            model: cached.model || effectivePrimaryModel,
            cached: true,
          };
        } else if (typeof storage.remove === "function") {
          Promise.resolve(storage.remove(cacheKey)).catch(() => {});
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // Storage read errors should not abort search
    }
  }

  // --- Singleflight in-flight deduplication with subscriber ref-counting for AbortSignals ---
  let entry = inFlightRequests.get(dedupeKey);
  if (entry && entry.sharedController.signal.aborted) {
    inFlightRequests.delete(dedupeKey);
    entry = undefined;
  }

  const subscriber = { signal: signal || null };

  if (!entry) {
    const sharedController = new AbortController();
    const subscribers = new Set([subscriber]);
    const progressListeners = new Set();
    if (typeof progress === "function") {
      progressListeners.add(progress);
    }

    const sharedProgress = async (statusObj) => {
      const status = typeof statusObj === "string" ? statusObj : statusObj?.status;
      for (const listener of Array.from(progressListeners)) {
        await reportProgress(listener, status);
      }
    };

    entry = {
      sharedController,
      subscribers,
      progressListeners,
      promise: null,
      settled: false,
    };
    inFlightRequests.set(dedupeKey, entry);

    const executionPromise = executeGroundingWithFallback({
      query,
      context: args.context,
      requestedModel,
      maxSources,
      config,
      signal: sharedController.signal,
      progress: sharedProgress,
      storage,
      cacheEnabled,
      cacheKey,
    });

    entry.promise = executionPromise;
    executionPromise
      .finally(() => {
        entry.settled = true;
        if (inFlightRequests.get(dedupeKey) === entry) {
          inFlightRequests.delete(dedupeKey);
        }
      })
      .catch(() => {});
  } else {
    entry.subscribers.add(subscriber);
    if (typeof progress === "function") {
      entry.progressListeners.add(progress);
    }
  }

  if (!signal) {
    try {
      return await entry.promise;
    } finally {
      entry.subscribers.delete(subscriber);
      if (typeof progress === "function") {
        entry.progressListeners.delete(progress);
      }
    }
  }

  return await new Promise((resolve, reject) => {
    let settledForCaller = false;

    const cleanup = () => {
      entry.subscribers.delete(subscriber);
      if (typeof progress === "function") {
        entry.progressListeners.delete(progress);
      }
      signal.removeEventListener("abort", onCallerAbort);
    };

    const onCallerAbort = () => {
      if (settledForCaller) return;
      settledForCaller = true;
      const reason = signal.reason || new Error("Operation cancelled by user");
      cleanup();

      if (entry.subscribers.size === 0 && !entry.settled) {
        if (inFlightRequests.get(dedupeKey) === entry) {
          inFlightRequests.delete(dedupeKey);
        }
        entry.sharedController.abort(reason);
      }
      reject(reason);
    };

    if (signal.aborted) {
      onCallerAbort();
      return;
    }

    signal.addEventListener("abort", onCallerAbort, { once: true });

    entry.promise.then(
      (result) => {
        if (settledForCaller) return;
        settledForCaller = true;
        cleanup();
        resolve(result);
      },
      (err) => {
        if (settledForCaller) return;
        settledForCaller = true;
        cleanup();
        reject(err);
      }
    );
  });
}

export default {
  id: "google-grounding",
  setup: async (ctx) => {
    const pluginOptions = ctx?.options || {};
    const runtimeContext = {
      integration: ctx?.integration,
      provider: ctx?.provider,
      configApi: ctx?.config,
      directory: ctx?.location?.directory,
    };

    // 1. Integration domain registration (OpenChamber Settings -> Web Search -> Google Gemini Grounding)
    if (ctx?.integration?.transform) {
      await ctx.integration.transform((editor) => {
        editor.update("google-grounding", (integration) => {
          integration.name = "Google Gemini Grounding";
          integration.metadata = {
            ...(integration.metadata || {}),
            websearch: true,
          };
        });

        editor.method.update({
          integrationID: "google-grounding",
          method: {
            type: "key",
            label: "API Key",
            form: [
              {
                key: "baseURL",
                type: "string",
                title: "Base URL (Optional)",
                description:
                  "Custom Gemini API gateway or reverse proxy URL. Leave empty for the official Google API.",
                placeholder: DEFAULT_GEMINI_BASE_URL,
                required: false,
                format: "uri",
              },
              {
                key: "model",
                type: "string",
                title: "Preferred Model (Optional)",
                description:
                  "Default Gemini model for Google Search grounding (e.g. gemini-4-hydrogen, gemini-3.8-flash).",
                placeholder: DEFAULT_MODEL,
                required: false,
              },
            ],
          },
        });

        editor.method.update({
          integrationID: "google-grounding",
          method: {
            type: "env",
            names: [
              "OPENCODE_GOOGLE_API_KEY",
              "GOOGLE_API_KEY",
              "GOOGLE_GENERATIVE_AI_API_KEY",
              "GEMINI_API_KEY",
            ],
          },
        });
      });
    }

    // 2. Tool domain registration (for direct tool invocations)
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
                  "Optional Gemini model ID for grounding (e.g. 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.7-flash'). Defaults to configured model with automatic fallback.",
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
              ...runtimeContext,
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

        // Register legacy 'websearch_cited' alias only when explicitly enabled to save prompt tokens
        const enableLegacyAlias =
          Boolean(pluginOptions.enableLegacyAlias) ||
          process.env.OPENCODE_GOOGLE_LEGACY_ALIAS === "true";

        if (enableLegacyAlias) {
          tools.add({
            name: "websearch_cited",
            ...toolDef,
          });
        }
      });
    }

    // 3. Websearch domain registration (for OpenCode V2 native web search integration)
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
                ...runtimeContext,
              }
            );

            const validSources = (result.sources || [])
              .map((s) => ({
                ...s,
                safeUrl: sanitizeHttpUrl(s?.uri),
              }))
              .filter((s) => Boolean(s.safeUrl));

            if (validSources.length > 0) {
              return validSources.map((s, idx) => {
                const title = s.title || `Source [${s.index}]`;
                // Card 0 carries the full synthesis so the model receives all facts in complete context.
                // Subsequent cards provide their own concise cited sentence snippets, avoiding duplicate
                // token bloat while ensuring every discovered source appears as an individual clickable card in the UI.
                const snippet =
                  idx === 0
                    ? result.content
                    : extractSnippetForSource(s.index, result.content) || `Cited reference: ${title}`;

                return {
                  url: s.safeUrl,
                  title,
                  content: snippet,
                  time: {},
                };
              });
            }

            return [
              {
                url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
                title: "Google Gemini Grounding Result",
                content: result.content,
                time: {},
              },
            ];
          },
        });

        // Respect explicit user choice / disabled state unless setDefaultWebsearch: true is explicitly requested
        if (editor.default?.set) {
          if (pluginOptions.setDefaultWebsearch === true) {
            editor.default.set("google-grounding");
          } else if (pluginOptions.setDefaultWebsearch !== false) {
            const currentDefault =
              typeof editor.default.get === "function" ? editor.default.get() : undefined;
            if (currentDefault === undefined) {
              editor.default.set("google-grounding");
            }
          }
        }
      });
    }
  },
};
