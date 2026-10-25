# PageLingo MT 定向候选 v2 与 v2b

本轮包用于用户授权的定向优化。它保留底座、旧 adapter、已完成的 v2 包和旧启动器，新增 `run-pagelingo-quality-v2b.cmd` 与 `codex-quality-v2b/`；候选只写入全新输出目录。不会自动上传模型。

原 v2 包（提交 `38d1481fdf571f2cb292b103a8763bf8985e0494`）已完成两组各 44 步 GPU 训练与 240 次 BF16 真实生成。其选中候选仍有复杂段落漏译和时序错误。当前生成的是后续 v2b 包，尚未执行这两组 120 步训练；不能将下面的计划当作已完成数据。训练参考为 `assistant_audited_synthetic`，不冒充独立人工审核。

- v2b 训练 480 条、60 个模板家族；验证 64 条、16 个不同家族。保留 v2 的 352/32 条，再新增 128/32 条复杂槽位参考。同族名词变体不算独立样本。
- 新家族针对带代码和换行的 before/after、多个受保护代码之间的完整动作、长段落里的创建/启动、上下界和语义范围；根据已观测失败编写，不是盲测数据。
- 导出器逐条核对生产编码、解码、引用槽位、调用计划、重复输入和评测原句隔离。真实底座 tokenizer 实测最长训练 697 token、验证 445 token；prompt/padding 已屏蔽、EOS 已监督、目标未截断。预检结果随包保存，主力机启动前再次核对。
- 实际生产编码、解码、逐槽目标、整句调用计划及重复检查通过。原 26 条留出/诊断和新增验收样本不进入优化器。
- 生成约束要求内容槽非空、链接/强调槽包含字母或数字，限制连续空白，并在最后一个标记后结束。解码另拒绝否定丢失与近似标记残片。这些都不是完整语义判断器。

## 主力机运行

先打开原来的 `PageLingo-MT.cmd`，在它的 PowerShell 窗口执行：

```powershell
.\run-pagelingo-quality-v2b.cmd
```

默认一次运行以下阶段。可选 `check` 只做预检，不训练。

1. 核对源码包、底座和主力机历史 adapter 的哈希，再检查训练参数与数据。主力机不检查或调用 Firefox、llama.cpp、转换器。
2. 分别训练两组最多 120 个 optimizer step 的候选：从已核实的 v2 选中 r32 adapter 用 1e-5 继续训练；原始底座新建 r16 LoRA 用 3e-5 训练。只使用训练/验证数据。历史 44 步配置保留在仓库，复现旧包应使用上述冻结提交。
3. 每组按验证 loss 保留最佳 checkpoint，再按验证 loss 选择两组中的一个。选择过程不读取发布验收输出。
4. 底座、旧 adapter 和选中候选进行三组 BF16 真实生成，共 240 次，无 grammar。
5. 生成 `gpu-handoff.zip` 和 `handoff-manifest.json`。只包含选中 adapter、训练统计、冻结计划与 BF16 结果，逐项校验 SHA-256，不包含底座、优化器 checkpoint、缓存或凭证。

随后从共享目录取回结果，在 Codex 云电脑进行 CPU 合并、Q5_K_M 导出、BOS/EOS/PAD/template 验证、148 次新旧 Q5 对照，以及五条实际 Firefox/wllama 推理。主力机只提供 GPU 训练和 BF16 验证。

云端浏览器阶段在冻结片段测试页运行，使用与扩展相同的静态 worker、JSPI/CPU 补丁和 CSP；模型通过 Blob 加载。它不等同于扩展 OPFS 或整站自动启动测试。主力机不下载浏览器，不安装或升级训练依赖。

沿用现有 GPU venv。主力机所有任务缓存和产物保持在非 C 盘项目内。运行器要求 2 GiB 可用空间作为训练结果预留；这是一项运行策略，不是实测峰值。完整日志和状态在打印的 `RUN_DIRECTORY` 下。

BF16 中的旧组历史标签为 `v022`，实际加载的是本地 micro-repair adapter（SHA-256 `28a0bd981feab75390ec045a9b97b02401e8a5ab973118d7e54da7b9e77cf859`）。它与 Hub 当前 adapter（`3f4ae312bce156e0762369f25cb14d75422732a2358ddf1f3b8d171dfbb3451e`）的 256 个张量均不同，不能据此把 BF16 与已发布 v0.2.2 Q5 的差异归因于量化。云端部署比较直接使用已发布 GGUF（`8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc`）。

v2b 的继续训练种子是另一个明确身份：v2 选中 adapter `36b50ca2f3813a4e75143ddb05b7374eac06e441fe05a54debe63f2d18494ab3`，config `8e03b25d78d2aba4a774595499015e2f4a72a7f857b996d07e0af4c6c0a30d73`。BF16 的 `v022` 对照仍指前述旧本地 adapter，不是这个新种子。原 v2 的结果目录保持不变。

云端可用以下工具导入已取回的结果包。它校验原始包与每个成员的哈希、底座/旧组/新候选身份、冻结计划和完整 BF16 结果，拒绝覆盖现有目录，也不执行包内文件：

```bash
python tools/mt-handoff-import.py \
  --archive /path/to/gpu-handoff.zip \
  --manifest /path/to/handoff-manifest.json \
  --source-commit 38d1481fdf571f2cb292b103a8763bf8985e0494 \
  --output /path/to/new-import-directory
```

## 冻结的发布检查

发布检查包含旧 26 条回归、16 条新编成对语义检查，以及从官方 FLORES-200 dev 预先抽取的 32 条公开参考译文；另有 6 条纯文本诊断。FLORES 仅用于评测，保留 CC BY-SA 4.0 来源与归属。原始底座可能见过公开基准，不能声称它对基础模型完全未见。

达到以下条件后再判断是否推送模型：

- DOM、属性、链接地址、代码、样式和精确恢复全部通过，错误输出能保留整段原文。
- 16 条成对检查逐条审查，不出现事件顺序、否定、数量上下界、角色方向或 thenable 概念反转；不能用关键词通过数代替该审查。
- 拒绝后保留原文记为未完成翻译，不能算模型语义验收通过。已查看并用于工程调试的验收样本不再称为盲测。
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
