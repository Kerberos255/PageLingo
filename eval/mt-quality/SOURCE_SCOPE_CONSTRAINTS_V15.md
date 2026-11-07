# 由原始结构约束译文范围

研究路径，默认关闭。`scopePolicy: "source-constraints-v1"` 在既有 owned source、冻结译文和原 Text 节点回填合同之上增加范围约束。翻译模型不产生 HTML，也不能自行授权范围。原固定槽提供器及默认 `alignment-v1` 不采用这些新增规则。

## 约束

- **完整父范围。** 原格式/区域与父区域的序列化输入起止位置完全相同，就继承整个父译文范围；根父区域是完整冻结译文。嵌套的完整包裹可递归继承，不要求编码器为每个功能词提供链接。部分短语、源词切片及父范围尚未确定时不能套用。
- **原只读锚点。** 原代码、只读字面内容和既有标点锚点给出相邻范围的必要上下界，候选不能跨过它们。相同代码出现多次仍要求唯一的有序分配。
- **唯一未变化的格式字。** 仅对原格式节点内的 ASCII 标识形式文字，且在原文与冻结译文中都恰好出现一次，记录其目标位置。原格式范围必须包含该文字；允许整个中文释义包在其周围。这个位置也能约束不相交的原兄弟范围。例如 jQuery 链接在 HTML 链接之前，唯一 HTML 的位置可排除后一次 jQuery。没有原格式节点的上下文词、重复原词或模型猜测的其他范围不能提供此见证。
- **词边界与重复。** 拒绝切入源/目标 `Intl.Segmenter` 词内部的格式范围。在上述锚点限定区内，同一候选短语若有多次完整出现，拒绝凭模型选择或通用审查标记决定其出现位置。代码等完整只读包装器及完整父范围分别使用其结构见证。

完整输入相同不等于原始 `textContent` 相同：程序沿生产 serializer 的 owned trace 计算，继续排除独立子流、隐藏内容和受保护 API 声明。已被 serializer 裁掉的边缘空白不成为模型文字载体。v14 的 CSS/空白/标点/同父节点间隙权限没有扩大。

## 实现与写入

`scope-constraints.ts` 从原 source annotations 与冻结目标生成约束。计划中的约束由程序生成并绑定源码 SHA；Python 投影器使用完整父范围和必要上下界。浏览器编译器从重新捕获的源重新推导约束，不信任传来的约束 JSON，并在实际写入前继续验证 source contract、完整译文见证、原节点/属性/只读文本及所有权。

`scope_policy` 进入新策略的 proposal 身份。旧策略的合同序列化保持原形状，旧审查不能直接授权新策略。研究写入仍要求对精确 source/candidate/spans 的审查；确认标记不能绕过编译器约束。未完成及拒绝保留原文。

这些条件**不能证明翻译正确或完整概念对应**。例如中文分词可以把“解除”和“绑定”分成两个完整词，仍无法判断英文 binding 对应的是“绑定”还是“解除绑定”。重复范围的拒绝也会损失一些正确译文。不能用程序检查通过、闭集格式或一致性代替双语意义审查。

## 复现入口

在 `tools/mt-owned-projection-firefox.py --mode capture` 使用：

```text
--punctuation-policy prose-v1
--whitespace-policy collapse-v1
--allocation-policy prose-gaps-v1
--scope-policy source-constraints-v1
```

随后复用 `tools/mt-owned-projection.mjs --mode plan`、`tools/mt-frozen-align.py`、`--mode input`，再在 Firefox 进行 preview 和精确 proposal 审查后的 commit。新计划协议为 `source-constrained-projection-v15`。对照使用相同自然译文及 `--scope-policy alignment-v1`，不能把它称作线上固定槽对照。

检查与边界见 `tests/source-scope-constraints.test.ts`、`training/mt-fixed-slots/tests/test_owned_projection.py`；[实际网页结果](results/2026-11-07-source-constrained-projection-v15.md)分别报告旧组、定向补测、拒绝代价及未解决的错误。
