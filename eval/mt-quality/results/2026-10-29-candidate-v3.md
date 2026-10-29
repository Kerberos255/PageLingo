# PageLingo-MT v3：四组实测与发布判断

## 判断

**两组新模型均未通过发布验收。** 本轮修正了若干动作遗漏和角色错配，但出现或保留了顺序反转、错误否定和术语替换。r16 的普通参考分数基本持平，r32 有退步。正式模型继续保持 v0.2.2；不上传新权重，不按总 loss 选赢家，也不立即启动下一轮训练。

## 运行与完整性

主力机运行 `outputs/pagelingo-quality-v3-run-20261029-192044-4bab50`，冻结源码 `5b7f425a90815987f1dbf7997b11c70630d757bb`。两组各 64 个 optimizer steps，分别从 v2b r16/r32 继续 LoRA；底座仍为原始 Hy-MT2-1.8B，基础权重未训练。

GPU：NVIDIA GeForce RTX 4070 Ti，Torch 可见显存 12,878,086,144 字节。实际版本：Torch 2.14.0+cu130、Transformers 5.17.0、PEFT 0.21.0。

UTC 2026-10-29T11:20:44.104495+00:00 → 2026-10-29T12:07:08.595548+00:00，实际总墙钟 2784.491053 秒。两个训练子进程阶段为 346.479833 / 354.433568 秒；四组 BF16 评测阶段为 2040.889025 秒，全部 exit code 0。训练内部含验证的计时分别为 332.676479 / 341.117216 秒，与含进程启动的阶段计时分别记录。

结果 ZIP 279,952 字节，SHA-256 `050f28e36bbf0df422d0aae42d5f6f3f4f0750969f15882619326f7003e9cda0`。ZIP CRC 以及全部 14 个成员的字节数、SHA 校验通过。每组 176 次真实生成，共 704 次；全部由 EOS 120020 正常结束，无输出预算截断。逐例实际提示和输入 token SHA 在四组之间一致；生产调用的消息、grammar 和预算与冻结计划一致。

每组包括 170 个固定槽位段落与 6 个纯文本诊断。四组固定段落共有 **680/680** 次 DOM、属性、代码与恢复检查通过，这是已记录输出的生产渲染回放，不是新浏览器推理。拒绝并保留原文也计入结构安全，可显示数不是翻译正确数。

## 配对结果

| 模型 | 新验证内容 NLL↓ | 固定段落可显示 | 旧验证可显示 | 新验证可显示 | 32 条 FLORES chrF2 |
|---|---:|---:|---:|---:|---:|
| old_r16 | 1.149654 | 159/170 | 57/64 | 32/32 | 37.112523 |
| old_r32 | 1.191318 | 159/170 | 59/64 | 31/32 | 36.362089 |
| v3_r16 | 1.077304 | 158/170 | 57/64 | 32/32 | 37.173046 |
| v3_r32 | 1.107958 | 160/170 | 61/64 | 28/32 | 35.487447 |

NLL 在同一批新验证参考上计算：836 个内容 token、1,044 个 marker、32 个 EOS，共 1,912 个目标 token。损失降低不等于语义正确。旧 64 条与新 32 条均为模板扩展的合成数据，未独立人工盲评；已有失败类型参与课程设计，结果属于回归证据。

FLORES 32 条四组均显示，使用相同公开参考、相同显示子集和 sacrebleu 2.5.1，签名 `nrefs:1|case:mixed|eff:yes|nc:6|nw:0|space:no|version:2.5.1`。chrF2 是参考字符重合指标；该小样本不支持准确率或统计显著性结论。

### 模型身份与训练显存

| 模型 | adapter SHA-256 |
|---|---|
| old_r16 | `85546101dce5baae57f472b92e8b722f68c4c26550b396187e0b0e5d3e844b02` |
| old_r32 | `dfc3874e46f810c9d9951add371cce13cc2987bcb2fd673ade2af62ee22670cb` |
| v3_r16 | `306a3c640aaed16a6cd1d7c2eff5d2b9c9ef4b242e4934449dd3af3348924528` |
| v3_r32 | `ac197feef83d8d839234a9a771c44254bdd5cd3b12cfd333a40455ce5ca554f7` |

| 训练组 | CUDA allocated 峰值（字节） | CUDA reserved 峰值（字节） |
|---|---:|---:|
| r16 | 4,821,882,880 | 7,107,248,128 |
| r32 | 4,930,934,784 | 7,235,174,400 |

这些是 PyTorch 分配器记录的峰值，不等于完整 GPU 驱动占用或主机内存峰值。

## 具体译文：改善与回归

### v2-hard-validation-check-before-connect-0

两组新模型均保留验证存档、成功之后再连接，以及无效对端保持断开的要求。

原文：Validate the archive through validate_peer() successfully before
connecting to the peer; an invalid peer must remain disconnected.

- old_r16（显示）：先通过 validate_peer() 成功 再
验证归档；无效的对等体必须保持断开状态。
- old_r32（显示）：先通过 validate_peer() 成功 再
连接对端；无效的 peer 必须保持断开状态。
- v3_r16（显示）：验证归档时，先 validate_peer() 成功 再
连接对端；对端无效时必须保持断开状态。
- v3_r32（显示）：验证归档时，先 validate_peer() 成功 再
连接对端；对端无效时必须保持断开状态。

### v2-validation-publish-then-unlock-2

两组新模型均修正旧 r32 向 mutex 交付并解锁审计员的角色错配。

原文：Do not unlock mutex until the reservation has been delivered to the auditor.

- old_r16（保留原文）：Do not unlock mutex until the reservation has been delivered to the auditor.
- old_r32（显示）：先向 mutex 交付预约，再解锁 审计员.
- v3_r16（显示）：不要解锁 mutex ，直到预留项已交付给 审计员.
- v3_r32（显示）：先不要解锁 mutex ，必须等预留内容已交付给 审计员.

### v2-hard-validation-history-before-prune-0

新 r16 保留复制且顺序正确；新 r32 保留了拷贝，但清理仍被安排在拷贝之前。

原文：Copy the archive into the recovery journal before pruning it from the active index.

- old_r16（显示）：请将归档文件放入 恢复日志 中， 再将其从活动索引中剪除。
- old_r32（显示）：请将归档放入 恢复日志 之前 将其从活动索引中剪除。
- v3_r16（显示）：将归档文件复制到 恢复日志 中， 再将其从活动索引中剪除。
- v3_r32（显示）：将归档拷贝到 恢复日志 之前 将其从活动索引中剪除。

### d-asyncio-task-04

旧 r16 先传递再打开；新 r16 用“传递……之前打开”，颠倒顺序。

原文：pass the task group instance or bound cancel() method to some other task before
opening the task group, allowing remote cancellation

- old_r16（显示）：传递任务组实例或绑定的 cancel() 方法给其他任务 再
打开任务组，支持远程取消
- old_r32（显示）：先传递任务组实例或绑定的 cancel() 方法，再将其指向其他任务 之前
打开任务组，支持远程取消
- v3_r16（显示）：传递任务组实例或绑定的 cancel() 方法给其他任务 之前
打开任务组，支持远程取消
- v3_r32（显示）：传递任务组实例或绑定的 cancel() 方法，再传递给其他任务 之前
打开任务组，支持远程取消

### d-html-headings-05

旧 r32 要求嵌套标题且不跳级；新 r32 显示“不能嵌套标题”，新增否定。

原文：Prefer using only one <h1> per page and nest headings without skipping levels.

- old_r16（显示）：每页只使用一个 <h1> ，并且不能跳级，必须按 嵌套标题 的方式排列。
- old_r32（显示）：每页只使用一个 <h1> ，不得跳过层级 嵌套标题 。
- v3_r16（保留原文）：Prefer using only one <h1> per page and nest headings without skipping levels.
- v3_r32（显示）：每个页面只使用一个 <h1> ，并且 不能嵌套标题 ，不能跳过层级。

### release-v2-handoff-order-after

新 r16 显示先交给调度器、之后订阅，与原文 after 相反；新 r32 此例顺序正确。

原文：Give token to the scheduler after subscribing to updates.

- old_r16（显示）：先 token 订阅更新后， 再 把 内容交给调度器。
- old_r32（保留原文）：Give token to the scheduler after subscribing to updates.
- v3_r16（显示）：将 token 交给 调度器 ，之后 订阅更新。
- v3_r32（显示）：将 token 交给 调度器 ，晚于 订阅更新。

### release-v2-handoff-order-before

新 r16 显示词序破碎、交付动作不完整；新 r32 格式不完整而保留原文。

原文：Give token to the scheduler before subscribing to updates.

- old_r16（显示）：先 token 将 调度器 的 更新订阅。
- old_r32（显示）：先 token 再 交给调度器 订阅更新。 。
- v3_r16（显示）：先 token 将 调度器 的 更新订阅。
- v3_r32（保留原文）：Give token to the scheduler before subscribing to updates.

### v2-hard-validation-after-exchange-0

新 r16 仍把 nonce exchange 换成非对称密钥交换；新 r32 省略了 nonce 概念。

原文：Expose the archive via publish_view() only after the nonce exchange finishes. An unfinished exchange is not permission to publish.

- old_r16（显示）：必须通过 publish_view() 发布归档， 必须 完成非对称密钥交换之后。未完成交换不得发布。
- old_r32（显示）：通过 publish_view() 只能 非对称密钥交换完成后 才能发布归档。未完成的交换无法发布。
- v3_r16（显示）：通过 publish_view() 发布归档，必须 晚于 非对称密钥交换完成。未完成交换不得发布。
- v3_r32（显示）：通过 publish_view() 发布档案的前提是 交换完成之后 。交换未完成时，不得发布。

### v2-hard-validation-stop-before-close-0

新 r16 仍漏掉交付存档的动作和对象；新 r32 产生交付前先关闭的顺序问题。

原文：Deliver the archive through signal_stop() successfully before
closing the transport. The signal allows pending work to finish; closing the transport first may lose that work. If signaling fails, report an error and keep the transport open.

- old_r16（显示）：必须先通过 signal_stop() 成功 再
关闭传输。该信号用于完成待处理工作；若先关闭传输，可能会丢失工作。如果信号发送失败，应报告错误并继续保持传输打开。
- old_r32（显示）：通过 signal_stop() 成功 之后
，再关闭传输。该信号可让待处理工作完成；先关闭传输可能会丢失这些工作。如果信号发送失败，请报告错误并继续保持传输打开。
- v3_r16（显示）：通过 signal_stop() 成功 再
关闭传输。该信号用于完成待处理工作；先关闭传输可能会丢失工作。如果信号发送失败，应报告错误并继续保持传输打开。
- v3_r32（显示）：交付归档之前，必须 signal_stop() 成功 先
关闭传输。该信号用于让待处理工作完成；先关闭传输可能会丢失这些工作。如果信号发送失败，应报告错误并继续打开传输。

## 云端补充诊断：提示与固定槽位

在既有 v2b r16 Q5（SHA `748c66dee23ec95583d0c84bd49bd3e516b0d2c1d242fbf4e152ff710e0f62bb`）上做九条已知失败句、三种提示，共 27 次真实 CPU 生成。A 为生产提示和 grammar；B 只删除“Do not move words between pairs.”，其余消息、grammar、预算与采样不变；C 为纯文本翻译对照。C 同时改变格式和提示，不能单独据此归因。

A/B 有 5/9 条原始输出完全相同，均有 8/9 可显示；18/18 次有框架输出保持 DOM、代码并可恢复。删除该句没有修好交接 before 句和创建/启动线程遗漏，不能把删一句提示当修复。

例如 C 对 after 句输出“订阅更新后，将令牌交给调度器”，对线程句保留创建与启动；A/B 的交接 before 句仍为碎片，线程句仍漏创建/启动。但 C 还把 cancel() 译成“取消()”，且没有可回填原 DOM 的槽位映射，不能直接作为产品实现。

该诊断使用旧 Q5，不能当作两个 v3 adapter 的量化或 Firefox 结果。两组 v3 已在 BF16 出现严重语义错误，本轮没有把它们选为量化候选，未执行 v3 Q5/Firefox，也未上传模型。

## 下一步

暂停给同一槽位训练方案继续加轮数。先在云端比较“句级翻译 + 受保护文本对齐”与当前固定槽位推理，保留 DOM、链接、代码和原文恢复保护；只有端到端证据证明兼顾语义和结构后，再决定是否需要围绕新协议训练。涉及对齐失败的段落继续保留原文。

## 复现与证据

回收证据后运行：

```bash
node tools/mt-matrix-replay.mjs --results /path/to/unpacked-evidence --out /path/to/replay
python3 tools/mt-reference-score.py --comparison /path/to/replay/production-replay.json --output /path/to/reference-score.json
```

四组回放工具核对源文件哈希、所有结果哈希、输入身份、结束 token、预算和实际生产调用。另做负向检查：在带匹配更新文件摘要的副本中篡改一组实际输入 token SHA，工具拒绝比较；原始结果不受影响。

原始主力机结果、27 次 CPU 诊断、全部译文 HTML 对照、逐例 JSON、阶段日志和校验清单保留在云端证据包中，不包含模型权重或凭证。
