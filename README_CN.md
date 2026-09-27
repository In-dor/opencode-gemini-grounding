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

- **🚀 原生适配 OpenCode V2**：严格采用 V2 的 `id` + `setup(ctx)` + `ctx.tool.transform` 扩展架构，纯 ESM 代码，零构建步骤。
- **🛡️ 纯外挂零系统侵入**：作为独立的自定义工具运行，不修改 Provider 认证拦截器，绝不引发登录或鉴权冲突。
- **🔄 双工具名无缝兼容**：同时注册 `google_grounding` 与 `websearch_cited` 两个工具名，满足任意系统提示词或模型的调用习惯。
- **🧠 动态模型即时切换**：支持在单次搜索时动态指定任意 Gemini 模型（如轻量高频使用 `gemini-3.5-flash-lite`，深度研究使用 `gemini-3.1-pro-preview` 等）。
- **⚡ 故障自动容灾降级链**：内置多模型备选梯队，当所选模型遭遇并发限流（HTTP 429）或网关波动时，自动无感顺延尝试下一候选模型。
- **📍 学术级精准角标排版**：解析底层的 `groundingSupports`，精确在对应事实句末嵌入角标，并在文末生成美观的 `Sources:` 链接列表。
- **🌐 深度兼容自建网关与中转**：支持直接复用 `~/.config/opencode/opencode.jsonc` 中配置的局域网/反向代理地址（如 OneAPI、NewAPI）与已存凭据。

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

插件在初始化和执行时，按以下优先级逐层解析连接参数：

### 1. 模型选择（Model）
1. 本次工具调用动态传入的 `model` 参数；
2. 环境变量 `OPENCODE_GOOGLE_MODEL`；
3. `opencode.jsonc` 中的 `providers.google.model` 或 `settings.model`；
4. `opencode.jsonc` 中的 `providers.google.options.websearch_cited.model`；
5. 默认回退值：`gemini-3.5-flash-lite`。

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
[1] bjd.com.cn (https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
[2] weather.com.cn (https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
[3] nmc.cn (https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)

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
