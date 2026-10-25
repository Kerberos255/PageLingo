# PageLingo MT 定向 LoRA 训练包

本包已完成 CPU 数据预检、主力机 12-step GPU 流程探针及三组 BF16 生成对照。探针仍是实验候选，尚未作为发布模型。基础模型是 `tencent/Hy-MT2-1.8B`，固定 revision `9a341cd1b679d3efd23b46e847b01745a71ed792`。没有启动收费任务或上传新权重。

主力机使用非 C 盘缓存的用户可使用 [Windows CMD 启动包](windows/README.md)。共享目录中的旧训练配置与本地 final adapter 身份已恢复核实，旧语料采用不同协议，仍需转换和审核。

继续优化使用独立的[定向候选 v2 启动包](RESEARCH_V2.md)：352/32 条合成训练/验证样本，两组最多 44 步候选，只按验证 loss 选择，再进行 BF16、Q5 与 Firefox 对照。它与下述 52/8 条种子的流程探针分开，数据状态保持 `assistant_audited_synthetic`，不冒充人工审核或自动批准发布。

`seed.json` 为助手编写、待人工审核的 52 条训练种子与 8 条验证样本，仅适合测试数据和训练链路。正式微调前需要扩充并人工审核长段、术语与槽位对齐样本。不得把当前种子流程探针称作质量升级。

## 已验证的部分

- 导出真实生产固定槽位 prompt/target，检查跨集合的英文、实际模型输入及模板家族重复。
- 使用固定底座 tokenizer 完成分词：训练最长 268 token、验证最长 250 token，无截断；监督目标分别共 2008/318 token，包含 EOS。
- prompt 与 padding 标签均为 `-100`，只监督 assistant 目标；检查 padding mask，训练代码只读取 train/validation。
- 原始 checkpoint 中匹配 128 个 q/k/v/o 权重张量，rank 16 对应 **6,815,744** 个 LoRA 权重；成功训练后的 adapter 也已核对数量和 SHA256。
- GGUF EOS 检查/新副本修复的 4 个回归测试通过。当前转换器的 EOS 问题见[评测说明](../../eval/mt-quality/README.md)。

RTX 4070 Ti 上实际完成 12 步，训练、验证和最终保存共 48.7044 秒，验证 loss 为 0.688115 → 0.470292；PyTorch 显存峰值 allocated 3.8525 GiB、reserved 4.8184 GiB。这些是小种子流程探针的实测值，不代表正式训练需求或翻译质量。BF16 对照与后续 Q5/Firefox 部署检查见[评测记录](../../eval/mt-quality/README.md)。

## 准备与 CPU 预检

在仓库根目录运行。不要使用 GGUF 训练，需原始 BF16 safetensors 与同 revision 的 tokenizer/config 文件。

```bash
npm ci
npm run eval:mt-data

python3 -m venv /path/to/mt-train-venv
/path/to/mt-train-venv/bin/python -m pip install -r training/mt-fixed-slots/requirements.txt

/path/to/mt-train-venv/bin/python training/mt-fixed-slots/train.py \
  --data artifacts/mt-quality/data \
  --base /path/to/original-hy-mt2-base \
  --output artifacts/mt-quality/preflight
```

本地 `model.safetensors` 必须匹配配置中的原始底座 SHA256；预检会校验。也可省略 `--base`，使用配置内固定 Hub revision；脚本不会下载或继续使用来源不确定的旧 adapter。Hub 访问按环境既有认证，不应把 token 放进文件。

本轮 CPU 环境使用 torch 2.10.0+cpu、transformers 5.6.0、peft 0.18.1。GPU 环境需安装适合其驱动的 CUDA 版 PyTorch，并确认：

```bash
python -c 'import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.is_bf16_supported())'
```

两个可用性检查都为真再执行 GPU 训练。原始配置在 transformers 5.6.0 下有 `rope_parameters` 未识别键警告；CPU 分词预检不验证前向数值，GPU 探针需要检查有限 loss、梯度与候选译文，不能忽略异常继续发布。

## GPU 接入后先跑流程探针

```bash
python training/mt-fixed-slots/train.py \
  --data artifacts/mt-quality/data \
  --base /path/to/original-hy-mt2-base \
  --output artifacts/mt-quality/gpu-probe-01 \
  --train --probe --allow-unreviewed-seed-data
```

输出必须为新目录或空目录。未审核种子只允许显式选择的有限流程探针；未提供 GPU 时脚本拒绝优化。不会上传 Hub，也不会替换底座、旧模型或扩展模型目录。

参数在 `config.json`：BF16、q/k/v/o LoRA r16/alpha32、dropout 0.05、学习率 5e-5、batch 1、累积 16、max length 3072、固定 seed 42。探针最多 12 个 optimizer step。正常候选默认 2 epoch，这些是起始配置，尚无正式训练质量验证。

人工审核并扩充种子后，在每条记录中把状态改为 `human_reviewed`，重新导出且核查 manifest；正式候选去掉 `--probe --allow-unreviewed-seed-data`，使用另一个全新输出目录。不要把诊断或留出样本移入训练。`preflight.json` 记录输入与配置，成功训练后另存 `training-result.json` 和 adapter。

## 合并、Q5 导出与再评测

以下步骤需要 GPU 探针先成功。合并仅写入独立目录，并记录底座与 adapter 哈希、依赖版本及耗时；不覆盖输入权重。

```bash
python training/mt-fixed-slots/merge_adapter.py \
  --base /path/to/original-hy-mt2-base \
  --adapter artifacts/mt-quality/gpu-probe-01/adapter \
  --output artifacts/mt-quality/probe-merged --threads 2

python /path/to/llama.cpp/convert_hf_to_gguf.py \
  artifacts/mt-quality/probe-merged --outtype bf16 \
  --outfile artifacts/mt-quality/probe-BF16.gguf

/path/to/llama-quantize \
  --override-kv tokenizer.ggml.eos_token_id=int:120020 \
  artifacts/mt-quality/probe-BF16.gguf \
  artifacts/mt-quality/probe-Q5_K_M.gguf Q5_K_M 2

python tools/mt-gguf-metadata.py \
  --model artifacts/mt-quality/probe-Q5_K_M.gguf \
  --source-config /path/to/original-hy-mt2-base
```

上述量化覆盖值只适用于已核实 EOS 为 120020 的当前底座，不能代替最终 metadata 检查。使用不支持该参数的旧版量化器时，按评测 README 修复到独立新副本。随后运行[相同 CPU 对照](../../eval/mt-quality/README.md)，并按[发布门槛](../../eval/mt-quality/REVIEW.md)审查逐槽语义和真实 Firefox。训练 loss 降低、grammar 合法或 DOM 检查通过，都不足以证明翻译质量提升。
