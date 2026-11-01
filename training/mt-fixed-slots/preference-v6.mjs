// Assistant-authored contrast sets, not independent human translation references.
// Each topic family stays in one split. Positive and negative directions are balanced.
const scenarios = {
  temporal: [
    ["train", "snapshot", "Encrypt the snapshot", "加密快照", "sending it to the mirror", "将其发送到镜像端", "encrypt_snapshot()"],
    ["train", "receipt", "Archive the receipt", "归档收据", "notifying the buyer", "通知买方", "archive_receipt()"],
    ["train", "partition", "Seal the partition", "封闭分区", "calculating its digest", "计算其摘要", "seal_partition()"],
    ["train", "catalog", "Refresh the catalog", "刷新目录", "restarting the search service", "重启搜索服务", "refresh_catalog()"],
    ["train", "certificate", "Renew the certificate", "更新证书", "reloading the proxy", "重新加载代理", "renew_certificate()"],
    ["train", "sample", "Calibrate the sensor", "校准传感器", "recording the next sample", "记录下一个样本", "calibrate_sensor()"],
    ["validation", "volume", "Unmount the volume", "卸载卷", "replacing the storage device", "更换存储设备", "unmount_volume()"],
    ["holdout", "segment", "Compress the segment", "压缩数据段", "copying it to cold storage", "将其复制到冷存储", "compress_segment()"],
  ],
  polarity: [
    ["train", "gateway", "gateway controller", "网关控制器", "accept unsigned requests", "接受未签名请求"],
    ["train", "printer", "print scheduler", "打印调度器", "restart interrupted jobs", "重启中断的作业"],
    ["train", "indexer", "document indexer", "文档索引器", "reuse expired credentials", "复用过期凭据"],
    ["train", "uploader", "image uploader", "图像上传器", "overwrite existing albums", "覆盖现有相册"],
    ["train", "router", "request router", "请求路由器", "discard queued replies", "丢弃排队中的回复"],
    ["train", "mixer", "audio mixer", "音频混音器", "retain silent tracks", "保留静音轨道"],
    ["validation", "resolver", "name resolver", "名称解析器", "cache failed lookups", "缓存失败的查询"],
    ["holdout", "scanner", "package scanner", "软件包扫描器", "skip archived dependencies", "跳过已归档的依赖项"],
  ],
  roles: [
    ["train", "crawler", "crawler", "爬虫", "watchdog worker", "看门狗工作线程", "halt()"],
    ["train", "parser", "syntax parser", "语法解析器", "deadline monitor", "截止时间监控器", "abort_parse()"],
    ["train", "recorder", "event recorder", "事件记录器", "storage supervisor", "存储监督器", "stop_recording()"],
    ["train", "builder", "package builder", "软件包构建器", "build coordinator", "构建协调器", "cancel_build()"],
    ["train", "fetcher", "asset fetcher", "资源获取器", "transfer monitor", "传输监控器", "stop_fetching()"],
    ["train", "executor", "query executor", "查询执行器", "query supervisor", "查询监督器", "interrupt_query()"],
    ["validation", "analyzer", "trace analyzer", "跟踪分析器", "analysis coordinator", "分析协调器", "stop_analysis()"],
    ["holdout", "renderer", "scene renderer", "场景渲染器", "frame supervisor", "帧监督器", "cancel_frame()"],
  ],
  tool: [
    ["train", "report", "Encode the report", "编码报告", "encode_report()", "report_id", "report identifier", "报告标识符", "a recorder", "记录器", "collecting readings", "收集读数", "start_recording()"],
    ["train", "packet", "Inspect the packet", "检查数据包", "inspect_packet()", "packet_id", "packet identifier", "数据包标识符", "a listener", "监听器", "receiving packets", "接收数据包", "start_listening()"],
    ["train", "image", "Rotate the image", "旋转图像", "rotate_image()", "image_id", "image identifier", "图像标识符", "an image worker", "图像工作线程", "processing images", "处理图像", "start_processing()"],
    ["train", "invoice", "Sign the invoice", "签署发票", "sign_invoice()", "invoice_id", "invoice identifier", "发票标识符", "a verifier", "验证器", "checking signatures", "检查签名", "start_verifying()"],
    ["train", "message", "Filter the message", "筛选消息", "filter_message()", "message_id", "message identifier", "消息标识符", "a dispatcher", "分发器", "forwarding messages", "转发消息", "start_dispatching()"],
    ["train", "record", "Normalize the record", "规范化记录", "normalize_record()", "record_id", "record identifier", "记录标识符", "a sampler", "采样器", "collecting measurements", "收集测量值", "start_sampling()"],
    ["validation", "document", "Render the document", "渲染文档", "render_document()", "document_id", "document identifier", "文档标识符", "a preview worker", "预览工作线程", "generating previews", "生成预览", "start_previewing()"],
    ["holdout", "bundle", "Package the bundle", "打包资源包", "package_bundle()", "bundle_id", "bundle identifier", "资源包标识符", "a deployment worker", "部署工作线程", "distributing bundles", "分发资源包", "start_distributing()"],
  ],
};

export function preferenceCases() {
  const result = [];
  function add(category, split, topic, variant, html, chosen, rejected, fact, corruption, checks) {
    result.push({id: `v6-${split}-${category}-${topic}-${variant}`, split, family: `v6-${category}-${topic}`,
      category: `semantic_preference_${category}`, html, context_url: "https://example.com/pagelingo-preference-v6",
      origin: {kind: "authored"}, review_status: "assistant_audited_synthetic", reference_slots: chosen,
      rejected_slots: rejected, semantic_contract: fact, rejected_error: corruption, semantic_checks: checks, probes: []});
  }
  for (const [split, topic, en, zh, laterEn, laterZh, code] of scenarios.temporal) {
    for (const direction of ["before", "after"]) for (const protectedCode of [false, true]) {
      const word = direction === "before" ? "早于" : "晚于", wrong = direction === "before" ? "晚于" : "早于";
      const html = `<p>${protectedCode ? `Use <code>${code}</code> to ${en.toLowerCase()}` : en} <em>${direction}</em> ${laterEn}.</p>`;
      const chosen = [...(protectedCode ? ["使用"] : []), `${zh}必须`, word, `${laterZh}。`];
      const rejected = chosen.map((text, index) => index === chosen.length - 2 ? wrong : text);
      add("temporal", split, topic, `${direction}-${protectedCode ? "code" : "text"}`, html, chosen, rejected,
        `${en} ${direction} ${laterEn}`, "Reversed the temporal relation while retaining the frame and actions",
        [{slot: chosen.length - 2, chosen: word, rejected: wrong}]);
    }
  }
  for (const [split, topic, en, zh, actionEn, actionZh] of scenarios.polarity) {
    for (const negative of [false, true]) {
      const tail = `必须${negative ? "不得" : ""}${actionZh}。`.replace("必须不得", "不得");
      const wrong = `${negative ? "必须" : "不得"}${actionZh}。`;
      add("polarity", split, topic, negative ? "forbid" : "require", `<p>The <strong>${en}</strong> must${negative ? " not" : ""} ${actionEn}.</p>`,
        ["", zh, tail], ["", zh, wrong], `${negative ? "Forbidden" : "Required"}: ${actionEn}`, "Reversed obligation and prohibition",
        [{slot: 2, chosen: tail, rejected: wrong}]);
    }
    for (const success of [false, true]) {
      const conditionEn = success ? "succeeds" : "fails", conditionZh = success ? "成功" : "失败";
      const state = success ? "启用" : "禁用", wrong = success ? "禁用" : "启用";
      add("polarity", split, topic, success ? "success" : "failure", `<p>If the inspection ${conditionEn}, keep the <a href="/components/${topic}">${en}</a> ${success ? "enabled" : "disabled"}.</p>`,
        [`检查${conditionZh}时，让`, zh, `保持${state}。`], [`检查${conditionZh}时，让`, zh, `保持${wrong}。`],
        `Inspection ${conditionEn}: remain ${success ? "enabled" : "disabled"}`, "Reversed the required state in a condition",
        [{slot: 2, chosen: `保持${state}。`, rejected: `保持${wrong}。`}]);
    }
  }
  for (const [split, topic, ownerEn, ownerZh, recipientEn, recipientZh, code] of scenarios.roles) {
    const pass = [`将${ownerZh}及其已经绑定的`, `方法一起交给${recipientZh}。`], bind = [`将${ownerZh}的`, `方法绑定到${recipientZh}。`];
    add("roles", split, topic, "pass-bound", `<p>Pass the ${ownerEn} and its already-bound <code>${code}</code> method to the ${recipientEn}.</p>`,
      pass, bind, `Pass the owner's already-bound method to the recipient; do not rebind it`, "Turned passing an already-bound method into rebinding",
      [{slot: 1, chosen: pass[1], rejected: bind[1]}]);
    add("roles", split, topic, "bind", `<p>Bind the ${ownerEn}'s <code>${code}</code> method to the ${recipientEn}.</p>`,
      bind, pass, "Bind the method to the recipient", "Turned binding into passing an already-bound method",
      [{slot: 1, chosen: bind[1], rejected: pass[1]}]);
    for (const reverse of [false, true]) {
      const [firstEn, firstZh, secondEn, secondZh] = reverse ? [ownerEn, ownerZh, recipientEn, recipientZh] : [recipientEn, recipientZh, ownerEn, ownerZh];
      add("roles", split, topic, reverse ? "owner-waits" : "recipient-waits", `<p>During shutdown, the <a href="/waiter">${firstEn}</a> waits for the <strong>${secondEn}</strong> to stop.</p>`,
        ["关闭期间，", firstZh, "等待", secondZh, "停止。"], ["关闭期间，", firstZh, "的停止会被", secondZh, "等待。"],
        `${firstEn} waits for ${secondEn}, not conversely`, "Reversed who waits for whom without moving the labels",
        [{slot: 2, chosen: "等待", rejected: "的停止会被"}]);
    }
  }
  for (const [split, topic, actionEn, actionZh, code, literal, labelEn, labelZh, actorEn, actorZh, activityEn, activityZh, startCode] of scenarios.tool) {
    const tool = `${actionZh}，使用的是`, object = `读取${labelZh}，其内容为`;
    add("tool", split, topic, "tool", `<p>${actionEn} using <code>${code}</code>.</p>`, [tool], [`要${actionZh}的内容是`],
      `${code} is the tool used to ${actionEn.toLowerCase()}`, "Turned the operation's tool into its object",
      [{slot: 0, chosen: tool, rejected: `要${actionZh}的内容是`}]);
    add("tool", split, topic, "object", `<p>Read the ${labelEn} <code>${literal}</code>.</p>`, [object], [`读取${labelZh}，使用的是`],
      `${literal} is the identifier to read`, "Turned the object being read into a tool",
      [{slot: 0, chosen: object, rejected: `读取${labelZh}，使用的是`}]);
    for (const negative of [false, true]) {
      const chosen = `该示例会创建${actorZh}${negative ? "，但不会" : "并开始"}${activityZh}，使用的是`;
      const rejected = `该示例会创建${actorZh}${negative ? "并开始" : "，但不会"}${activityZh}，使用的是`;
      add("tool", split, topic, negative ? "create-without-start" : "create-and-start",
        `<p>The example creates ${actorEn} ${negative ? `but does not start ${activityEn}` : `and begins ${activityEn}`} with <code>${startCode}</code>:</p>`,
        [chosen], [rejected], `Create ${actorEn}; ${negative ? "do not start" : "start"} ${activityEn}`,
        "Added or removed the second action while preserving the protected final tool", [{slot: 0, chosen, rejected}]);
    }
  }
  return result;
}

export function assertPreferenceReference(sample) {
  if (!sample.semantic_checks?.length || sample.reference_slots.length !== sample.rejected_slots.length) throw new Error("Missing semantic contrast");
  for (const check of sample.semantic_checks) {
    if (sample.reference_slots[check.slot] !== check.chosen || sample.rejected_slots[check.slot] !== check.rejected || check.chosen === check.rejected)
      throw new Error("Changed declared semantic contrast: " + sample.id);
  }
}
