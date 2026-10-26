# 现有权重的验证诊断

本任务只评测已经存在的底座、v2b fresh r16 和 v2b resumed r32，不追加训练、更新权重、合并、量化、运行 Firefox 或上传模型。主力机继续只提供 GPU；云端处理结果回放与审查。

先打开原 `PageLingo-MT.cmd`，在它的 PowerShell 窗口输入 `x` 并按 Tab，执行固定任务入口 `x.cmd`。当前任务由 `tools/mt-control/current-task.json` 指向；不会新增用户 CMD 或覆盖环境入口。重复执行已完成任务只显示状态。

v2b 的旧总 loss 选择 fresh r16，但实际 Q5 仍有时序动作和指代错误。验证参考正文的实际 tokenizer 统计为 4,279 token，其中 2,964（69.27%）只属于格式标记；另有每条一个 EOS。该比例不是损失贡献，也不是已证因果解释。因此本轮先拆开测量，而不是继续增加训练步数。

冻结任务核对三组权重及 adapter 配置，使用与训练相同的独立 prompt/target 拼接、prompt mask、单个 EOS 和固定 3,072 上下文。64 条验证数据与训练家族隔离，逐条核对生产请求及输出预算，拒绝截断，确认监督目标共 4,343 token。三组分别记录内容、标记和 EOS 的 NLL，以及按 token 加权和按样本平均的总 loss，避免用不同加权方式冒充原 Trainer 指标。

随后执行三组各 64 次贪心 BF16 真实生成，共 192 次，无 grammar。权重冻结，不创建优化器；参考、模型身份、提示哈希、逐例输出与显存峰值随 `validation-results.zip` 打包。生成使用生产预算；观察 marker 与 content 的损失不同，不等于语义通过。

这 64 条是已用于训练验证和 checkpoint 选择的助手审查合成参考，不是独立人工审核或盲测。结果用于比较现有候选与诊断目标，不自动选择发布模型。`release_approved` 始终为 false；源码与运行结果保留失败记录。
