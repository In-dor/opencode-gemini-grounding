<div align="center">

# opencode-google-grounding-v2

<p>
  <strong>专为 OpenCode V2 打造的高性能 LLM 搜索接地（Grounding）插件</strong><br />
  基于 Google Gemini 搜索接地能力，提供学术论文级精准行内角标（<code>[1]</code>, <code>[2]</code>）、来源链接与自动容灾降级。
</p>

<p>
  <a href="https://opencode.ai"><img src="https://img.shields.io/badge/OpenCode-V2%20兼容-4F46E5?style=flat-square" alt="OpenCode V2" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/ESM-原生支持-blue.svg?style=flat-square" alt="ESM" />
  <img src="https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform" />
</p>

<p>
  <a href="README.md"><strong>English</strong></a> · <a href="README_CN.md"><strong>简体中文</strong></a>
</p>

---

</div>

## 🌟 概述

`opencode-google-grounding-v2` 是遵循 OpenCode V2 官方最新规范开发的联网搜索扩展插件。无论当前会话的主力模型是 Claude、DeepSeek、GPT 还是其他本地模型，均可通过本插件一键赋予其实时联网检索、核实最新事实以及追溯原始网页来源的能力。

与常见的粗粒度搜索引擎工具不同，本插件基于 Gemini Google Search Grounding，返回高度浓缩的事实总结，并利用 **UTF-8 字符字节偏移量算法** 将 **`[1]`、`[2]` 行内引用角标** 精准附着在对应事实的句尾，文末附带真实的网页来源和关键词检索记录。

---

## ✨ 核心特性

- **🚀 原生适配 OpenCode V2 核心体系**：基于 V2 `id` + `setup(ctx)` 生命周期开发，同时深度对接 `ctx.tool`、`ctx.websearch`、`ctx.storage` 与 `context.progress`。
- **🌐 Tool + Websearch 双体系注册**：
  - **自定义工具**：暴露 `google_grounding` 与 `websearch_cited` 两个别名工具，并入驻 Code Mode 的 `search` 命名空间（`tools.search.google_grounding`）。
  - **全局系统搜索引擎**：自动将 Google Gemini Grounding 注册并设为 OpenCode V2 全局默认的 `websearch` 提供商，任何使用内置网络搜索的 Agent 均能享受精准接地。
- **⚡ 原生持久化缓存（`ctx.storage`）**：依托 OpenCode Server 原生沙盒存储实现 TTL 缓存（默认 10 分钟），重复提问秒级瞬返，零额外延迟、零 Token 开销、彻底免疫 429。
- **🔔 实时进度与状态反馈（`context.progress`）**：在 TUI 终端与 Web 界面中动态显示“正在检索 Google...”、“已命中本地缓存”、“正在顺延降级至下一模型...”等友好进度条。
- **⚙️ 标准化 `ctx.options` 支持**：支持在 `opencode.jsonc` 中直接为插件传入结构化 options 配置，配合 `{env:VAR}` 插值，免除硬编码与手动文件解析。
- **⚡ 故障自动容灾降级链**：内置多模型备选梯队，单模型请求超时宽松设定为 45 秒，总超时 180 秒（3 分钟）。遇到限流（HTTP 429）或网关波动时自动无感顺延；遇到鉴权无效（HTTP 401/403）等致命错误立即终止，绝不盲目轮询浪费时间。
- **🧠 动态模型即时切换与归一化**：支持在单次搜索时动态指定任意 Gemini 模型，自动兼容 `google/` 等前缀写法并完成格式归一化。
- **📍 学术级精准角标排版与防断链**：解析底层的 `groundingSupports`，动态维护角标重映射（Remap），确保正文 `[1]`、`[2]` 与文末 Sources 严格一一对应；文末采用美观的 Markdown 超链接，告别超长重定向链接刷屏。
- **🌐 深度兼容自建网关与中转**：同时支持原生 `x-goog-api-key` 与 `Authorization: Bearer` 请求头，完美兼容 OneAPI、NewAPI、Cloudflare AI Gateway 等第三方网关与反向代理。
- **🛡️ 纯外挂零系统侵入与安全感知**：作为独立的自定义工具运行；若触发服务商安全策略拦截，清晰透出拦截原因（如 `SAFETY`），避免智能体误判为无搜索结果。

---

## 🛠️ 工具参数说明

插件注册了 `google_grounding` 与 `websearch_cited` 两个完全同义的工具：

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `query` | `string` | **是** | 待检索的问题或自然语言搜索词。 |
| `model` | `string` | 否 | 动态指定本次搜索采用的 Gemini 模型 ID（如 `gemini-3.5-flash-lite`、`gemini-3.8-flash` 等）。不传则按配置取默认值。 |
| `context` | `string` | 否 | 可选的额外约束条件、背景事实或引导指令。 |
| `max_sources` | `number` | 否 | 最大返回来源网页链接数（1 ~ 20，默认值为 `8`）。 |

---

## ⚙️ 配置与优先级规则

### 1. 现代化插件选项配置（推荐，`opencode.jsonc`）

你可以直接在 `~/.config/opencode/opencode.jsonc` 中配置插件专属选项：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-google-grounding-v2",
      "options": {
        "model": "gemini-3.5-flash-lite",      // 默认首选检索模型
        "apiKey": "{env:GOOGLE_API_KEY}",       // 自动解析环境变量
        "cacheTtlMs": 600000,                  // 本地持久化缓存时间（毫秒，默认10分钟，0为禁用）
        "requestTimeoutMs": 45000,              // 单个模型请求超时时间（45秒）
        "timeoutMs": 180000,                    // 容灾降级总超时（3分钟）
        "setDefaultWebsearch": true             // 自动设为 OpenCode 全局默认 WebSearch 源
      }
    }
  ]
}
```

### 2. 模型选择优先级（Model）
1. 本次工具调用动态传入的 `model` 参数；
2. `opencode.jsonc` 插件选项 `options.model`；
3. 环境变量 `OPENCODE_GOOGLE_MODEL`；
4. `opencode.jsonc` 中的 `providers.google.model` 或 `settings.model`；
5. `opencode.jsonc` 中的 `providers.google.options.websearch_cited.model`；
6. 默认回退值：`gemini-3.5-flash-lite`。

> **容灾降级链机制**：
> 若首选模型请求失败或触发频率限制，插件将按如下顺序自动降级重试：
> `[请求模型] -> gemini-3.5-flash-lite -> gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.1-flash-lite -> gemini-3-flash-preview -> gemini-2.5-flash`。

### 2. 接口基础地址（Base URL）
1. 环境变量 `OPENCODE_GOOGLE_BASE_URL`；
2. `~/.config/opencode/opencode.jsonc` 中的 `providers.google.settings.baseURL`；
3. 默认值：`https://generativelanguage.googleapis.com/v1beta`（Google 官方端点）。

### 3. API 密钥（API Key）
1. 环境变量 `OPENCODE_GOOGLE_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY`；
2. OpenCode 本地存储凭据 `~/.local/share/opencode/auth.json`（`google.key` 或 `indor.key`）；
3. `opencode.jsonc` 中的 `providers.google.settings.apiKey`。

---

## 📦 本地引入方式

### 方式一：全局插件重导出桥接（推荐）

在 OpenCode 全局插件目录新建 `~/.config/opencode/plugins/google-grounding.js`，指向本仓库入口：

```javascript
export { default } from "file:///D:/OpenCode/opencode-google-grounding-v2/index.js";
```

### 方式二：目录软链接（Junction）

直接将本仓库目录挂载到 OpenCode 全局插件目录下：

```powershell
# Windows 环境（PowerShell）
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\plugins\opencode-google-grounding-v2" "D:\OpenCode\opencode-google-grounding-v2"
```

验证插件是否已被 OpenCode 识别：

```bash
opencode plugin list
```

---

## 📝 输出示例

```markdown
根据北京市气象台发布的最新预报，北京今日（9月27日）天气概况如下[1]：

* **天气状况**：多云转晴，夜间晴间多云（雨后放晴，能见度良好）[1][2]
* **气温**：最高气温 26℃ 左右，夜间最低气温 15℃ ~ 16℃[1][3]
* **风向风力**：白天偏北风3级，阵风可达 5~6级[1]

Sources:
[1] [北京日报网 - 今日气象通报](https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
[2] [中国天气网 - 降水与晴雨实况](https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
[3] [国家气象中心 - 气温走势预警](https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)

Search queries: 北京天气 气象台 2026年9月27日
```

---

## 🙏 致谢（Acknowledgements）

本项目在设计与实现过程中，吸纳并借鉴了两个优秀的 OpenCode V1 前辈开源项目的核心思想：

- **[ghoulr/opencode-websearch-cited](https://github.com/ghoulr/opencode-websearch-cited)**（作者：[@ghoulr](https://github.com/ghoulr)）：启发了学术论文级的行内引用格式（`[1]`、`[2]`）设计，以及基于 `groundingSupports` 的 UTF-8 字节偏移量切片插入算法。
- **[janaki-sasidhar/opencode-google-grounding](https://github.com/janaki-sasidhar/opencode-google-grounding)**（作者：[@janaki-sasidhar](https://github.com/janaki-sasidhar)）：启发了纯外挂、零侵入的独立 Custom Tool 架构设计，以及对自定义 `baseURL` 代理网关的灵活解析机制。

---

## 📄 许可证

基于 [MIT License](./LICENSE) 开源发布。
