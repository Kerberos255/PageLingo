# v17：参考成熟翻译架构，统一各引擎的原节点回填

**完成了参考项目调研、默认小型引擎的 Firefox WASM 实测、正式 PageLingo-MT 的新 CPU 推理及真实网页回填。** 本轮新增四个来源页、八段原文，在实际 1440px 和 500px 视口完成 32 条最终记录：22 条显示均通过原结构检查，6 条拒绝均原文未动，4 条源变化没有写入。AI、微软和 Google 官方服务按用户选择等待凭证，真实远程调用数为零。

[机器记录](2026-11-11-multi-engine-structure-v17.json)包含实际输出、逐例质量意见、来源及源码摘要、模式和宽度统计；[合同](../PROVIDER_STRUCTURE_CONTRACT_V17.md)说明实现和后续 API 复测方式。语义意见为助手审查，未经独立人工盲评，不给通用质量准确率。

## 参考项目中适用的做法

| 项目和固定版本 | 实际查看的内容 | PageLingo 的取舍 |
| --- | --- | --- |
| [wupage `04fe6ac`](https://github.com/mr-wuliu/wupage/blob/04fe6ac46bb4e2d44dff1bdf4de3f74e39094e07/src/content/inline-translation.ts) | InlineTranslationPlan 保存原节点、属性/文字快照、保护原子；protected-translation 处理占位符损坏及有界恢复，HTTP 错误不放大成碎片重试 | 采用应用持有原子、整段校验及原文回退的思路。其部分路径允许重排原元素；PageLingo 按自身优先级继续要求原树及次序不变 |
| [kiss-translator `ab5a5f4`](https://github.com/fishjar/kiss-translator/blob/ab5a5f47b8fd515ff8aa169e7375398ef1b5b8a9/src/providers/sdk/translation.js) | SDK 使用独立 ID、结构化分段及完整响应校验；translator 的 placeholderMap 在本地持有需要恢复的内容 | 将原文字槽 ID/完整性检查用于各运行时引擎；后端不能获得 DOM 写入权限，不引入其包装原文/重建 DOM 的方式 |
| [沉浸式翻译公开配置 `d647969`](https://github.com/immersive-translate/immersive-translate/blob/d647969ff49e41bece4a591a7347f399db737b3c/dist/firefox/default_config.content.json) | inline/block 分类、atomicBlockSelectors、excludeTags/Selectors、段落阈值和动态渲染配置 | 参考段落、原子和排除边界的职责划分。本次依据公开配置观察，不把它冒称完整内部源码分析，也没有批量搬运站点规则 |

调研文件保留在工作区研究目录；生产实现按 PageLingo 自身合同独立编写。wupage/KISS 仓库为 GPL-3.0，沉浸式翻译仓库未声明统一许可证，没有将它们的源码复制进本项目或证据包。

## 解决的实际问题

此前 MT 使用原文字节点，其他引擎主要走译文容器及链接恢复。现在运行时各引擎使用整段固定 HTML 文字槽，只将合法的槽文字写回原 Text 节点；原包装器、链接、属性、代码和事件处理器保持。

直接把 MT 规则套给 Bergamot 曾使第一版全部拒绝。真实输出显示它会清空 `__FLT_OPAQUE_*__` 和链接边界标记，并把固定句点转换为全角。修复采用应用持有的原子恢复：只在完整层级和属性一致、已知原子变空的条件下恢复原标记；不同标记/额外词语仍拒绝。单个固定句读标点和文字槽边缘空白也只恢复源字面内容。不会重写模型词语或修改原 DOM。

之后发现代码顺序必须先恢复，再验证链接边界；中间版及其失败保留。最终还加入跨槽的括号完整性检查，拒绝一条引入未闭合括号的小引擎输出。默认 LLM 提示说明整段上下文和槽归属，但接收端始终独立校验。

微软、Google 的自动检测参数也修正为省略来源语言，不发送 `from=auto` / `source=auto`；Google 地址增加与其他适配器一致的 HTTPS 校验。外部 HTML 适配器和实际回填共用模板保护，避免接入服务后回到只验证标签名的旧路径。

## 新的真实网页和实际模型调用

生成前按原文选取每页前两个可见、60–320 字符、有链接/代码/强调且最多八个文字槽的段落：

- [Python sqlite3](https://docs.python.org/3/library/sqlite3.html)：软件库/PEP 链接、可选模块说明。
- [MDN Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)：内联强调、lang/dir 代码、继承关系。
- [Rust 生命周期](https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html)：borrow checker 强调、重复变量代码和条件关系。
- [W3C Accordion](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/)：No ARIA 提醒及示例链接。

默认引擎是实际 Firefox 158.0.1 中的 Bergamot WASM Worker，使用 Mozilla `en→zh-Hans` 3.0 模型，四个解压资产共 51,934,991 B，每项长度和 SHA 在初始化前核验。初次比较实际执行 40 个 WASM translate 请求，包含旧拆分路径及固定模板路径。最终保护逻辑复用同一批原始整段输出，重新核对完整请求后回填，没有为提高成绩重新生成。

正式 `PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf` 新完成八次 CPU 生成，8/8 EOS，模型 SHA `8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc`。使用 llama.cpp b11785、两线程、0 GPU layers；在 Firefox 的实际 PageTranslator/inferMtHtml 回放时逐次核对消息、grammar 和预算。没有新训练、转换或权重切换。

模型后端和真实网页回填两部分均实际执行；这不等于本轮重新覆盖了完整扩展安装、模型下载和持久缓存生命周期。Bergamot 的传输下载/解压在内存中完成，避免云盘不足导致缓存失败。TLS 校验开启、`acceptInsecureCerts=false`。

## 最终回填与格式验证

| 引擎 | 实际视口 | 记录 | 显示并通过结构检查 | 拒绝且原文未动 | 源内容变化 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bergamot | 1440px | 8 | 4 | 3 | 1 |
| Bergamot | 500px | 8 | 4 | 3 | 1 |
| PageLingo-MT | 1440px | 8 | 7 | 0 | 1 |
| PageLingo-MT | 500px | 8 | 7 | 0 | 1 |
| 合计 | | 32 | 22 | 6 | 4 |

最初请求窄窗口为 390px，Firefox 实际限制成 500px，使用测得的 innerWidth 统计，未声称测试了 390px。每次都检查实际原节点/层级/属性、祖先、代码、href/onclick 身份、非导航自定义监听器、精确还原和原 Text 节点；22 条显示全部通过，受测段落未新增横向溢出。不同语言可改变行高，这里不要求像素布局完全相同，也没有覆盖所有页面和所有屏宽。

小引擎三条确定性拒绝分别是 SQLite 引入未闭合括号、Shadow 强调槽为空、borrow checker 强调槽为空；后两者的词被移到其他文字槽，不能只因总文本有译文就判格式通过。W3C 第一段在最终网页来源检查中变化，两种引擎、两个宽度均不写入，未混用中间版的成功记录。离线完整模板检查另外确认该段 MT 原始输出引入 `）、`，也应拒绝；此离线诊断未计作真实网页结构通过。

## 翻译质量仍有问题

以下来自实际输出，不用理想参考词强迫逐字一致：

| 样本 | 小型本地引擎 | PageLingo-MT |
| --- | --- | --- |
| SQLite library | “SQLite 图书馆”，软件领域用词错误 | “SQLite 库”，含义正确 |
| borrow checker | 格式槽空，保护逻辑拒绝 | “借用检查器”，原强调范围保留；Listing→列表属于措辞问题 |
| while x is valid | 比较/条件关系不完整，lifetime 用“一生”也生硬 | “而 x 则有效”弱化“在 x 有效期间”的条件，应作为意义问题继续处理 |
| Accordion Example | “手阁说明”，明显误译 | “折叠面板示例”，与原文对应 |

小引擎的原始 No ARIA 输出“没有一个ARIA比坏ARIA更好”有反向量词读法风险；该段没有在最终批次显示。MT 的该段有异常前缀标点。结构通过不代表这些语义问题已经解决，也不把留原文计为翻译成功。有限的定向来源和本轮迭代参与规则设计，不能作为新的盲测准确率。

## AI、微软、Google 的当前结论

用户选择先测现有引擎、稍后配置 API 凭证。三个真实官方服务调用数均为 **0**，运行器明确记录 `blocked_missing_configuration`。因此当前只能确认请求构造、自动检测参数、响应解析、固定内容恢复、损坏拒绝和 PageTranslator 整段回填的协议集成测试通过；这些使用模拟服务响应，不能称作远程翻译质量或联网成功。

已提供生产适配器复测运行器 `tools/provider-api-eval.mjs`，安全环境变量和命令见合同。配置到位后可在同一批冻结来源上实测，并继续做真实网页回放；单纯模板通过仍不计真实网页通过。

运行器另通过三个本地 HTTP 协议 fixture 实际执行，分别验证 AI、微软和 Google 的请求/响应形状、原子恢复和凭证不落盘。fixture 返回原文并清空已知标记，不运行模型、不是官方服务，也不计翻译成功；机器记录独立列出这一自检。

## 验证和证据

完整 `npm run verify` 实际退出码 0：43 个文件、455 项 JS 通过，类型检查、数据导出、生产依赖审计零漏洞、构建及 addon lint 通过（零错误、一条既有警告）。新增测试覆盖三个实际适配器的完整回填合同、标记丢失恢复、属性/槽/层级错乱拒绝、跨槽括号、来源不完整摘录、自动语言参数和 Google 地址验证。

生成时 55 项源码另行保存；之后三处渲染/适配校验演进与最终源码分开记录。实际回放再次核对冻结请求，未篡改模型输出。第一版 SQLite 选择器遗漏、原子恢复前全部拒绝、中间顺序错误和窗口宽度限制都有原记录。

证据包 `pagelingo-multi-engine-v17-evidence-20261111.zip`：**1,065,255 B、189 个成员**，SHA-256 **`e1d238b0d4d7d73623b8c35917c9ef7ec727b44b18b0d011178f2ddde484a56c`**。内附纯 stdlib 审计，实际验证全部成员 SHA/CRC、八条新生成/EOS、32 条最终记录、22 条结构通过、六条原文回退及四条来源变化。无权重、真实凭证或上游源码副本。
