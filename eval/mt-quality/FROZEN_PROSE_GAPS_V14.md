# 原节点上的冻结译文分配

实验默认关闭。自然翻译请求和已冻结译文不变；应用拥有原 DOM，只把完整译文分配回原 Text 节点，不接收模型 HTML。`allocationPolicy: "prose-gaps-v1"` 必须同时显式启用 `punctuationPolicy: "prose-v1"` 和 `whitespacePolicy: "collapse-v1"`，原固定槽提供器保持严格默认合同。

## 两级可写合同

v13 `collapse-v1` 只处理 CSS normal/nowrap 下的 ASCII 可折叠空白。原空白节点可以保留为空，但不能独自承载词语。NBSP、pre/pre-line/pre-wrap/break-spaces、显式不翻译、代码和不属于生产追踪的文本继续只读；捕获与应用之间的 CSS 变化使写入失效。

v14 为符合相同上下文条件的原普通文字节点和其间的有限标点/空白增加 `frozen-prose-gap` 程序写权限。同一父节点内，原有普通文字可以承载冻结中文的完整间隙，其他原节点保留为空；因此无需新建节点，也不必把英文冒号之后的位置限制为一个冒号。例如 `Logger: debug()` 可以在原冒号 Text 节点中承载“的以下方法：”，两个代码对象仍完全只读。

这明确增加了程序写权限，不能描述为仅写原生产模型槽。代码、数字、NBSP、不翻译文本及独立子流继续保护。不能跨父节点、BR、隐藏/省略边界搬运词语；不能删除两个受保护原子间的分隔导致拼接。只有空白而无原可译文本的包装器不能据此变为翻译载体。

## 完整性见证

普通 `prepareFixedTextRecord` 不能凭 JSON 中一个 `frozen-prose-gap` 标记获得权限。实验编译器调用独立 `prepareFrozenProseRecord`，由私有 WeakSet/WeakMap 记录程序授权与完整冻结目标见证。HTML 解析后的实际编辑映射必须重组出逐字相同的冻结译文；应用前再次验证。这也拒绝 CR 被 HTML 解析器规范化等传输变化。

原节点对象、父子和兄弟顺序、属性、只读文本、代码和链接目标均须保持。整个段落先校验，再写 Text.data。网站后续编辑不被还原覆盖；源对象或样式变化拒绝待写入计划。

范围对齐不是语义证明。完整多词格式句的终结标点必须留在原格式包装器中；只允许补入紧邻的同类标点，排除 e.g. 等缩写，不跨词查找。标签冒号规则继续适用。完整范围与整句意义分别审查，已知实质误译不能因结构编译成功而准入。

## 复现

现有 `tools/mt-owned-projection-firefox.py` 的 capture 增加 `--punctuation-policy prose-v1 --whitespace-policy collapse-v1 --allocation-policy prose-gaps-v1`。`tools/mt-owned-projection.mjs --mode plan` 生成 `frozen-prose-gaps-v14` 合同，固定源代码、原始请求/译文和采集结果；`tools/mt-frozen-align.py` 用固定编码器投影，再生成 preview 输入。只有绑定精确 proposal_key 的研究审查才可执行 commit。

必须分别记录候选拒绝、对齐覆盖不足、结构编译失败、范围错误、整句误译及页面来源变化。缺失定位器不能算结构检查通过。实验真实网页回放不等于本轮在扩展里使用 wllama/WebGPU 推理，也不证明全部页面监听器或像素布局不变。

针对性测试见 `tests/collapsible-whitespace.test.ts`、`tests/frozen-prose-gaps.test.ts`；真实测量见 [2026-11-06 结果](results/2026-11-06-frozen-prose-gaps-v14.md)。
