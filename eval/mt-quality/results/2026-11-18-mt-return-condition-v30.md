# MT 固定代码顺序下的返回值和条件

PageLingo-MT 在符合条件的英文技术段落中，先向模型明确返回值，再引出条件。正式 v0.2.2 Q5_K_M 的四个新样本原本都把返回值放进了条件。调整后四段的返回值和条件关系都正确。两段在 Firefox 中复测也修复了同样的错误。

## 接入范围

规则只处理生产固定槽路径中的单句 `Return(s) <code>…</code> if …`，要求两个代码节点且返回值两侧是普通正文槽。它改写送给模型的英文连接词，复用原槽顺序、语法约束、输出预算、解码和写回，每段调用模型一次。第二个代码节点可以在链接内。另有条件、例外、分句、显式换行或超出上下文预算时使用原提示。历史评测调用默认使用原提示，生产 MT 客户端启用该规则。

先采集 14 份公开文档，再按源文和固定槽形状冻结四段符合规则的正文、四段回退对照。八段均排除了 v29 保留源文和先导实验的重复项。Javadoc 的 `.block` 摘要因首段未进入现有翻译根选择，在生成前排除。最终代码的 16 次请求捕获分别与冻结的基线和候选逐字节一致。四段回退的模型请求完全相同，各运行一次。[Rust Ordering](https://doc.rust-lang.org/std/cmp/enum.Ordering.html) · [Python asyncio queues](https://docs.python.org/3/library/asyncio-queue.html) · [Kotlin isNullOrBlank](https://kotlinlang.org/api/core/kotlin-stdlib/kotlin.text/is-null-or-blank.html) · [Rust bool](https://doc.rust-lang.org/std/primitive.bool.html) · [Python decimal](https://docs.python.org/3/library/decimal.html) · [Rust Weak](https://doc.rust-lang.org/std/sync/struct.Weak.html)

## 翻译和页面结构

| 独立网页段落 | 原提示 | 调整后手工复核 |
| --- | --- | --- |
| Rust Ordering `is_eq` | 排序为 `true` 时返回 `Equal` | 排序为 `Equal` 时返回 `true` |
| Rust Ordering `is_ne` | 排序不为 `true` 时返回 `Equal` | 排序不为 `Equal` 时返回 `true`，否定关系保留 |
| Python Queue `full` | 队列有 `True` 项时返回 `maxsize` | 队列有 `maxsize` 项时返回 `True` |
| Kotlin `isNullOrBlank` | 把 `true` 当成条件，省略返回值 | 返回 `true`，条件保留 `null`、空、仅空白三种情况 |

12 次原生生成均正常结束，固定槽解码和写回全部通过。检查逐段的返回值和条件关系。Rust 候选仍有“在此条件下，返回值 true 是”和把 `variant` 写成“版本”或“类型”等措辞问题。原提示的 Rust `bool` 和 `Weak` 回退对照仍有角色错误。该结果衡量四个新段落的指定语义关系，样本范围限于这些句式。

Firefox/wllama 完成 Rust `is_ne` 和 Kotlin 各一对推理。实际输出回放到两站原段落，按 1440 和 500 CSS 像素各测试两种提示，共八项。原节点及祖先、代码内容、链接地址、事件和精确还原全部通过，段落稳定后横向溢出为零。Kotlin 网站脚本加入了语法高亮标签，首轮按静态 HTML 定位的测试停住。复核高亮后的实际请求一致，在提交翻译时重新定位同一段落后补齐了两项窄屏结果。

Kotlin 宽屏的最初截图中，站点 Cookie 对话框遮挡了两种译文。用临时 Firefox 配置通过站点设置只保留必要选项，再对相同输出回放和拍摄。确认原文与译文均可见，复拍保留了代码高亮。抽查的 Rust 和 Kotlin 两种宽度译文可读，窄屏正常换行。

## CPU 实测

在 Linux 6.18.57 x86_64 云环境运行。AMD EPYC 9V74 暴露 3 个逻辑 CPU，CPU 配额为 2 核，内存上限 8 GiB，收尾时工作盘可用 781 MiB。使用已缓存的 1,298,755,616 字节 `PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf`。模型 SHA-256 为 `8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc`。

llama.cpp b11785 两线程到 ready 用时 1.409 秒，进程 VmHWM 为 1,603,832 KiB。匹配的四段首个非空输出中位数为 1.799 → 1.670 秒，单段总耗时中位数为 4.948 → 5.139 秒。12 次原生生成解码速度为 13.45–17.16 token/s。

Firefox 158.0.1 + wllama 3.6.1 通过本地 File 输入调用生产模型加载器，两线程加载用时 8.246 秒。下表为每段一次实测，时间从发起生成请求起算。此前 Firefox 进程树的内存复测峰值 PSS 为 2.50 GiB。[v29 内存复测](2026-11-18-mt-paraphrase-v29.md)

| Firefox 片段 | 首个非空输出（秒） | 生成总耗时（秒） | 解码（token/s） |
| --- | ---: | ---: | ---: |
| Rust `is_ne` | 57.33 → 54.65 | 81.72 → 75.21 | 2.13 → 2.63 |
| Kotlin `isNullOrBlank` | 51.56 → 60.34 | 75.28 → 85.03 | 2.70 → 2.72 |

日常带权重的质量回归可用原生 CPU。实际 Firefox 的首输出耗时在本轮为 51.56–60.34 秒，适合在运行时或模型有变更时抽样。此轮接入以结构安全和指定语义关系为准，采用正式模型权重。

## 回归验证

`npm run verify` 退出 0。54 个文件、617 项测试通过，包含 12 项新增规则回归。类型、数据导出、构建和附加组件检查通过，生产审计零漏洞。附加组件检查报告一条既有动态 `innerHTML` 警告。v29 数据与计划导出 SHA-256 逐项匹配已执行训练所用版本。
