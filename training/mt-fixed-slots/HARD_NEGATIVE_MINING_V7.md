# v7：实际训练源句的难负例采集与审核

这是数据准备阶段，不是新的训练或发布。v6 的人工构造验证负例在训练前就已全部比正确参考更不受模型偏好，本轮改为采集模型实际产生的错义和范围错误，再测量这些输出是否在原始 BF16 权重下也更受偏好。

## 当前产物

- `mining-v7/candidate-pairs.jsonl`：17 个待独立审核的候选对，11 个家族，12 个错义、5 个强调范围错误。
- `mining-v7/manifest.json`：输入 SHA、选择规则和 `optimizer_inputs_approved: false`。
- [12 行抽查短表](mining-v7/review-12.md)：英文、建议正确参考、实际错误及范围说明；独立审核仍为 pending。
- [实际数据准备结果](../../eval/mt-quality/results/2026-11-04-mining-v7.md)。

候选格式与现有训练输入不同，不能直接作为现有 Trainer 的已批准语料。它没有生成新 CMD、切换主力机任务或自动优化模型。v6 仍保持原任务，不重复运行。

## 输入与保护

76 个源句全部取自已有 **train** 分区：v6 的 44 个源句，v5 的 32 个源句，共 27 个家族。它们是助手编写的合成训练材料，不是真实网站或未见过的质量测试。

导出时排除 v2/v3/v4/v5/v6 验证、留出、既有诊断、release、种子和 FLORES：同时核对规范化原句与去掉代码身份后的固定 wire，未将已有失败留出句挪入训练。每个参考经生产解码验证，实际请求须为唯一完整调用。原始私有语料、最终 realweb 和历史原文件保持不动。

## 流程

1. `tools/mt-mining-plan.mjs` 冻结训练源句、完整参考、生产提示和 grammar，不使用人工构造负例作为生成目标。
2. 复用 `tools/mt-sentence-native.py`，新 profile 为 `fixed-training-error-mining-v1`。它核对模型 SHA 和 20 个源码 SHA；新 guard 禁止非训练源句、重复、无 grammar 或被修改的请求。旧对齐 profile 保持可用。
3. `tools/mt-mining-replay.mjs` 核对真实输出身份，并用生产 `PageTranslator` 回放，供逐例事实/范围审核。**和参考不逐字相同不构成错义证据。** 完整审查必须给每条明确结论：可接受、错义、范围错误、有歧义或结构拒绝。
4. `tools/mt-mining-score.py` 只为经助手逐条确认的完整错误计算 chosen 与实际输出的似然，不更新参数。使用原始底座及同一旧 r16 adapter，逐项核对权重/配置 SHA、Q5 与原 tokenizer 的提示/输入 token 摘要、完整目标和 EOS。计算不施加 grammar、不截断，内容统计剔除标记和 EOS。
5. `tools/mt-mining-curate.py` 要求匹配 GPU 的 Transformers 5.17.0、PEFT 0.21.0，只保留同时满足整目标序列 margin ≥1 nat 和内容平均 margin ≥0.01 nat/token 的实际错误。单凭错误译文短、整序列分数高仍不够。之后按家族最多两条，优先覆盖 before/after 方向和错义/范围类型，生成待审核候选。

家族筛选是观察后的训练数据整理，不是预注册无偏评测。CPU/GPU、Q5/BF16、canonical 文本分词与实际生成 token 路径不是同一测量；此处证明的是给定固定提示、原始权重和这一份正确参考下的偏好，不能声称所有正确改写都比错误更不受偏好。

## 云端复现

需要已有 Node 项目依赖、llama.cpp server、旧 r16 Q5 和原始 BF16/adapter，以及现有 PyTorch/Transformers/PEFT 环境。工具不会下载、转换、上传或替换模型。主力机无需执行这些云端 CPU 步骤。

```bash
node tools/mt-mining-plan.mjs --out /path/mining/plan.json
python tools/mt-sentence-native.py \
  --server /path/llama-server --model /path/candidate-v2b-Q5_K_M.gguf \
  --sha256 748c66dee23ec95583d0c84bd49bd3e516b0d2c1d242fbf4e152ff710e0f62bb \
  --plan /path/mining/plan.json --output /path/mining/q5-run
node tools/mt-mining-replay.mjs --plan /path/mining/plan.json \
  --run /path/mining/q5-run/run.json --out /path/mining/replay.json
```

先逐条审核并写入 `audit.json`，不可把全部不同译文自动标为负例；审查需绑定计划、实际运行、回放 SHA 和每条输出 SHA，并记录英文事实、具体错误以及参考确认。

```bash
python tools/mt-mining-score.py --plan /path/mining/plan.json \
  --replay /path/mining/replay.json --audit /path/mining/audit.json \
  --base /path/original-base --adapter /path/old-r16-adapter \
  --output /path/mining/bf16-score
python tools/mt-mining-curate.py --plan /path/mining/plan.json \
  --replay /path/mining/replay.json --audit /path/mining/audit.json \
  --scores /path/mining/bf16-score/result.json --output /path/mining/candidates
```

所有执行输出必须用新目录，保留旧证据。BF16 计分和原生 server 分开执行，避免同时占用云环境内存。当前 17 对尚不构成已审核训练集；后续若集成有界对照，仍需保留正确参考、普通翻译和固定槽回放，并用原有留出独立检查。未批准模型权重发布，也没有证据需要从头重训整个底座。
