# v16：领域上下文与保守范围拒绝

优先级仍是原节点、链接和格式保持，其次才是翻译质量。本轮有两项生产路径修复，以及一个默认关闭的研究策略；三者不能混同。

## 生产路径

`translationContextForUrl()` 只将 `docs.djangoproject.com/<语言>/<版本或 dev>/topics/db/` 及其子路径归为现有 SQL 上下文。SQL 术语表补充完整单词 `transaction(s) → 事务`，由原有请求构造器传给模型，用户术语仍优先。非数据库 Django 页面、相似域名、金融页面不获得这个上下文；不对已经生成的译文替词。

`decodeFixedMtText()` 在原槽以带点数字编号及 NBSP/narrow NBSP 开头时，要求模型仍输出相同编号，并还原**原分隔符**。编号改变、丢失或只剩编号时原子拒绝整段。普通空格、普通小数正文不走此规则。它不新增节点、不调整 DOM 层级、不重写译文词语。

## 实验策略 `source-constraints-v2`

沿用 [v15 合同](SOURCE_SCOPE_CONSTRAINTS_V15.md)，新增“相关源概念缺少独立见证时拒绝局部格式范围”。这不是正负词识别器，不猜中文否定，也不是翻译正确性证明。

对单个 ASCII 单词或连字符概念，归一化大小写、连字符，并只尝试移除一层 `de/dis/non/un/re/en/in/im` 前缀，剩余词干至少四字符。如果同一原父区域中另一个不同单词共享归一化形式，就存在范围歧义，例如 `binding/unbinding`、`freezing/unfreezing`。不跨独立原文 flow 搜索，也不对相同单词的重复出现作此判断；后者仍由 v15 重复范围规则处理。

完整拥有父区域的包装器、精确只读身份、唯一未变化的原格式字面见证可以继续使用。其他局部格式范围直接拒绝，连正确译文也可能无法显示。Python 对齐阶段提前拒绝；浏览器编译器从实际原节点重新推导条件，人工或助手的 `confirmed` 不能绕过。策略进入 source contract 和 proposal identity，v15 审查键不能用于 v16。

生产默认仍为 `alignment-v1`；`source-constraints-v1` 的行为保持。`source-constraints-v2` 仅能显式用于评测，计划标明 `evaluation_only=true`、`production_enabled=false`、`optimizer_inputs_approved=false`，冻结译文和写入权限不扩大。

## 复核证据

[2026-11-11 实测](results/2026-11-11-context-and-source-scope-v16.md)包括正式 v0.2.2 Q5 的 16 次 CPU 生成、真实 Firefox 的生产回放、85 个旧目标的来源筛查和 83 条实际 commit 回放。已知 v3 的 27 个非 X 选择用于回归诊断，不能当作新的盲测：v16 拒绝全部 14 个错误，同时拒绝 10 个正确，仅保留 3 个正确。因此仍需独立语义审查及新的未见来源验证，不能据此自动开启自然投影或再次同配方训练。

`source-context-comparison-v16` 是只运行捕获到的生产固定槽请求的原生评测协议，避免重复生成不参与本轮比较的自然输出。它要求诊断来源、完整任务集合、请求摘要及源码摘要；它不是新的生产推理后端。
