# 12 条独立抽查短表

**2026-11-05 补充：** 请先读[参考质量反馈](REFERENCE_REVIEW_FEEDBACK.md)。下表固定槽参考过于生硬，不能直接作为自然中文金标准。第 9–12 行应区分整句原意与强调范围。17 对候选仍未获批准进入训练；下方历史短表原样保留。

请看英文和两段中文，判断建议参考是否忠实、模型输出是否确实错义或改变强调范围。参考由助手整理，仍待你的独立抽查。
可以回复“1–12 均同意”，或列出有异议的编号和修改。抽查不等于全部 17 条或模型质量已经通过。此文件不会自动启动训练。

| 编号 | 英文原句 | 建议正确参考（待审核） | 模型实际输出 | 助手判定 |
| --- | --- | --- | --- | --- |
| 1 | Use encrypt_snapshot() to encrypt the snapshot **after** sending it to the mirror. | 使用 encrypt_snapshot() 加密快照必须 晚于 将其发送到镜像端。 | 使用 encrypt_snapshot() 对快照进行加密， 随后 将其发送给镜像。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 2 | Use archive_receipt() to archive the receipt **after** notifying the buyer. | 使用 archive_receipt() 归档收据必须 晚于 通知买方。 | 使用 archive_receipt() 保存回执， 随后 通知买家。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 3 | Use seal_partition() to seal the partition **after** calculating its digest. | 使用 seal_partition() 封闭分区必须 晚于 计算其摘要。 | 使用 seal_partition() 来密封分区 ，随后 计算其摘要。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 4 | Use refresh_catalog() to refresh the catalog **after** restarting the search service. | 使用 refresh_catalog() 刷新目录必须 晚于 重启搜索服务。 | 使用 refresh_catalog() 来刷新目录， 然后再 重启搜索服务。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 5 | Use renew_certificate() to renew the certificate **after** reloading the proxy. | 使用 renew_certificate() 更新证书必须 晚于 重新加载代理。 | 使用 renew_certificate() 来续期证书， 之后 重新加载代理。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 6 | Calibrate the sensor **after** recording the next sample. | 校准传感器必须 晚于 记录下一个样本。 | 校准传感器 后 记录下一个样本。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 7 | Use save_attestation() to persist the attestation **after** accepting the certificate. An issuer name alone is not an attestation. | 调用 save_attestation() 持久保存证明；这一操作的时机必须 晚于 接受证书。只有签发者名称并不构成证明。 | 使用 save_attestation() 来持久化验证， 之后 接受证书。仅 issuer name 本身并不构成验证。 | 原句两项动作的先后关系被反转；完整参考保留了源句 before/after 所要求的次序。 |
| 8 | Once the challenge has been answered, discard the spent nonce and **generate a fresh nonce**. A nonce is a one-use random value, not an asymmetric key. | 质询得到应答后， 丢弃已使用的随机数 并 生成新的随机数。随机数是一次性随机值，而不是非对称密钥。 | 挑战被回答后， 丢弃已使用的非对称密钥 ，然后 生成新的非对称密钥。非对称密钥是一种一次性随机值，不是非对称密钥。 | 将 nonce 两次误作非对称密钥，末句又说它不是非对称密钥，与源句的一次性随机值定义矛盾。 |
| 9 | Encrypt the snapshot **before** sending it to the mirror. | 加密快照必须 早于 将其发送到镜像端。 | 先 加密快照 再将其发送给镜像。 | 整句次序基本正确，但原来只强调 before 的节点变成强调“加密快照”。 模型强调：加密快照 |
| 10 | Use archive_receipt() to archive the receipt **before** notifying the buyer. | 使用 archive_receipt() 归档收据必须 早于 通知买方。 | 使用 archive_receipt() 先 存档回执 再通知买家。 | 整句先归档再通知基本正确，但 before 的强调节点被替换为“存档回执”动作。 模型强调：存档回执 |
| 11 | Seal the partition **after** calculating its digest. | 封闭分区必须 晚于 计算其摘要。 | 先 计算其摘要，再 密封分区。 | 整句先算摘要再封闭分区基本正确，但 after 的强调节点扩大为“计算其摘要，再”整段动作。 模型强调：计算其摘要，再 |
| 12 | Use renew_certificate() to renew the certificate **before** reloading the proxy. | 使用 renew_certificate() 更新证书必须 早于 重新加载代理。 | 使用 renew_certificate() 更新证书， 再重新加载代理。 。 | 整句顺序基本正确，但 before 的强调节点扩大为“再重新加载代理”，改变原文强调范围。 模型强调：再重新加载代理。 |

编号到训练源句 ID（仅用于记录，不必逐字检查标记）：

1. `v6-train-temporal-snapshot-after-code`
2. `v6-train-temporal-receipt-after-code`
3. `v6-train-temporal-partition-after-code`
4. `v6-train-temporal-catalog-after-code`
5. `v6-train-temporal-certificate-after-code`
6. `v6-train-temporal-sample-after-text`
7. `v5-train-certificate-attestations-0-after`
8. `v5-train-nonce-lifetimes-0`
9. `v6-train-temporal-snapshot-before-text`
10. `v6-train-temporal-receipt-before-code`
11. `v6-train-temporal-partition-after-text`
12. `v6-train-temporal-certificate-before-code`
