# 固定槽位翻译对照评测

随后完成 [v4 配对任务与训练包准备](results/2026-10-29-semantic-v4-preparation.md)：54 次真实 CPU 诊断仍未支持启用新提示；因此准备自然句义、原节点改写和槽位输出的有界训练对照。两组从底座新建 LoRA、各 32 步，只比较标记权重，GPU 成绩尚待运行，不计入已完成实测。

2026-10-29 补充完成[句级翻译与对齐对照](results/2026-10-29-sentence-alignment.md)：132 次真实 CPU 生成，99 次 Firefox 记录回放，另有 8 项修复后生产结构回归。新对齐方案因语义问题或覆盖不足保持研究状态；动态源文所有权、独立链接和长文本槽分句已修复。[研究工具和复现步骤](ALIGNMENT_RESEARCH.md)区分原生生成、浏览器回放与确定性结构测试。

2026-10-22 已完成 **64 次真实 CPU 生成**：Hy-MT2-1.8B 底座与 PageLingo-MT v0.2.2 各运行 26 条固定槽位样本、6 条纯文本诊断。两者均为 Q5_K_M。原始权重未修改。

| 检查 | Hy-MT2 底座 | PageLingo-MT v0.2.2 |
| --- | --- | --- |
| 新编留出集显示译文 | 20/20 | 20/20 |
| 新编留出集全部关键词/槽位探针通过 | 16/20 | 15/20 |
| 历史失败诊断集显示译文 | 4/6 | 3/6 |
| 历史失败诊断集全部探针通过 | 1/6 | 1/6 |
| 原 DOM 节点、属性、子节点顺序、代码和精确恢复 | 26/26 | 26/26 |

**探针通过数不是翻译准确率，不能据此宣布底座胜出。** “标头”“请勿”“阅读器”等合理用词也会被当前探针拒绝。逐例检查却能确定：DOM 完整保留时，链接内的文字仍可能变成句号，嵌套方向和否定关系也可能译错。因此当前 v0.2.2 尚不适合无人审核地作为结构与语义都可靠的发布基线。

本次原生 CPU 的实测运行数据如下。机器为 Debian 13、AMD EPYC 9V74，3 个可见 CPU，cgroup 配额相当于 2 核、内存上限 8 GiB；推理使用 2 线程，无 GPU。

| 指标 | Hy-MT2 底座 | PageLingo-MT v0.2.2 |
| --- | --- | --- |
| server 启动至健康接口可用 | 0.4793 s | 0.5183 s |
| 固定槽位请求首个非空输出延迟中位数 | 1.9211 s | 2.1183 s |
| 固定槽位生成速度中位数 | 14.6060 token/s | 14.5499 token/s |
| server VmHWM | 1,618,364 KiB | 1,620,172 KiB |

启动时间使用暖文件缓存，关闭 warmup，不包含首次提示计算；内存为单个原生 server 的 RSS 高水位。部分代码验证任务同时运行，以上数据用于记录本次运行，不是严格性能排名，也不能代替 Firefox/WASM 的延迟和整浏览器内存。

- [结果分析与后续门槛](REVIEW.md)
- [逐条结果](results/2026-10-22-cpu.md)、[机器可读证据](results/2026-10-22-cpu.json)
- [来源、转换问题与环境](results/2026-10-22-provenance.json)
- [GPU 接入后的训练步骤](../../training/mt-fixed-slots/README.md)

主力机 12-step 流程探针已完成。随后进行的[三组 BF16 原始生成对照](../../training/mt-fixed-slots/windows/README.md#三组真实生成对照)使用无 grammar 的独立条件，并回放生产结构检查；该结果与本页旧 Q5/grammar 基线分开记录。

2026-10-24 的 96 次真实生成及生产回放已完成：[实测结论与逐例问题](results/2026-10-24-bf16.md)、[完整机器可读证据](results/2026-10-24-bf16.json)。新探针短句显示 19/20、困难段落 2/6，尚无稳定超越 v0.2.2 的证据；不能仅凭 loss 下降或关键词通过数替换模型。

随后完成独立的 [Q5＋grammar 三组对照与真实 Firefox 复测](results/2026-10-24-q5-deployment.md)，另有[完整证据](results/2026-10-24-q5-deployment.json)。新候选短句显示 20/20、困难段落 4/6，但仍有时序和否定错译，保持实验状态。标点化链接/强调文字的应用保护已通过同输出回放及真实 MDN 验证；这部分结果与上述无 grammar BF16 条件分开记录。

## 数据范围

2026-10-25 的[约束生成、最终解码器和 Firefox 复测](results/2026-10-25-quality-v2.md)另行记录 282 次实际 CPU 生成、五条 WASM 片段推理和普通扩展入口的整页测试边界。两组 v2 GPU 候选各完成 44 步训练及三组 240 次 BF16 对照；[定向训练包](../../training/mt-fixed-slots/RESEARCH_V2.md)不自动上传模型。CPU、BF16、WASM 与记录回放的结果分开统计。

随后完成[44 步候选的 CPU 与 Firefox 实测](results/2026-10-25-candidate-v2.md)：增加 320 次原生生成（两轮新旧 Q5 各 148 次、18 次未量化 BF16 诊断和六条 grammar 探索）及十条真实 Firefox 推理。有限槽内边缘空格修复了新候选的一处标记残片，复杂段落时序与动作遗漏仍未解决；正式模型保持不变。当前生成的是下一轮 v2b 训练包，480/64 条、每候选 120 步，尚未运行，不计入这些测量。

`cases.json` 包含 20 条新编留出样本、6 条此前真实网页摘录的失败诊断样本。保留原网页结构片段和来源 URL，本次在 JSDOM 中运行真实生产编码、解码与 PageTranslator 写回逻辑；本次没有重新运行 Firefox，也不是整站截图或排版测试。

新留出集只保证与本次训练种子分离。旧模型完整训练数据未知，不能证明这些句子从未出现在旧训练中。诊断集来自已知失败，不能用作无偏质量分数。

参考译文、槽位划分和探针均由助手编写，状态为 `assistant_authored_needs_human_review`。训练种子有 52 条、验证集有 8 条，仅供流程验证。导出器检查样本 ID、规范化英文、实际模型输入及模板家族的重复和跨集合泄漏；12 条只更换受保护代码标识符的重复输入已经去除。

## 无模型检查

在仓库根目录使用 Node 24：

```bash
npm ci
npm run eval:mt-data
npm test
python3 -m unittest discover -s training/mt-fixed-slots/tests
```

导出的 JSONL 位于 `artifacts/mt-quality/data/`，带文件哈希、来源状态和生产协议源码哈希。参考译文先经过真实生产解码器验证。CI 仅做这些检查，不下载私有权重或运行 GPU 任务。

## 复现 CPU 对照

自行提供私有 PageLingo GGUF、固定版本底座、底座原始 tokenizer/config 和 llama.cpp server；不要把凭证写进命令或仓库。

```bash
python3 tools/mt-quality-bench.py \
  --server /path/to/llama-server \
  --base-model /path/to/Hy-MT2-1.8B-base-Q5_K_M-eos120020.gguf \
  --mt-model /path/to/PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf \
  --source-config /path/to/original-hy-mt2-base \
  --out artifacts/mt-quality/results

python3 tools/mt-quality-report.py \
  --results artifacts/mt-quality/results \
  --out artifacts/mt-quality/comparison.json
```

两模型使用相同请求、模型实际 chat template、grammar、输出上限及采样参数；报告器会核对逐条实际输入完全相同。固定槽位测试调用生产 `inferMtHtml` 和 `PageTranslator`，拒绝时保留整段原文。纯文本对照只帮助判断协议负担，没有 DOM 映射，不能直接写回网页。

三组 Q5 对照可增加 `--candidate-model /path/to/probe-Q5_K_M.gguf`。使用 `--project-root /path/to/frozen-checkout` 可冻结修复前生产逻辑；该 checkout 需安装依赖。报告器读取所有模型组并逐一核对实际输入，可用 `--source-commit COMMIT` 明确记录该基线。

比较解码保护前后的行为时，应回放同一批真实输出并核对请求、grammar 和预算，避免重新生成引入差异：

```bash
node tools/mt-quality-guard-replay.mjs \
  --before-root /path/to/frozen-checkout \
  --input /path/to/results/base-fixed.json \
  --input /path/to/results/pagelingo-mt-v0.2.2-fixed.json \
  --input /path/to/results/probe-12step-fixed.json \
  --out artifacts/mt-quality/guard-replay.json
```

当前保护会拒绝链接及 `em/strong/b/i/mark` 内有意义的文字节点变为空白或纯标点，原子保留整段原文。这是保守检查：合法的符号替代词也可能被保留原文；它不能识别仍由文字组成的错译、否定或时序反转。

当前还要求内容槽非空、限制连续空白和帧后空白，并拒绝近似槽位标记及独立强调否定词丢失；冠词槽可为空。这些检查仍不能完整判断句子语义。

### 公开参考回归

v3 四组 GPU 证据解包后，可以回放全部段落并生成可筛选的 HTML 对照：

```bash
node tools/mt-matrix-replay.mjs \
  --results /path/to/unpacked-evidence \
  --out artifacts/mt-quality/matrix-replay
```

工具核对所有结果文件、冻结源码、逐例实际提示和 token 输入、预算、EOS 与生产调用计划。固定段落执行原始 Text 节点写回、代码与恢复检查；纯文本诊断单独记录，不作为可直接回填网页的译文。

新候选的结果先经过哈希锁定的 BF16 或 Q5 生产回放，再对冻结的 32 条 FLORES 参考计算 chrF2：

```bash
python3 -m pip install sacrebleu==2.5.1
python3 tools/mt-reference-score.py \
  --comparison /path/to/verified-comparison.json \
  --output artifacts/mt-quality/reference-scores.json
```

报告同时提供全部 32 条的实际显示文本分数（拒绝时包含保留的原文）、各模型显示数，以及所有模型共同显示的同一子集分数。拒绝不应被悄悄丢掉以抬高分数。chrF 是参考字符重合指标，不是语义准确率或发布批准；32 条仅作小样本回归信号。数据来源和独立许可见 [external/README.md](external/README.md)。

本次使用 llama.cpp b11785（`8baabd53b77d1c48c6ef8d3b620436292f3f6231`）、CPU 两线程、context 3072、temperature 0、top_k 1、seed 42、关闭 prompt cache。运行器不下载模型、不修改输入权重、不上传模型。

### 转换器 EOS 陷阱

上述版本的转换器将该底座的 EOS 导出成 ID 3（`$`），而原始配置要求 ID 120020。最初错误 EOS 的试跑已废弃，未进入报告。后续全部对照使用独立副本，仅修正 EOS 元数据；没有修改张量。当前私有 PageLingo GGUF 的 EOS 已正确。

```bash
python3 tools/mt-gguf-metadata.py \
  --model /path/to/new-export.gguf \
  --source-config /path/to/original-hy-mt2-base
```

检查失败时先调查。若唯一问题就是上述 EOS，可显式生成新副本：

```bash
python3 tools/mt-gguf-metadata.py \
  --model /path/to/new-export.gguf \
  --source-config /path/to/original-hy-mt2-base \
  --repair-eos --output /path/to/new-export-eos120020.gguf
```

工具拒绝覆盖输入或现有输出，也拒绝自动修复其他 token 或模板差异。基准运行器会在加载前执行该检查。
