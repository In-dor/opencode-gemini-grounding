<div align="center">

# opencode-google-grounding-v2

<p>
  <strong>High-performance, LLM-grounded web search plugin for OpenCode V2</strong><br />
  Powered by Google Gemini Search Grounding with academic-style inline citations and fault-tolerant fallback.
</p>

<p>
  <a href="https://opencode.ai"><img src="https://img.shields.io/badge/OpenCode-V2%20Compatible-4F46E5?style=flat-square" alt="OpenCode V2" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/ESM-Native-blue.svg?style=flat-square" alt="ESM" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform" />
</p>

<p>
  <a href="README.md"><strong>English</strong></a> · <a href="README_CN.md"><strong>简体中文</strong></a>
</p>

---

</div>

## 🌟 Overview

`opencode-google-grounding-v2` is an official-specification OpenCode V2 plugin that equips your AI agents (Claude, DeepSeek, GPT, etc.) with real-time Google Web Search capabilities through Gemini Search Grounding.

Unlike standard web search tools, it returns concise, fact-checked answers accompanied by **exact inline citation markers (`[1]`, `[2]`)** injected at precise UTF-8 byte offsets, followed by verified source URLs and executed search queries.

---

## ✨ Features

- **🚀 Native OpenCode V2 Architecture**: Built strictly on OpenCode V2's `id` + `setup(ctx)` lifecycle, integrating deeply with `ctx.tool`, `ctx.websearch`, `ctx.storage`, and `context.progress`.
- **🌐 Tool + Websearch Dual Registration**:
  - **Custom Tools**: Exposes `google_grounding` and `websearch_cited` under the Code Mode `search` namespace (`tools.search.google_grounding`).
  - **System WebSearch Provider**: Automatically registers as an OpenCode V2 default `websearch` provider so any agent using native web search gets grounded facts.
- **⚡ Native Persistent Caching (`ctx.storage`)**: Powered by OpenCode's sandboxed key-value store with configurable TTL (default 10m). Repeating queries return in 0ms with zero token cost and immunity to 429 limits.
- **🔔 Live Progress Feedback (`context.progress`)**: Real-time status reporting in TUI and Web UI ("Searching Google...", "Found cached results", "Falling back to next model...").
- **⚙️ Standardized `ctx.options` Configuration**: Structured plugin configuration via `opencode.jsonc` with support for `{env:VAR}` resolution.
- **⚡ Automatic Fallback Chain**: Built-in fault tolerance—configured with a generous 45s per-model timeout and 180s (3 min) total timeout. Automatically rotates through candidate models on rate limits (HTTP 429) or gateway blips (502/503), while immediately halting on fatal auth errors (401/403).
- **🧠 Dynamic Model Switching & Normalization**: Supports runtime model selection per search call; automatically strips provider prefixes like `google/` to prevent 404s.
- **📍 Academic-Style Precision Citations & Clean Markdown**: Calculates exact UTF-8 byte offsets from Gemini's `groundingSupports` with dynamic index remapping (preventing broken citations) and renders clean Markdown hyperlinks `[1] [Title](url)`.
- **🌐 Reverse Proxy & Custom Gateway Ready**: Dual authentication support with both `x-goog-api-key` and `Authorization: Bearer`, ensuring seamless compatibility with OneAPI, NewAPI, and LAN gateways.
- **🛡️ Safety & Truncation Transparency**: Operates as an independent tool and surfaces explicit provider block reasons (e.g. `SAFETY`) if content is filtered.

---

## 🛠️ Tool Signature

The plugin registers two identical tools: `google_grounding` and `websearch_cited`.

### Parameters

| Argument | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `query` | `string` | **Yes** | The question or natural language search query. |
| `model` | `string` | No | Optional Gemini model ID (e.g. `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-flash-lite`). Defaults to configured model. |
| `context` | `string` | No | Optional extra background, constraints, or guidelines for the search. |
| `max_sources` | `number` | No | Maximum number of grounded source links to return (1-20, default: `8`). |

---

## ⚙️ Configuration & Priority

### 1. Modern Plugin Options (`opencode.jsonc`)

Configure plugin options directly in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-google-grounding-v2",
      "options": {
        "model": "gemini-3.5-flash-lite",      // Primary grounding model
        "apiKey": "{env:GOOGLE_API_KEY}",       // Auto-resolved environment variable
        "cacheTtlMs": 600000,                  // Storage cache duration (ms, default 10m; 0 disables)
        "requestTimeoutMs": 45000,              // Single-model timeout (45s)
        "timeoutMs": 180000,                    // Total fallback chain timeout (3m)
        "setDefaultWebsearch": true             // Register as default OpenCode V2 websearch provider
      }
    }
  ]
}
```

### 2. Model Resolution
1. Dynamic `model` argument provided in the tool call.
2. `options.model` in `opencode.jsonc` plugin options.
3. `OPENCODE_GOOGLE_MODEL` environment variable.
4. `providers.google.model` or `providers.google.settings.model` in `~/.config/opencode/opencode.jsonc`.
5. `providers.google.options.websearch_cited.model`.
6. Default fallback: `gemini-3.5-flash-lite`.

> **Automatic Fallback Chain**:
> If a model fails or hits rate limits, the plugin tries the next candidate automatically:
> `[Requested Model] -> gemini-3.5-flash-lite -> gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.1-flash-lite -> gemini-3-flash-preview -> gemini-2.5-flash`.

### 2. Base URL (API Gateway)
1. `OPENCODE_GOOGLE_BASE_URL` environment variable.
2. `providers.google.settings.baseURL` in `~/.config/opencode/opencode.jsonc`.
3. Default: `https://generativelanguage.googleapis.com/v1beta` (Official Google API).

### 3. API Key
1. `OPENCODE_GOOGLE_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` environment variables.
2. Stored OpenCode credentials in `~/.local/share/opencode/auth.json` (`google.key` or `indor.key`).
3. `providers.google.settings.apiKey` in `opencode.jsonc`.

---

## 📦 Installation in OpenCode V2

### Method 1: Global Plugin Bridge (Recommended)

Create `~/.config/opencode/plugins/google-grounding.js` and re-export this repository:

```javascript
export { default } from "file:///D:/OpenCode/opencode-google-grounding-v2/index.js";
```

### Method 2: Directory Junction / Symlink

Link this repository folder directly into OpenCode's plugin directory:

```powershell
# Windows (PowerShell / Command Prompt)
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\plugins\opencode-google-grounding-v2" "D:\OpenCode\opencode-google-grounding-v2"
```

Verify that the plugin is recognized:

```bash
opencode plugin list
```

---

## 📝 Example Output

```markdown
According to the latest meteorological bulletins, Beijing weather for today (September 27) is clear and pleasant after rain[1]:

* **Condition**: Becoming clear and sunny during the day, partly cloudy at night[1][2].
* **Temperature**: Daytime high around 26°C, dropping to 15°C~16°C overnight[1][3].
* **Wind**: Northerly winds around Force 3 with gusts reaching Force 5~6 during daytime[1].

Sources:
[1] [Beijing Daily - Meteorological Bulletin](https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
[2] [China Weather - Precipitation & Conditions](https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
[3] [National Meteorological Center - Forecast](https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)

Search queries: Beijing weather September 27; Beijing meteorological bureau report
```

---

## 🙏 Acknowledgements

This project builds upon the ideas and implementations of two pioneering OpenCode V1 plugins:

- **[ghoulr/opencode-websearch-cited](https://github.com/ghoulr/opencode-websearch-cited)** by [@ghoulr](https://github.com/ghoulr): For the brilliant concept of LLM-grounded search with academic-style inline citations (`[1]`, `[2]`), and the UTF-8 byte offset insertion algorithm for `groundingSupports`.
- **[janaki-sasidhar/opencode-google-grounding](https://github.com/janaki-sasidhar/opencode-google-grounding)** by [@janaki-sasidhar](https://github.com/janaki-sasidhar): For the lightweight, zero-intrusive standalone tool design, Gemini Search Grounding integration, and flexible custom `baseURL` / proxy resolution.

---

## 📄 License

Distributed under the [MIT License](./LICENSE).
