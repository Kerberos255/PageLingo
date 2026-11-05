# 自然翻译与生产固定槽对照（v8）

这是云端 CPU 的评价工具，不训练、选择、上传模型，也不启用新的扩展运行路径。

## 输入与边界

- [网页摘录](external/source-format-v8.json)保存从 Python / MDN 实际取得的 12 段英文 HTML、公开中文段落、来源 URL、抓取时间与整页/摘录 SHA。完整页面快照保存在云端证据包中。
- 中文仅为整句意思参考，**不按英文节点拆成正例槽位、不进入任何模型请求**。公开中文也可能不够精确；判断仍以英文为准，接受忠实的不同措辞。
- 另有 4 条已有训练源控制题，标为 `known_training_control`，与新网页分开统计，不作为新泛化成绩。
- 新网页与现有 v2–v6、release、种子、诊断、FLORES 的规范化原文和隐藏代码名后的固定输入检查重复。这里的“新”指未用于本项目这些对照，不代表模型预训练没见过公开文档。

每个模型产生 37 次输出：16 条 `natural-visible`、16 条生产 `production-fixed:0`，以及事前选定的 5 条 `context-fixed` 研究探针。

`natural-visible` 复用既有自然翻译提示，看到完整英文与实际代码字符串，无 grammar。生产固定槽复用现有根节点收集、序列化、语境、提示、grammar、长度预算和分句计划。两者的代码可见性及指令也不同，**差异不能全部归因于输出槽位**。5 个研究探针提供代码/节点角色及更完整的等义改写指令，保留同一固定帧 grammar 与预算；它们也同时改变多个因素，不能证明“只补代码”就解决问题。

自然生成预算等于对应固定调用预算之和，上限 768。实际 v8 选句均为单个生产调用。三个模型依次加载，2 个 CPU 线程、0 GPU layers、context 3072、temperature 0、top_k 1、seed 42，使用各自 GGUF 的 chat template，不把一个底座的 token 模板套给另一个。

## 复现

在项目根目录，先安装锁定的 Node 依赖；模型、llama-server 和所有输出放在项目外。私有模型访问沿用现有缓存/权限，不在命令行或日志输出凭证。

```bash
node tools/mt-source-diagnostic.mjs --out /absolute/evidence/plan-final.json
python tools/mt-sentence-native.py \
  --server /absolute/llama-server \
  --model /absolute/model.gguf \
  --sha256 MODEL_SHA256 \
  --plan /absolute/evidence/plan-final.json \
  --output /absolute/evidence/base_hymt_q5
node tools/mt-source-diagnostic.mjs --mode replay \
  --plan /absolute/evidence/plan-final.json \
  --run /absolute/evidence/base_hymt_q5/run.json \
  --out /absolute/evidence/base_hymt_q5/replay.json
```

依次为 `old_r16_q5`、`qwen3_4b_q5` 使用各自模型和新输出目录。权重 SHA、源文件 SHA、计划 SHA、每个实际请求、最终模板/token IDs 的 SHA 均核对/记录；已有运行目录不覆盖。需要使用实测版本的工具源码复现冻结请求，不能把后来变更的工具当成同一个冻结版本。

生成期间不传入参考译文。完成后，人工阅读英文、实际自然/生产/研究输出，填写 `audit.json` 的逐例判定和理由；不能由 DOM 通过或中文字面重合生成语义结论。`tools/mt-source-diagnostic-report.py --root /absolute/evidence` 检查三个完整运行、请求对应关系和审核集合后，产生 `summary.json` 与便于查看的 `comparison.html`。每个 case 的审核包括 `natural`、`production`，有研究输出的另含 `context`；`verdict` 为 `faithful`、`minor_issue`、`semantic_error`、`uncertain`、`not_displayed`、`incomplete` 之一，并有 `reason`、可选 `format_notes` / `scope_error`。`independent_human_review` 保持实际状态。

## 读取结果

- **意思**：动作、参与者、否定、条件、先后关系；轻微精度/歧义与明确错义分列。
- **代码字符串**：自然输出检查原 code 文本出现次数，另与语义结论分列；它是出现次数检查，不是代码定位/范围证明。固定输出由原节点恢复 code，不能因此证明整句意思正确。
- **结构**：实际录制输出经生产 decoder、PageTranslator 和 Node/DOM 回放，记录显示/保留原文、节点对象与子节点身份、属性、代码及精确恢复。链接/强调范围须再读对应文本。`context` 只借用生产 decoder/renderer，**没有声称研究提示就是生产请求**。
- **性能**：记录 server ready 窗口、首个非空流式片段延迟、server 解码 token/s、实际生成 wall 与 VmHWM。权重 SHA 扫描在 ready 计时前，文件缓存已暖；这不是冷盘加载或逐 token 可见延迟。不同模型 tokenizer 不同，token/s 不能直接等同于网页吞吐。

这是小规模定向诊断，助手语义审查未经独立人工盲审；不从这些计数推出普遍翻译准确率。原生 llama.cpp 的生成加 Node/DOM 回放也不是新的 Firefox/wllama 推理测试。发布和更换底座还需要单独通过语义、结构、量化、浏览器资源等实际验证。

## v8 补充复核

另用已缓存旧 r16 BF16 GGUF 对 2 条既有控制题做自然/固定对照，共 4 次生成；其请求、实际 prompt 和输入 token SHA 与 Q5 相同。该模型由既有原始底座与旧 r16 合并而来，Q5 转换记录以这个 BF16 文件为输入。没有改动权重。BF16 控制只覆盖这两条，不能代替新网页全集的 BF16 评测。

`tools/mt-reference-likelihood-probe.py` 复用既有内容/标记/EOS 计分，比较同一 nonce 源句的旧固定参考、Q5 实际错误输出与 BF16 实际正确输出。它在原始 HF BF16 底座和同一旧 r16 adapter 下无梯度、无 grammar、无截断地计分；不把新的正确输出自动变成训练正例。序列似然和局部贪心生成是不同测量。后续审核若修正另一条的判定，保留旧审核快照、输入 SHA 与别名，原始分数不重写。

`tools/mt-source-diagnostic-firefox.py` 可把三组主对照和上述 BF16 录制帧送入真实 Firefox DOM：每条先检查序列化源与原生记录一致，再经生产 decoder/renderer，并与 Node 回放的显示、文字、结构和恢复结果比较。本地页面会重新生成回放请求的 URL 语境，不冒充在原网页或 wllama 中重新生成了这些 token。
