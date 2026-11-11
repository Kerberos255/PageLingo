# v17：翻译引擎共用原节点合同

PageLingo 的优先级是结构保持，其次是翻译质量。此前只有 PageLingo-MT 选择固定文字槽，其余运行时引擎主要通过译文容器回填。本轮让运行时各引擎都选择 `prefersWholeSentenceHtml=true`，使用整段原文字槽及原节点回填。实验性的自然译文范围投影仍关闭；这不是启用 v15/v16 范围模型。

## 接收什么

应用从原节点生成带 `data-flt-text-id` 的 HTML。后端接收完整段落，文字槽保留原 ID、父层级、次序及标签；应用只从这些槽提取文字。译文模式只修改原 Text.data，原链接、属性、样式、代码、处理器和节点树由应用持有。双语模式继续使用应用持有的原模板，既有测试覆盖其恢复行为。

`restoreFixedHtmlTransport()` 校验解析后的完整模板和属性，而非只比较标签数量。重复/丢失/错序槽、移动包装器、额外内容、未知属性、改变链接身份和非可选词的空槽均整段拒绝。拒绝后不拆成孤立链接或叶子继续猜范围，原文保持并计未完成。

兼容 HTML MT 的两项有界恢复均只发生在分离的传输文档中：

- 已知代码和链接边界标记若只变成空内容，仍在相同标签、属性、层级和位置时，恢复应用持有的原标记；不同标记或额外文字不接受。
- 原 `data-flt-fixed` 中单个句读标点的等价全角形式，以及文字槽边缘空白，恢复为源字面内容。不改译文词语，不将恢复权限扩展到其它节点。

完整段落还检查新引入或丢失的不配对圆括号、方括号、花括号及几种标记形括号；允许括号跨链接/强调槽。某种括号在原摘录已经不完整时，不替原文制造闭合括号。全角/半角按 NFKC 比较。

这能证明写入合同，不能证明词义、否定范围或条件关系正确。Bergamot 的软件库→图书馆、MT 的 while→而等问题仍需单独质量评测。

## 各服务的适配

默认 Bergamot、PageLingo-MT、AI API、微软和 Google 共用上述合同。外部适配器在传统 HTML/opaque 检查之前执行固定模板验证和有界恢复。LLM 默认提示说明整段上下文、文字槽与固定内容的归属；自定义提示不能绕过接收端校验。

微软自动检测时省略 `from`，Google 自动检测时省略 `source`，不发送不受支持的 `auto` 语言码；Google 地址同样走 HTTPS/loopback 校验。

## 后续真实 API 实测

`tools/provider-api-eval.mjs` 运行生产适配器，接收本轮 `capture.json` 的冻结来源，输出请求摘要、译文及模板检查结果，不记录 API Key。模板通过仍标成 `pending_live_browser_replay`，不能冒称已写回网页。环境通过继承代理时使用 Node 的 `--use-env-proxy`。

| 引擎参数 | 安全环境变量 |
| --- | --- |
| `--engine ai` | `PAGELINGO_AI_BASE_URL`、`PAGELINGO_AI_MODEL`、`PAGELINGO_AI_API_KEY` |
| `--engine microsoft` | `PAGELINGO_MS_API_KEY`；可选 `PAGELINGO_MS_REGION`、`PAGELINGO_MS_BASE_URL` |
| `--engine google` | `PAGELINGO_GOOGLE_API_KEY`；可选 `PAGELINGO_GOOGLE_BASE_URL` |

命令形状：`node --use-env-proxy tools/provider-api-eval.mjs --engine ai --cases <capture.json> --out <result.json>`。缺配置时记录 `blocked_missing_configuration`、零请求并返回退出码 2。本轮用户选择稍后配置凭证，三个官方服务没有真实联网成功结论。

详见[真实网页记录](results/2026-11-11-multi-engine-structure-v17.md)。
