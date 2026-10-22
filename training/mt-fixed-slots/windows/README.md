# 主力机 Windows 启动包

共享目录：`\\192.168.50.72\pagelingo-mt`。旧入口显示主力机本地目录为 `E:\PageLingo-MT`。通过 MCP 检查文件的机器与主力机不同，因此 MCP 端不运行共享目录的 Python venv 或启动训练。

保留旧 `PageLingo-MT.cmd`、原始数据、adapter、模型和虚拟环境。新增根目录 `run-fixed-slots-v1.cmd`，脚本和数据独立放在 `codex-fixed-slots-v1\`。

## 用户操作

先在主力机上打开原来的 `PageLingo-MT.cmd`，再在其 PowerShell 窗口运行：

```powershell
.\run-fixed-slots-v1.cmd check
```

成功后运行：

```powershell
.\run-fixed-slots-v1.cmd
```

默认模式是 **最多 12 个 optimizer step 的 GPU 流程探针**。使用固定 Hy-MT2-1.8B 原始底座和 52/8 条新协议种子，记录训练前后验证 loss、实际 optimizer step、GPU 名称和显存峰值。种子未经独立人工审核，输出标记为 `pipeline_probe`，不能当作正式质量升级。

每次运行单独创建 `outputs\pagelingo-fixed-slots-v1-{check|probe}-时间-随机后缀\`，内部有 `console.log`、`launch.json`、`exit.json`、`training\preflight.json`。探针训练成功后还会有 `training\training-result.json`、checkpoint 和 adapter。出错时查看日志；CMD 会保留窗口。脚本不自动恢复或覆盖旧目录，重新运行会创建新的探针。

`train` 模式仅在更新数据、完成审核且重新生成包后使用。当前种子会被该模式拒绝，防止把流程探针误作正式训练。

## 环境与缓存

沿用已有 `.venv`，不自动升级或降级依赖，不自动下载模型，不上传任何产物。共享目录的已安装包目录显示 torch 2.14.0+cu130、transformers 5.17.0、peft 0.21.0、accelerate 1.15.0、tokenizers 0.23.2、safetensors 0.8.0；这只是文件检查，实际 CUDA 可用性由主力机运行时验证。

CMD 在 Python 启动前重定向任务的临时目录、HF、pip、torch、CUDA JIT、Triton、Inductor、pycache、uv、matplotlib、numba 等缓存到项目内的 `.tmp` 和 `.cache`，并检查这些路径位于非 C 盘项目目录。必须使用主力机本地 E 盘路径运行，拒绝直接用 UNC 作为训练目录。

新工具不会读取 HF token 或 stored_tokens。实际训练只加载本地 BF16 模型；启动前校验其 SHA256，不依赖网络认证。既有 Linux 测试使用的依赖版本另存为 `requirements-reference.txt`，仅供比对，不应据此替换主力机已有 GPU 环境。

## 旧训练内容的处理

已找到：v0.2 训练/验证 1200/200 条，v0.2.1 修复 320/80 条，v0.2.2 微修复 80/40 条，v0.3 product-envelope 192/64 条，以及 smoke 各版本。数量不等于独立样本数，版本之间可能重复。

`final\training_config.json` 表明 v0.2.2 从 v0.2 checkpoint-100 继续，用学习率 5e-6、梯度累积 8、1 epoch，共 10 个 optimizer step。已实际计算共享目录最终 adapter 的 SHA256：`28a0bd981feab75390ec045a9b97b02401e8a5ab973118d7e54da7b9e77cf859`，与旧 checkpoint-10 锁定清单完全一致。这里确认的是本地 final adapter，不自动代表 Hub 上任意 adapter 版本。

本次审计 16 个 train/validation 文件，共 4,192 条训练、764 条验证记录，全部使用可移动标记提示。规范化 source 未发现跨训练/验证的完全重复；去掉 train/validation 前缀后发现 75 个同名模板家族，后续划分应按实际模板家族检查。完整文件哈希、计数、token 顺序差异和旧配置保存在 `evidence/legacy-inventory-2026-10-22.json`。这些数据不是新训练的输入。

旧协议允许 inline 标记整体移动、标记外还有自由文字；当前生产协议把每个原始文字节点固定为顺序槽位。两者不可直接混用。`inspect_legacy.cjs` 仅审计旧 train/validation 和 checkpoint 元数据，列出重复、跨集合模板家族以及 source/target token 顺序差异，不把旧语料自动加入新训练，也不读取或复用 FINAL/holdout 试题内容。

后续应对可复用旧语料做槽位对齐转换和人工审核，再增加长技术段落、链接范围、强调否定、时序和 EOS 样本。新探针从原始底座开始，不自动续训旧协议 adapter。

## 重新生成与部署

在 PageLingo 源码根目录：

```bash
npm run eval:mt-data
node tools/mt-windows-kit.mjs --out artifacts/mt-windows-kit
```

把产物根目录中的 CMD 和 `codex-fixed-slots-v1` 文件夹放入主力机项目根目录。包内 `package-manifest.json` 校验代码和数据；若修改了数据或配置，必须重新生成包以保留一致的哈希。正式训练前仍需先审核、扩充数据，并按评测文档比较 BF16/Q5 与真实 Firefox 表现。
