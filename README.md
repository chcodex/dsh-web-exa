# dsh-web-exa

Exa 驱动的 **Web 搜索** 与 **Web 抓取** provider，注册进 DeepSeek Harness 的网页能力缝隙（`ctx.web`），对齐 OpenCode 的默认 `websearch` / `webfetch` 后端。

- **搜索**：调用 Exa 托管 MCP 端点 `https://mcp.exa.ai/mcp` 的 `web_search_exa` 工具
- **抓取**：调用同一端点的 `web_fetch_exa` 工具（Exa 爬虫，支持 JS 动态渲染、批量 URL、clean markdown）

## 特性

- **匿名可用**：默认不配 API key 即可使用，零成本（受 Exa 免费 tier 限流约束）
- **匿名优先 + 限流自动降级**：配置了 key 时默认走匿名；当天第一次被限流后，自动切换为 key 请求，次日自动恢复匿名
- **search / fetch 共享降级状态**：任一工具触发限流，当天两者都走 key（Exa 的免费配额按 IP 共享）
- 与官方 `deepseek-official` provider 并存，通过 `ctx.web` 的选择规则切换

## 安装

作为 DSH bundle 安装。在 profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-web-exa": "link:/path/to/dsh-web-exa"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-web-exa"]
    }
  }
}
```

然后 `pnpm install` 并重启 DSH。

## 配置

在 profile 的 `cordis.patch.yml` 中选择 provider：

```yaml
- id: web
  config:
    searchProvider: exa
    fetchProvider: exa-fetch
```

### 插件配置项（`Config`）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | — | 搜索用字面量 API key（优先于环境变量） |
| `apiKeyEnv` | `EXA_API_KEY` | 搜索用 API key 的环境变量名 |
| `baseURL` | `https://mcp.exa.ai/mcp` | 搜索 MCP 端点 |
| `numResults` | `8` | 搜索返回条数 |
| `type` | `auto` | 搜索类型：`auto` / `fast` / `deep` |
| `livecrawl` | `fallback` | 实时爬取模式：`fallback` / `preferred` |
| `contextMaxCharacters` | `10000` | 每条结果上下文字符上限 |
| `timeoutMs` | `25000` | 搜索超时（ms） |
| `fetchApiKey` | — | 抓取用字面量 API key |
| `fetchApiKeyEnv` | `EXA_API_KEY` | 抓取用 API key 的环境变量名 |
| `fetchBaseURL` | `https://mcp.exa.ai/mcp` | 抓取 MCP 端点 |
| `fetchMaxCharacters` | `15000` | 每页抓取字符上限 |
| `fetchTimeoutMs` | `30000` | 抓取超时（ms） |

> 搜索与抓取共享同一个 `EXA_API_KEY` 环境变量；如需分开可分别用 `apiKeyEnv` / `fetchApiKeyEnv`。

## 匿名优先 + 限流降级策略

这是本包的核心成本策略：

1. **默认匿名**：未配置 key 或配置了 key，请求都先以匿名方式发出，**不消耗 Exa credits**。
2. **限流触发**：当匿名请求被 Exa 免费 tier 限流（HTTP 429，或响应含 `rate limit` 错误），且存在可用 key 时：
   - 记录"当天已切换"（进程内存，按本地日期）；
   - **本次请求立即带 key 重试一次**。
3. **当天后续请求**：search 与 fetch 都直接走 key（共享同一开关），不再匿名试探。
4. **次日自动恢复匿名**：日期变更后开关自动复位，重新从匿名开始。

**行为矩阵**

| 配置 | 被限流前 | 被限流后（当天） |
| --- | --- | --- |
| 无 key | 匿名（报错时如实抛错） | 匿名（继续报错，不降级） |
| 有 key | 匿名 | 自动切 key |
| 有 key（次日） | 匿名 | —（复位后重新匿名） |

> 降级状态为**进程内存**：进程重启即复位匿名，符合"当天"语义。

## 计费说明（Exa 官方，2026-08）

匿名请求不产生费用；带 key 请求按 Exa 定价逐次计费：

| 端点（对应工具） | 基础价 | 说明 |
| --- | --- | --- |
| `/search`（`web_search_exa`） | **$7 / 1k 次请求**（含前 10 条结果） | 超出 10 条每条 $1/1k；本包默认 8 条，通常只付基础价 |
| `/contents`（`web_fetch_exa`） | **$1 / 1k 页** | 按提取页数计费 |

新账号送 $20 免费 credits（约 2800 次搜索），Free Tier 每月再送 $10。详情见 [Exa Pricing](https://exa.ai/docs/reference/pricing) 与 [Exa Billing](https://exa.ai/docs/reference/billing)。

## Provider ID

| 能力 | ID | 工具 |
| --- | --- | --- |
| 搜索 | `exa` | `web_search_exa` |
| 抓取 | `exa-fetch` | `web_fetch_exa` |

## 开发

```bash
# 类型检查并构建到 lib/
./node_modules/.bin/tsc -p tsconfig.json
```

- 源码：`src/search.ts`（搜索）、`src/fetch.ts`（抓取）、`src/switch.ts`（限流降级开关）、`src/index.ts`（插件入口）
- 依赖：`@deepseek-ai/dsh-web`（`ctx.web` seam）、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`

## License

MIT
