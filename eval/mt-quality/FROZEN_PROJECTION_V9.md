# 结构优先的冻结译文投影原型

用户要求的优先级是：**翻译后的结构、链接与交互保持，其次是翻译质量**。本原型在 `eval/`，不被扩展默认路径导入。模型、对齐置信度或覆盖率都不能授权放宽以下保护。

## 不变的合同

- 原 DOM 节点对象、顺序、父子关系、块级结构和属性保持；链接 href/target/rel、class/style、原监听器不替换。
- code/kbd/samp/var 及显式不翻译内容逐字符保持；代码节点和链接不能为适应中文而换序。
- 链接/强调所对应的原义范围单独审核。机械树相同、标记齐全、置信度较高都不能证明范围正确。
- 第二阶段冻结中文字符序列，包括空白和标点。只计算位置与映射，不改写、添加或删除译文。
- 无原 Text 节点承接、范围交叉/不嵌套、重复/缺失 ID、UTF-16 边界切开代理对、歧义相邻文本节点、源内容/属性变化或根节点重挂载时拒绝。
- 写入前完成所有检查；只改已有 Text.data，复用生产 `prepareFixedTextRecord` / `applyFixedTextRecord` / `clearFixedTextRecord`。不接受模型 HTML、属性、URL 或样式。后续网站自己的文本编辑保留优先权。

原型登记普通标点 Text 节点，使中文标点可在同一个原节点内表达；没有添加承接节点。普通文字可在同一标记合同内重新分配，例如将“记录样本”放在原第一个普通槽、“校准传感器”放在最后一个槽，而强调节点依旧只承载“后”。格式范围、代码与块级边界仍受约束。

## 实验输入与实现

复用 v8 旧 r16 Q5 的 16 条已完成自然输出：12 条网页摘录回归、4 条旧训练控制题。校验原 v8 计划/运行/请求 SHA、EOS，以及可见源文本，冻结目标 SHA。**没有新的翻译生成、微调、训练集导出或模型发布。** 这些是已观察回归题，不是新的盲测。

流程：`captureFrozenSource → 原始译文冻结 → 词对齐/标记投影 → compileFrozenProjection → 原节点回填`。

只读代码先求唯一、原顺序的精确锚点；代码专属链接可使用同一个范围。唯一的原样完整词也可作为格式锚点。其他范围用上下文词向量的 mutual argmax 与 Inside-Outside 范围投影，限制父子嵌套、要求覆盖全部源内容词（冠词 a/an/the 除外），并拒绝非正分、歧义最短范围。余弦门槛 **0.55** 与覆盖规则在首次运行前固定，没有为提高这 16 条覆盖率调低。

参考 [Automatic Bilingual Markup Transfer](https://aclanthology.org/2021.findings-emnlp.299/) 的冻结文字/标记投影分工。实现是研究原型，不是该论文的官方复现。

下载并实际运行两个公开 cstr ONNX 导出：模型卡标为 **预训练 multilingual BERT 截取到第 8 层**。它们没有被冒称为已微调官方 AWESOME checkpoint。原 `aneuraz/awesome-align-with-co` 权重为 1,086,292,375 B，超过当时磁盘可用量；该正式已微调候选未运行。导出 metadata 的自报 size/compression 有不一致，身份与大小以下载字节数和 SHA 为准。

## 复现

需要源代码快照、原 v8 证据（或本轮机器记录内可还原的计划）、ONNX Runtime 1.23.2、fast tokenizer 和公开对齐模型。模型/运行输出应放项目外；不需要主力机 GPU。

```bash
node tools/mt-frozen-projection.mjs --input /absolute/v8-evidence --out /absolute/v9/final-plan.json
python tools/mt-frozen-align.py --plan /absolute/v9/final-plan.json \
  --model /absolute/alignment-model --sha256 MODEL_SHA256 --output /absolute/v9/int8-final-run.json
node tools/mt-frozen-projection.mjs --mode replay --plan /absolute/v9/final-plan.json \
  --run /absolute/v9/int8-final-run.json --out /absolute/v9/int8-final-replay.json
```

同样运行 FP32 对照。运行文件禁止覆盖；冻结计划含源文件 SHA，变更后应使用新的完整计划/结果，保留旧记录。对应的公开模型版本与 SHA 在 [v9 实测](results/2026-11-05-frozen-projection-v9.md)。

`tools/mt-frozen-projection-firefox.py` 把实际对齐分配送入 Firefox DOM；另做 8 个明确标记为人工夹具的表格、列表、标题、嵌套格式、链接换序、无承接节点与 HTML 字面文字检查。它不在 Firefox 中运行对齐模型。`tools/mt-frozen-projection-report.py` 在完整结果和独立的范围审核文件都存在时生成比较表。

## 结果应怎样解读

机械回填、范围语义、翻译原意分开：本轮每组 14/16 可回填，助手范围审核为 13 可确认、1 有争议、2 已拒绝；所有范围还未经独立人工盲审。对 `before → 后` 这样的等义语序转换，整句正确不自动等于强调焦点已获确认。

大部分例子只需代码精确锚点。本轮每组实际经过神经范围投影的只有 4 个角色，不能把 14 个回填都宣传成神经对齐解决了复杂网页格式。失败保留原文计为未完成翻译，不算质量成功。

源为旧 r16 的已有自然输出，投影阶段无法纠正其原有翻译瑕疵。没有单独译文展示层、移动原标签或重建原 DOM 的兜底；也没有把此原型接到实时网页所有权/动态观察流程。下一步需新网页、多链接/嵌套/动态变化的范围标注及真实 Firefox 对齐推理/合并内存验证，再讨论默认启用。
