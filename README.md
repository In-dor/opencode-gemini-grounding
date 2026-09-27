# opencode-google-grounding (OpenCode V2)

适用于 [OpenCode V2](https://opencode.ai) 的联网搜索插件，基于 Gemini Google Search Grounding（搜索接地）能力，提供学术论文级的行内引用（`[1]`、`[2]`）与文末来源网页链接。

## 特性

- **原生支持 OpenCode V2**：严格遵循 V2 插件规范（`id` + `setup(ctx)` + `ctx.tool.transform`）。
- **零系统侵入**：纯外挂独立工具架构，不篡改 Provider 认证生命周期，不干扰主流程。
- **双工具名兼容**：同时注册 `google_grounding` 与 `websearch_cited` 两个名称，Prompt 无论提到哪个均可直接调用。
- **动态模型选择与故障自动降级**：
  - 支持在工具调用时动态传入 `model`（如 `gemini-3.5-flash-lite`、`gemini-3.8-flash`、`gemini-3.1-pro-preview`）；
  - 支持通过配置文件或环境变量随时变更默认模型；
  - 内置自动容灾降级链：首选模型遇限流（429）或故障时，自动按优先级顺延尝试候选模型，杜绝搜索中断。
- **精准行内引用标注**：利用 `groundingSupports` 的 UTF-8 字节偏移量算法，在正文具体事实句末精准插入 `[1]`、`[2]` 角标。
- **来源与检索词展示**：文末自动输出带标题与真实网页 URL 的 `Sources:` 列表及 `Search queries:`。
- **自定义网关友好**：自动复用 `~/.config/opencode/opencode.jsonc` 中配置的本地 Gemini 网关（如 `http://192.168.31.198:7870/v1beta`）及已保存的密钥，同时也支持官方 API 与环境变量兜底。

## 注册工具名

- `google_grounding`
- `websearch_cited`

## 工具入参说明

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `query` | `string` | 是 | 搜索问题或检索词 |
| `model` | `string` | 否 | 动态指定当前搜索要用的 Gemini 模型（如 `gemini-3.5-flash-lite`）。未指定时按配置优先级取默认值 |
| `context` | `string` | 否 | 附加的约束条件或背景上下文 |
| `max_sources` | `number` | 否 | 单次最大返回来源网页数（1~20），默认 `8` |

## 配置与参数优先级

插件解析请求参数的顺序如下：

1. **模型（Model）选择优先级**：
   - 工具入参实时指定的 `model`
   - 环境变量 `OPENCODE_GOOGLE_MODEL`
   - `opencode.jsonc` 中的 `providers.google.model` 或 `settings.model`
   - `opencode.jsonc` 中的 `providers.google.options.websearch_cited.model`
   - 默认值：`gemini-3.8-flash`
   - *（注：如果上述指定的模型遇到 429 限流或请求失败，插件会自动按 `3.8-flash -> 3.7-flash -> 3.5-flash-lite -> 3-flash-preview -> 2.5-flash` 顺序自动平滑降级重试）*

2. **接口基础地址（Base URL）**：
   - 环境变量 `OPENCODE_GOOGLE_BASE_URL`
   - `~/.config/opencode/opencode.jsonc` 中的 `providers.google.settings.baseURL`
   - 默认值：`https://generativelanguage.googleapis.com/v1beta`

3. **API 密钥（API Key）**：
   - 环境变量 `OPENCODE_GOOGLE_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY`
   - `~/.local/share/opencode/auth.json` 中保存的凭据（`google.key` 或 `indor.key`）
   - `opencode.jsonc` 中的 `providers.google.settings.apiKey`

## 本地安装与引入方式

在 `~/.config/opencode/plugins/google-grounding.js` 中直接重导出本仓库：

```javascript
export { default } from "file:///D:/OpenCode/opencode-google-grounding/index.js";
```

查看已加载的插件：

```sh
opencode plugin list
```

## 许可证

MIT
