# v10：复杂真实网页，结构优先实测

2026-11-05。结论：**先优化 PageLingo 的保护和格式语义映射，再决定有界微调。** 原节点不变已经能稳定验证，但链接/强调仍会套错文字。新增投影路径继续默认关闭。已完成一个范围明确的生产修复：保护 Sphinx API 签名，避免函数名、参数和值被中文化。

[完整逐项记录](2026-11-05-complex-live-web-v10.json)保存源 HTML、实际自然输出、实际生产回填、投影结果、范围审核及 SHA。[测试合同](../COMPLEX_LIVE_WEB_V10.md)说明抽样、复现和限制。审核者是助手，**没有独立人工盲审**；这些判断不进入优化器。

## 测了哪些真实页面

Firefox 158.0.1 实际打开 12 个公开网站页面，清点 **6,484 个生产候选根**，按源结构选取 **40 个复杂片段**。其中两条在生产格式规划阶段超预算，保留原文；其余 38 条分别运行正式 v0.2.2 Q5 与旧 r16 Q5，每组 76 次生成，共 **152/152 EOS**。

| 来源 | 本轮实际页面 | 选取片段 |
| --- | --- | ---: |
| Wikipedia | [Transport Layer Security](https://en.wikipedia.org/wiki/Transport_Layer_Security) | 4 |
| Rust Book | [References and Borrowing](https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html) | 3 |
| TypeScript | [Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) | 3 |
| React | [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects) | 3 |
| Kubernetes | [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) | 4 |
| GitHub Docs | [About Git rebase](https://docs.github.com/en/get-started/using-git/about-git-rebase) | 3 |
| MDN | [ARIA table role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/table_role) | 3 |
| Python | [asyncio Tasks](https://docs.python.org/3/library/asyncio-task.html) | 4 |
| W3C | [Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | 3 |
| RFC Editor | [HTTP Semantics / RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | 4 |
| GitHub 仓库 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | 3 |
| Stack Overflow | [Check if an element is hidden](https://stackoverflow.com/questions/178325/how-do-i-check-if-an-element-is-hidden-in-jquery) | 3 |

样本覆盖密集链接、上标引文、嵌套强调、代码、表格单元格、列表、定义项、API 签名和页面动态插入。抽样在推理前固定，没有按模型表现换题。最初源清点发现缺少表格分层，且 RFC 的 `#content` 只是第 6.4 节，随后在任何模型推理前补足表格、扩大 RFC 范围，并保留首轮记录。

这是新的选定回归样本，未与 v8 源文重复；不代表随机网站准确率，也不能证明没有进入模型预训练。**6,484 是清点数，实际推理是 38 条/模型。**

## 原结构检查和语义范围分别记分

使用浏览器捕获的生产序列化、提示、语法和预算运行原生 CPU 模型；随后重开原网站，核对 URL、完整源 outerHTML 和生产请求，在原节点上回填真实输出并恢复。自由译文逐字符冻结，新路径只计算范围，不改写中文。

修复前基线有 **152 条真实页面回放**：150 条来源匹配；全部 150 条的原节点/层级/属性、祖先结构、code 内容、链接属性与 onclick 身份、非导航监听器探针和精确恢复检查通过。局部尺寸检查未发现新增横向溢出。

另外 2 条是旧 r16 的 Wikipedia 引文记录。页面后来新增 `<span class="cite-accessibility-label">Jump up to: </span>`，来源保护因此停止写入；它们记为未测，不计结构通过，也不计模型质量失败。

| 修复前基线，每模型 38 条 | 正式 v0.2.2 | 旧 r16 |
| --- | ---: | ---: |
| 生产固定槽显示 | 38 | 34 |
| 生产校验拒绝，原文保留 | 0 | 3 |
| 生产来源变化，未写入 | 0 | 1 |
| 生产范围：助手确认 | 26 | 30 |
| 生产范围：明确错误 | 9 | 3 |
| 生产范围：存疑，不计通过 | 3 | 1 |
| 冻结投影显示 | 9 | 14 |
| 投影范围：助手确认 | 8 | 13 |
| 投影范围：明确错误 | 1 | 1 |
| 投影拒绝，原文保留 | 29 | 23 |
| 投影来源变化，未写入 | 0 | 1 |

范围计数包括确定代码锚点和没有可变格式的样本，不能当成复杂神经对齐准确率。真正经神经范围投影且最后显示的角色，仅分别为 **5 和 6 个**。新投影用同一 v9 INT8 8 层预训练 mBERT 导出，余弦 0.55、内容词完全覆盖、原顺序和嵌套规则未放宽；它不是已微调官方 AWESOME checkpoint。

## 具体发现

1. **链接地址不变，文字仍会串位。** Wikipedia 的 `improve this section` 与 `adding citations to reliable sources` 在两模型生产结果中互换中文含义。React 的 `closures` 链接在两组都只包含“的内容”，而“闭包”落在普通槽。正式模型的 `UT-Austin` 链接只剩“的工作”。这些都不算结构语义通过。
2. **新投影也会套错完整概念。** Rust 的 `dereferencing` 被两组对齐到“引用”，把“去引用”的“去”留在 EM 外。旧 r16 整句本来正确，冻结文字也完全没变，但强调没有覆盖完整术语。此处是范围错误，不据此把正确整句判成反义。词对齐置信度、词覆盖率和相同 DOM 树都不能证明范围正确。
3. **固定槽仍会错配代码的语义角色。** Rust 原文说“调用 calculate_length 后仍能使用 String”，两组生产输出都变成“调用 String 后使用 calculate_length”。原 code 节点和字符原样保留，动作参与者却对调；同段自然译文均保留了正确角色。
4. **代码性质不限于 code 标签。** Python 的 Sphinx 签名使用 dt/span/em。正式模型生产结果把 `asyncio.create_task` 改为“asyncio。创建任务”，把 `name=None` 改为“名称=无”。旧 r16 正确保留英文签名，却被目标语言检查拒绝。需要在模型调用和语言检查之前识别并保护整块声明。
5. **译文原意还有独立问题。** 两模型的自然和生产输出都把 FIRST_EXCEPTION 的“Future 因异常完成”误成“等待函数抛异常返回”。两组自然译文都把 USENIX 会议归到错误组织。正式模型还出现混入韩文、严重漏译；旧 r16 有一条仅输出受保护代码 JSON。自然翻译和固定任务各有成败，不能把所有问题归到一个环节。
6. **复杂源需要清晰的文字所有权。** 嵌套列表、零文字 LINK 元数据、BR 和隐藏段落锚点使当前冻结原型拒绝。10/38 源合同不支持，每组只对 28 条运行编码器。强行 flatten 完整 root.textContent 会混入子根或隐藏内容；父 LI 只拥有引导句时，子列表保留英文不算本次请求漏译。

既有质量函数对原始可见文字的只读探针能检出正式模型严重短译、旧 r16 的 JSON 回显，但不会证明语义正确；它还会将正确英文 API 签名判成语言不符，进一步说明代码区域应在上游保护。探针没有修改当前生产质量规则。

## 已完成的生产修复

在 `dom-policy` 与 PageTranslator 入口保护整个 **dt.sig / dt.sig-object**：不调用翻译提供器，不给内部链接添加旧模式包装，不改函数名、参数、标点或原节点。直接调用、内部节点与动态插入也受保护；普通定义项和相邻说明继续可翻译。

真实 Python 页面上两条签名 × 两种模式的 **4 条检查全过**：原文逐字符不变、节点/属性/链接保持、选中根数与提供器调用均为 0，相邻说明仍有可译根。另重放了修复后的 **144 条非签名记录**，142 条来源匹配且上述结构检查全过，另外 2 条仍被 Wikipedia 动态节点保护挡住。

这些修复后记录与原基线单独保存。该修复解决签名中文化，**没有宣称其余链接/强调范围错误已解决**；新增投影保持默认关闭，模型权重和默认模型不切换。

## CPU 实测

Debian 13，AMD EPYC 9V74，3 个可见逻辑 CPU、实际 cgroup 配额 2 CPU，内存上限 8,589,934,592 B。原生 llama.cpp 使用 `-t 2 -tb 2 -c 3072 -ngl 0`，两个模型顺序运行。环境记录时磁盘可用 185,810,944 B，OOM / OOM kill 均为 0。

| 指标 | 正式 v0.2.2 Q5 | 旧 r16 Q5 |
| --- | ---: | ---: |
| GGUF 实际字节数 | 1,298,755,616 | 1,298,755,552 |
| 暖文件缓存 ready 窗口（s） | 0.830926 | 0.773333 |
| 自然请求首 token 中位数（s） | 1.271118 | 1.289867 |
| 生产固定槽首 token 中位数（s） | 3.136739 | 2.952727 |
| 自然解码中位数（token/s） | 13.370955 | 13.696149 |
| 生产固定槽解码中位数（token/s） | 12.549572 | 13.047050 |
| 76 次生成总阶段 wall（s，含校验/服务） | 844.484033 | 823.116152 |
| 原生进程 VmHWM（KiB） | 2,539,412 | 2,546,956 |
| INT8 句对编码中位数（s） | 0.066195 | 0.052426 |
| 对齐进程 VmHWM（KiB） | 621,008 | 621,084 |

模型 SHA、请求/token 身份、逐条延迟和完整结果在机器记录中。ready 前 SHA 扫描使文件缓存已暖，服务使用 no-warmup；该值不是冷加载或第一条推理就绪耗时。对齐在原生生成结束后执行，ONNX Runtime CPU、2 线程。

本轮浏览器运行的是**真实网站上的原节点回填**，模型推理在原生 CPU 进行；没有在 Firefox/WASM 中加载模型，也没有测翻译+对齐模型同时驻留的浏览器内存。测试使用原 CSS/脚本，关闭图片下载与磁盘缓存，不代表完整图片/视频加载后的视觉或扩展引擎生命周期验证。没有点击外部链接；非导航探针与 onclick 身份检查不等同于实际目标页导航。

## 下一步顺序

1. 保留已实现的签名保护，继续用真实来源识别有代码性质的区域，避免将正确英文标识符送进语言质量检查。
2. 让冻结投影使用生产实际拥有的 Text 槽，并将隐藏锚点、元数据、BR、子列表/表格等作为不可改边界；增加源版本失效与重试测试，防止覆盖网站自己的更新。
3. 冻结前验证候选完整性、受保护内容与明显输出垃圾；范围阶段测试短语/多对多对齐和完整概念边界。保留“去引用只覆盖引用”这一明确失败，不能通过调低门槛或改写冻结中文消除失败。
4. 补独立标注、新网页保留集，再评估已微调对齐模型。当前每组 7 条失败涉及缺少完整词对齐，包含 to/of 等功能词；这不直接证明译文漏义，也不能据此把所有缺失都忽略。
5. 为自然阶段增加原生推荐/简洁提示对照，再判断数据与训练需求。结构与范围证据稳定后，才为 FIRST_EXCEPTION、代码角色和完整性等可核实问题准备**有界 MT 微调**。本轮新回归和审核不进入训练，既有 17 对候选仍未获优化器批准，没有新 GPU 任务或整轮重训。

## 校验与证据

`npm run verify` 通过 **306 项 JS**、类型检查、现有数据导出、生产依赖零漏洞、构建与 addon lint（零 errors、一条既有警告）；匹配 ML 运行时的 **81 项 Python 全过**。新增 9 条签名保护测试覆盖两种提供器模式、直接请求、旧包装、动态插入与相邻说明，另有 10 条复杂网页回放保护测试。

首次浏览器回放有工具错误：把 JSON 对象字段顺序当成请求差异，所有页面在写入前停止。现已按对象键规范化比较，保持数组顺序、消息内容、语法与预算；失败日志保留。冻结源加此比较修正后，已逐字节重建成功基线 runtime，SHA `cd5d98ccf88cac738218ca8c5ff64e6619fccaeb1522502369df3ab7ab2e4060`；无需重新生成或挑选模型输出。

原始证据包 `pagelingo-complex-live-web-v10-evidence-20261105.zip`：**8,985,843 B、515 成员**，SHA `45a1c140c7181714c818b46bc455f9c5b16179e92a8e5e678ba4ca81fea84fe9`。CRC 和所有成员 SHA 验证通过，含页面快照、完整模型/对齐/浏览器结果、失败日志、审核与新旧源码，不含模型权重。当前源码新增保护后，重新采集的 Python 样本会变化，按冻结计划和 SHA 复现旧基线。
