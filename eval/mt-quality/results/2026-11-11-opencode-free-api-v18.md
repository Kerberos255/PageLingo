# OpenCode 免费模型：真实 API 与 Firefox 网页验证 v18

2026-11-11，基于 `0c8faca4bd8ac82096d34b78bbfe9fcb87905047`。机器可读结果见同名 JSON。

**结论：现有配置中的 OpenCode Go key 能调用 `longcat-2.5-free`。** 正式四段测试三段成功，一段超过 120 秒未取得结果；成功请求的 API 返回 `usage.cost=0`，`usage.opencode.list_cost=0`。这是模型调用的返回值，不代表 Go 订阅本身免费，也不保证将来的免费供应。当前更适合可选对照，尚不足以推荐为日常批量自动化的默认引擎。

## 服务和凭证边界

检查了主力机已有的 OpenClaw 配置 `E:\openclaw\.openclaw\openclaw.json` 中的 `opencode` 和 `opencode-go`。配置保存的是凭证引用，真实值只在 Windows 内存中解析和用于 HTTPS；未复制到云端、日志、项目或证据包。没有修改用户配置。请求使用真实标识 `PageLingo-API-Eval/0.1.30`，没有伪装 OpenCode 客户端、修改地区或回退到付费模型。

上游文档固定到 [anomalyco/opencode 6ec9395](https://github.com/anomalyco/opencode/tree/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7)：

- [Console models](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/services/site/src/docs/content/console/models.mdx) 明确说明普通免费聊天模型要求 OpenCode 客户端，第三方使用付费模型或 Go。
- [Go](https://github.com/anomalyco/opencode/blob/6ec9395bd4218af9fb11608d70fc2dfdcbe625b7/services/site/src/docs/content/console/go.mdx) 提供应用直接调用入口，列有 `longcat-2.5-free`、`beam-free` 等限时免费模型。LongCat 条目记为不用于训练、零保留；Beam 有地区限制。会使用输入改进模型的 Iceman Contributor 未测试。

Go 的 “Where can I use it?” 同时明确面向 OpenCode 和类似编码代理，并要求典型编码代理流量、客户端自身 UA 和稳定会话 ID。因此本次 HTTP 成功不能推导为官方承诺支持通用网页翻译；不应据此批量采用 Go 免费配额。日常网页翻译还需选择明确支持该用途的 API。

## 发现和修复

新 Go OpenAI 兼容地址为 `https://opencode.ai/inference/go/openai/v1`。原适配器仅识别旧 `/zen/go/v1`，漏发必需的会话头。实际返回 HTTP 400 `MissingSessionID`，补上 `x-opencode-session: pagelingo` 后成功。更新新建引擎和空地址回退的入口，并兼容旧地址及明确配置为 Go 的自定义代理。

LLM 生成等待上限从 30 秒改为 120 秒，并复用现有 Firefox event-page 保活。普通翻译 API 和模型列表查询仍是 30 秒。没有设置未获证实的推理开关，没有改变已保存地址、活动引擎或默认模型。

## 全部真实请求

云端公开文档 HTTP 访问先遇到 Cloudflare 403/1010；Windows 默认 Python UA 的公开模型列表查询也遇到相同拦截。随后带现有凭证、真实 PageLingo UA 的服务请求可以到达 API，不能将前者解释成 API 全面不可用。

修复前与修复后的烟测分别保留，不并入正式四段评分：

| 阶段 | 服务/模型 | 实际结果 | 请求耗时（秒） |
| --- | --- | --- | ---: |
| 修复前 | 旧 Go 地址 / LongCat | socket 超时，未取得译文 | 30.407066 |
| 修复前 | 新 Go 地址 / LongCat | 400 MissingSessionID | 0.659440 |
| 普通 Console/Zen | MiniMax M3.1 Flash Free | 429 FreeUsageLimitError，提示免费模型用于 OpenCode | 0.663087 |
| 补会话头后烟测 | 新 Go / LongCat | 200，模型调用 cost=0 | 30.171485 |
| 补会话头后烟测 | 新 Go / Beam Free | 403 RegionError | 0.667078 |

Console 429 和 Beam 403 均未重试。烟测 LongCat 的 SQLite 译文将 library 正确译成“库”，但省略了 PEP 249 后的“描述”，使一句不完整；保留该失败，不能用后来的较好结果抹掉。

正式批次固定四条来源，每条调用一次；输入是当前生产适配器实际构造的完整请求，不是手写的简化提示。以下是 Windows 请求端计时，包含远程推理、网络和完整响应读取；不是首 token 延迟，也不包含 MCP 工具等待。

| 来源段落 | 状态 | 耗时（秒） | completion / reasoning tokens | API cost |
| --- | --- | ---: | ---: | ---: |
| Python sqlite3 / `sqlite-v17-1` | 200，模板通过 | 108.150782 | 6685 / 6448 | 0 |
| MDN Shadow DOM / `shadow-dom-v17-1` | 200，模板通过 | 24.726183 | 1612 / 1538 | 0 |
| Rust 生命周期 / `rust-lifetimes-v17-2` | socket 超时，无译文 | 120.457351 | 未返回 | 未返回 |
| W3C Accordion / `w3c-accordion-v17-2` | 200，模板通过 | 12.332140 | 496 / 405 | 0 |

completion 含 reasoning，两列不能相加。主要 token 用于内部推理，与观察到的长延迟一致；未单独测量服务排队和推理时间，不能据此确定各自占比。证据省略服务返回的 reasoning 文本，保留最终 HTML、usage 和错误。

正式 SQLite 保留了作者、SQL/DB-API 2.0、PEP 249 和第三方库要求，补全了“该规范由 PEP 249 描述”。MDN 保留 Shadow DOM / shadow root 英文术语，语义未反转；这属于术语选择，不因未全译成中文判错。W3C 的“手风琴示例”是可接受的 UI 术语，三部分可展开的含义保持。三条成功结果的助手检查未发现明显反义；样本少且没有独立人工盲评，不能据此宣称优于 MT 或全面无误。Rust 没有结果，无法判断是否修复之前 MT 对 while 条件的弱化。

## 实际 Firefox 回填

Windows 只发送 HTTPS 请求；云端 Firefox 158.0.1 打开原始真实网页，在实际 1440px 和 500px 两个视口，使用当前生产解析器、固定模板校验和 PageTranslator 回放这批真实返回值。逐项核对源 HTML、请求体 SHA-256、语言和会话头，未重新生成或伪造翻译。TLS 正常验证，`acceptInsecureCerts=false`。

共八条记录：六条成功显示译文，全部通过原节点身份/顺序/属性、祖先结构、代码、href/onclick、非导航监听器、精确恢复及原 Text 节点检查，没有新增段落横向溢出；两条 Rust 超时保留原文。没有源变化记录。六张截图在译文仍显示时拍摄，随后才还原。500px SQLite 截图亦经目视检查，链接与代码仍在原位置。

这是实际远程 API 响应与实际 Firefox DOM 的分阶段验证；不是安装完整扩展后由浏览器跨网络等待 108 秒的端到端测试，也不是整站或像素级布局保证。此次没有重新验证真实 key 在扩展存储中的生命周期。

## 验证及产物

最终 `npm run verify` 退出码 0：43 文件 / 463 项 JS、类型检查、训练数据导出校验、构建通过，生产依赖审计零漏洞；addon lint 零错误、一条既有 innerHTML 警告。新增测试覆盖新旧 Go 地址、自定义 Go 代理、普通 Console 区分、31 秒响应、120 秒上限及微软 API 仍为 30 秒。

证据包 `pagelingo-opencode-free-v18-evidence-20261111.zip` 包含请求/脱敏响应、Firefox 结果和译文截图、最终源码绑定、上游文档摘要哈希及测试日志，附 stdlib SHA/CRC 和结果审计。完整原始模型思考、凭证和权重均未纳入。微软、Google 官方真实网络调用仍未完成；本次 OpenCode 结果不能代替它们。
