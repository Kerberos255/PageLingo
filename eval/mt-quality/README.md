# 固定槽位翻译对照评测

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

## 数据范围

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
