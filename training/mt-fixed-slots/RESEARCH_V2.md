# PageLingo MT 定向候选 v2

本轮包用于用户授权的定向优化。它保留底座、旧 adapter 和旧启动器，新增 `run-pagelingo-quality-v2.cmd` 与 `codex-quality-v2/`；候选只写入全新输出目录。不会自动上传模型。

已完成 CPU 数据预检，尚未声称完成这两组新候选的 GPU 训练。训练数据来自助手编写并按模板审查的合成参考，状态为 `assistant_audited_synthetic`，不冒充独立人工审核。

- 训练 352 条、44 个模板家族；验证 32 条、8 个不同家族。同族名词变体不算独立样本。
- 真实底座 tokenizer 实测最长训练 697 token、验证 445 token；prompt/padding 已屏蔽、EOS 已监督、目标未截断。
- 实际生产编码、解码、逐槽目标、整句调用计划及重复检查通过。原 26 条留出/诊断和新增验收样本不进入优化器。
- 生成约束要求内容槽非空、链接/强调槽包含字母或数字，限制连续空白，并在最后一个标记后结束。解码另拒绝否定丢失与近似标记残片。这些都不是完整语义判断器。

## 主力机运行

先打开原来的 `PageLingo-MT.cmd`，在它的 PowerShell 窗口执行：

```powershell
.\run-pagelingo-quality-v2.cmd
```

默认一次运行以下阶段。可选 `check` 只做预检，不训练。

1. 核对源码包、底座和 v0.2.2 adapter 的哈希，再检查训练参数与数据。主力机不检查或调用 Firefox、llama.cpp、转换器。
2. 分别训练两组最多 44 个 optimizer step 的候选：已核实的 v0.2.2 r32 adapter 用 1e-5 继续训练；原始底座新建 r16 LoRA 用 3e-5 训练。只使用训练/验证数据。
3. 每组按验证 loss 保留最佳 checkpoint，再按验证 loss 选择两组中的一个。选择过程不读取发布验收输出。
4. 底座、旧 adapter 和选中候选进行三组 BF16 真实生成，共 240 次，无 grammar。
5. 生成 `gpu-handoff.zip` 和 `handoff-manifest.json`。只包含选中 adapter、训练统计、冻结计划与 BF16 结果，逐项校验 SHA-256，不包含底座、优化器 checkpoint、缓存或凭证。

随后从共享目录取回结果，在 Codex 云电脑进行 CPU 合并、Q5_K_M 导出、BOS/EOS/PAD/template 验证、148 次新旧 Q5 对照，以及五条实际 Firefox/wllama 推理。主力机只提供 GPU 训练和 BF16 验证。

云端浏览器阶段在冻结片段测试页运行，使用与扩展相同的静态 worker、JSPI/CPU 补丁和 CSP；模型通过 Blob 加载。它不等同于扩展 OPFS 或整站自动启动测试。主力机不下载浏览器，不安装或升级训练依赖。

沿用现有 GPU venv。主力机所有任务缓存和产物保持在非 C 盘项目内。运行器要求 2 GiB 可用空间作为训练结果预留；这是一项运行策略，不是实测峰值。完整日志和状态在打印的 `RUN_DIRECTORY` 下。

## 冻结的发布检查

发布检查包含旧 26 条回归、16 条新编成对语义检查，以及从官方 FLORES-200 dev 预先抽取的 32 条公开参考译文；另有 6 条纯文本诊断。FLORES 仅用于评测，保留 CC BY-SA 4.0 来源与归属。原始底座可能见过公开基准，不能声称它对基础模型完全未见。

达到以下条件后再判断是否推送模型：

- DOM、属性、链接地址、代码、样式和精确恢复全部通过，错误输出能保留整段原文。
- 16 条成对检查逐条审查，不出现事件顺序、否定、数量上下界、角色方向或 thenable 概念反转；不能用关键词通过数代替该审查。
- 通用参考译文的 chrF 与逐例审查没有发现明显退化。32 条样本只提供回归信号，不代表完整准确率。
- Q5 与 BF16 的重要语义差异已审查，实际 Firefox 加载和生成成功，模型身份与 token 元数据已验证。

Loss 下降、正常 EOS、grammar 合法或“显示译文”都不能单独批准发布。`workflow-result.json` 始终保留 `release_approved: false`，由后续真实结果审查给出结论。

## 源码环境复现准备

```bash
npm run eval:mt-targeted
node tools/mt-research-kit.mjs
python artifacts/mt-research-v2/codex-quality-v2/research_v2.py \
  --root artifacts/mt-research-v2 --plan
```

计划模式不导入 torch、不加载权重、不创建训练输出。包内 manifest 锁定每个文件；修改源码或数据后必须重新生成、核对并部署整个包。
