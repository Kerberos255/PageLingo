// Authored fixed-slot supervision. References are not independently human reviewed.
const cases = [];
function add(split, family, key, html, natural, slots, facts, contracts) {
  cases.push({id: `v5-${split}-${family}-${key}`, split, family: `v5-${family}`, category: "corrective-fixed",
    html, natural_reference: natural, reference_slots: slots, semantic_facts: facts,
    slot_contracts: contracts.map(([slot, ...required]) => ({slot, required})),
    context_url: "https://example.com/pagelingo-v5-authored", origin: {kind: "authored"},
    probes: contracts.map(([slot, ...required], index) => ({id: `declared-${index}`, slot,
      any: required.length === 1 ? required : undefined, description: "Authored lexical probe; not a semantic equivalence test"})).filter(p => p.any),
    review_status: "assistant_audited_synthetic"});
}

// All actions must precede the final immutable code. There is no trailing Text
// owner in which to hide a verb after the class name.
const tails = [
  ["train", "batch-descriptors", [
    ["The batch initializer parses the rows, validates their schema, and constructs", "BatchDescriptor", "批次初始化器会解析各行、验证其模式并执行构造，构造的对象是", ["解析", "验证", "构造"]],
    ["The import routine decodes the header, checks its version, and registers", "ImportDescriptor", "导入例程会解码头部、检查版本并执行注册，注册的对象是", ["解码", "检查", "注册"]],
    ["The export routine collects the columns, assigns their types, and creates", "ExportDescriptor", "导出例程会收集各列、指定其类型并执行创建，创建的对象是", ["收集", "指定", "创建"]],
    ["The batch planner counts the fragments, sorts their offsets, and initializes", "FragmentPlan", "批次规划器会统计片段、排序其偏移量并执行初始化，初始化的对象是", ["统计", "排序", "初始化"]],
  ]],
  ["train", "transport-builders", [
    ["This transport example reserves a port, sets its timeout, and instantiates", "PortBinding", "这个传输示例会预留端口、设置超时并实例化，实例化的对象是", ["预留", "设置", "实例化"]],
    ["The connection bootstrap checks the route, loads the credentials, and constructs", "RouteSession", "连接引导流程会检查路由、加载凭据并执行构造，构造的对象是", ["检查", "加载", "构造"]],
    ["The multiplexing example enumerates the streams, allocates their buffers, and configures", "StreamMux", "这个多路复用示例会枚举数据流、分配缓冲区并执行配置，配置的对象是", ["枚举", "分配", "配置"]],
    ["The handshake routine compares the protocols, chooses a cipher, and creates", "HandshakeState", "握手例程会比较协议、选择密码套件并执行创建，创建的对象是", ["比较", "选择", "创建"]],
  ]],
  ["train", "document-indexers", [
    ["The document loader reads the sections, extracts their titles, and initializes", "SectionIndex", "文档加载器会读取章节、提取标题并执行初始化，初始化的对象是", ["读取", "提取", "初始化"]],
    ["The search example normalizes the tokens, removes duplicate terms, and builds", "SearchTable", "这个搜索示例会规范化词元、移除重复词条并执行构建，构建的对象是", ["规范化", "移除", "构建"]],
    ["The citation routine resolves the authors, checks the publication year, and registers", "CitationRecord", "引文例程会解析作者、检查出版年份并执行注册，注册的对象是", ["解析", "检查", "注册"]],
    ["The outline builder scans the chapters, groups related sections, and instantiates", "OutlineTree", "大纲构建器会扫描章节、归并相关小节并执行实例化，实例化的对象是", ["扫描", "归并", "实例化"]],
  ]],
  ["train", "telemetry-assemblers", [
    ["The telemetry collector reads the counters, converts their units, and creates", "MetricBatch", "遥测收集器会读取计数器、转换单位并执行创建，创建的对象是", ["读取", "转换", "创建"]],
    ["The trace sampler groups the spans, attaches timestamps, and constructs", "TraceEnvelope", "跟踪采样器会归并跨度、附加时间戳并执行构造，构造的对象是", ["归并", "附加", "构造"]],
    ["The diagnostic routine collects the errors, removes private fields, and initializes", "DiagnosticBundle", "诊断例程会收集错误、移除私密字段并执行初始化，初始化的对象是", ["收集", "移除", "初始化"]],
    ["The aggregation example checks the interval, sums the samples, and configures", "WindowSummary", "这个聚合示例会检查间隔、累加样本并执行配置，配置的对象是", ["检查", "累加", "配置"]],
  ]],
  ["validation", "graph-assemblers", [
    ["The graph loader reads the vertices, rejects duplicate edges, and constructs", "GraphView", "图加载器会读取顶点、拒绝重复边并执行构造，构造的对象是", ["读取", "拒绝", "构造"]],
    ["The path routine checks the weights, finds the start vertex, and initializes", "PathCursor", "路径例程会检查权重、查找起始顶点并执行初始化，初始化的对象是", ["检查", "查找", "初始化"]],
  ]],
  ["holdout", "media-assemblers", [
    ["The audio loader reads the channels, validates the sample rate, and creates", "AudioLayout", "音频加载器会读取声道、验证采样率并执行创建，创建的对象是", ["读取", "验证", "创建"]],
    ["The video example selects the tracks, aligns their timestamps, and initializes", "VideoTimeline", "这个视频示例会选择轨道、对齐时间戳并执行初始化，初始化的对象是", ["选择", "对齐", "初始化"]],
  ]],
];
for (const [split, family, rows] of tails) for (const [index, [source, code, prefix, words]] of rows.entries()) {
  add(split, family, String(index), `<p>${source} <a href="/class"><code>${code}</code></a>:</p>`,
    `${prefix} ${code}：`, [prefix], [{type: "complete_actions", english: source, required_chinese_actions: words, final_code: code}], [[0, ...words]]);
}

// An explicit 早于/晚于 label owns the temporal relation. The event itself must
// remain outside the emphasis, with both action and object retained before it.
const temporal = [
  ["train", "certificate-attestations", "accepting the certificate", "接受证书", "An issuer name alone is not an attestation", "只有签发者名称并不构成证明", [
    ["persist the attestation", "持久保存证明", "save_attestation()"], ["record the issuer identifier", "记录签发者标识", "note_issuer()"]]],
  ["train", "replica-notifications", "notifying the replica", "通知副本", "A notification is not a durable snapshot", "通知不等于持久快照", [
    ["seal the snapshot", "封存快照", "seal_image()"], ["write the snapshot manifest", "写入快照清单", "write_image_manifest()"]]],
  ["train", "dispatcher-ownership", "replacing the dispatcher", "替换分派器", "Replacing a dispatcher does not transfer ownership", "替换分派器不会转移所有权", [
    ["detach the callback", "分离回调", "detach_callback()"], ["record the callback owner", "记录回调所有者", "note_callback_owner()"]]],
  ["train", "debit-journals", "acknowledging the transfer", "确认转账", "An acknowledgment does not repair an unflushed journal", "确认不会修复尚未刷盘的日志", [
    ["flush the debit journal", "将借记日志刷盘", "flush_debit()"], ["record the debit balance", "记录借记余额", "note_debit_balance()"]]],
  ["validation", "sensor-warnings", "queuing the warning", "将警告加入队列", "A warning does not replace the sensor frame", "警告不能替代传感器帧", [
    ["store the sensor frame", "存储传感器帧", "store_sensor_frame()"]]],
  ["holdout", "tile-previews", "publishing the preview", "发布预览", "A preview is not the complete tile index", "预览不等于完整的图块索引", [
    ["seal the tile index", "封存图块索引", "seal_tile_index()"]]],
];
for (const [split, family, event, eventCn, tail, tailCn, actions] of temporal) for (const [index, [action, actionCn, fn]] of actions.entries()) {
  for (const [relation, word, cn] of [["before", "之前", "早于"], ["after", "之后", "晚于"]]) {
    add(split, family, `${index}-${relation}`, `<p>Use <code>${fn}</code> to ${action} <strong>${relation}</strong> ${event}. ${tail}.</p>`,
      `在${eventCn}${word}，调用 ${fn} ${actionCn}。${tailCn}。`,
      ["调用", `${actionCn}；这一操作的时机必须`, cn, `${eventCn}。${tailCn}。`],
      [{type: "action_object", action, chinese: actionCn}, {type: "order", first: action, relation, second: event}, {type: "negation", claim: tail}],
      [[1, actionCn], [2, cn], [3, eventCn, tailCn]]);
  }
}

// Linked and emphasized ranges carry complete verbs and objects, not generic
// connectives. Minimal contrasts include authorization, retry and nonce meaning.
const ranges = [
  ["train", "transfer-retries", [
    ["If the transfer error is retriable", "转账错误可重试时", "requeue the pending transfer", "将待处理转账重新入队", "retain the attempt counter", "保留尝试计数器", "A retriable error is not a completed transfer", "可重试错误不等于转账完成"],
    ["If the transfer error is permanent", "转账错误是永久错误时", "reject the pending transfer", "拒绝待处理转账", "stop the retry timer", "停止重试计时器", "A permanent error must not trigger another automatic attempt", "永久错误不得触发另一次自动尝试"],
    ["When the transfer deadline has expired", "转账截止时间已过时", "remove the queued transfer", "移除排队中的转账", "record the timeout reason", "记录超时原因", "Removing a queued transfer does not debit the account", "移除排队中的转账不会扣减账户资金"],
    ["When the transfer remains within its deadline", "转账仍未超过截止时间时", "keep the queued transfer", "保留排队中的转账", "preserve the original request identifier", "保留原始请求标识", "A queued transfer is not yet a settled transfer", "排队中的转账尚不等于已结算的转账"],
  ]],
  ["train", "permission-prompts", [
    ["If the owner grants consent", "所有者同意时", "enable the read-only view", "启用只读视图", "keep editing disabled", "继续禁用编辑", "Read permission does not imply write permission", "读取权限不意味着写入权限"],
    ["If the owner refuses consent", "所有者拒绝同意时", "hide the private view", "隐藏私密视图", "remove the temporary grant", "移除临时授权", "A refusal is not an authorization", "拒绝不等于授权"],
    ["When the consent request expires", "同意请求过期时", "close the permission prompt", "关闭权限提示", "leave the resource locked", "保持资源锁定", "An expired request does not count as consent", "请求过期不能算作同意"],
    ["While the consent request is pending", "同意请求仍在等待时", "display the pending status", "显示等待状态", "do not unlock the resource", "不要解锁资源", "Waiting is not permission to read private data", "等待不意味着获准读取私密数据"],
  ]],
  ["train", "nonce-lifetimes", [
    ["Once the challenge has been answered", "质询得到应答后", "discard the spent nonce", "丢弃已使用的随机数", "generate a fresh nonce", "生成新的随机数", "A nonce is a one-use random value, not an asymmetric key", "随机数是一次性随机值，而不是非对称密钥"],
    ["While the challenge is unanswered", "质询尚未得到应答时", "keep the pending nonce", "保留待使用的随机数", "do not reuse it for another challenge", "不要将它复用于另一个质询", "An unanswered challenge does not make its nonce an encryption key", "质询尚未得到应答并不会使其随机数变成加密密钥"],
    ["If the reply carries the wrong nonce", "应答携带错误随机数时", "reject the mismatched reply", "拒绝不匹配的应答", "retain the expected nonce", "保留预期的随机数", "A wrong nonce is not proof of the expected challenge", "错误随机数不能证明预期的质询"],
    ["If the reply carries the expected nonce", "应答携带预期随机数时", "mark the challenge as answered", "将质询标为已应答", "retire that nonce", "停用该随机数", "A matching nonce must not be treated as a reusable password", "匹配的随机数不得被视为可重复使用的密码"],
  ]],
  ["train", "routing-identities", [
    ["If the origin header is present", "存在来源头部时", "verify the claimed origin", "验证所声明的来源", "keep the peer address separate", "单独保留对端地址", "A claimed origin is not a verified peer address", "所声明的来源不等于已验证的对端地址"],
    ["If the origin header is missing", "缺少来源头部时", "reject the origin-dependent request", "拒绝依赖来源的请求", "record the missing-header reason", "记录缺少头部的原因", "An absent header must not be replaced with a guessed identity", "缺少的头部不得用猜测的身份替代"],
    ["When the route identifier is malformed", "路由标识格式错误时", "stop the route lookup", "停止路由查找", "retain the original identifier in the diagnostic", "在诊断中保留原始标识", "A malformed identifier is not a valid default route", "格式错误的标识不等于有效的默认路由"],
    ["When the route identifier is valid", "路由标识有效时", "look up the requested route", "查找所请求的路由", "do not rewrite the request identifier", "不要改写请求标识", "Finding a route does not authorize changing the request", "找到路由并不授权修改请求"],
  ]],
  ["validation", "manifest-decisions", [
    ["If the manifest length is invalid", "清单长度无效时", "reject the manifest", "拒绝清单", "retain the length diagnostic", "保留长度诊断", "A rejected manifest must not become the active manifest", "被拒绝的清单不得成为活动清单"],
    ["If the manifest length is valid", "清单长度有效时", "inspect the manifest entries", "检查清单条目", "keep the current manifest active", "保持当前清单处于活动状态", "Valid length alone does not prove the entries are valid", "只有长度有效并不能证明条目有效"],
  ]],
  ["holdout", "reservation-intents", [
    ["If the customer withdraws the request", "客户撤回请求时", "cancel the tentative reservation", "取消暂定预订", "refund the deposit", "退还押金", "Cancelling a tentative reservation is not a new purchase", "取消暂定预订不等于新购买"],
    ["If the customer confirms the request", "客户确认请求时", "confirm the tentative reservation", "确认暂定预订", "retain the existing payment", "保留已有付款", "Confirmation does not authorize charging the customer twice", "确认不意味着获准向客户收费两次"],
  ]],
];
for (const [split, family, rows] of ranges) for (const [index, [condition, conditionCn, action, actionCn, other, otherCn, tail, tailCn]] of rows.entries()) {
  add(split, family, String(index), `<p>${condition}, <a href="/action">${action}</a> and <em>${other}</em>. ${tail}.</p>`,
    `${conditionCn}，${actionCn}并${otherCn}。${tailCn}。`, [conditionCn + "，", actionCn, "并", otherCn, "。" + tailCn + "。"],
    [{type: "conditional_actions", condition, actions: [action, other]}, {type: "distinction", claim: tail}], [[1, actionCn], [3, otherCn], [4, tailCn]]);
}

// Passing an existing/bound callable is not binding or invoking it. Two distinct
// receiver labels per family test participant ownership independently of code.
const callables = [
  ["train", "parser-handoff", "read_frame()", "frame_callback", [["the frame decoder", "帧解码器"], ["the payload inspector", "载荷检查器"]]],
  ["train", "cache-notifiers", "notify_entry()", "entry_callback", [["the eviction monitor", "逐出监视器"], ["the reload coordinator", "重新加载协调器"]]],
  ["train", "timer-subscribers", "stop_tick()", "tick_callback", [["the deadline monitor", "截止时间监视器"], ["the alarm collector", "警报收集器"]]],
  ["train", "writer-delegates", "flush_patch()", "patch_callback", [["the patch writer", "补丁写入器"], ["the disk inspector", "磁盘检查器"]]],
  ["validation", "stream-relays", "relay_sample()", null, [["the sample subscriber", "样本订阅器"], ["the stream auditor", "数据流审计器"]]],
  ["holdout", "metric-exporters", "export_metric()", null, [["the statistics sink", "统计接收器"], ["the anomaly guard", "异常防护器"]]],
];
for (const [split, family, method, reference, receivers] of callables) for (const [index, [receiver, receiverCn]] of receivers.entries()) {
  add(split, family, `bound-${index}`, `<p>Pass the already-bound <code>${method}</code> method to <a href="/receiver">${receiver}</a>; do not <em>bind it again</em>.</p>`,
    `将已经绑定的 ${method} 方法传给${receiverCn}；不要再次绑定该方法。`, ["将已经绑定的", "方法传给", receiverCn, "；不要", "再次绑定该方法"],
    [{type: "transfer_callable", object: method, receiver, forbidden_action: "bind it again"}], [[0, "已经绑定"], [1, "方法", "传给"], [2, receiverCn], [3, "不要"], [4, "再次绑定"]]);
  if (reference) add(split, family, `reference-${index}`, `<p>Send the existing <code>${reference}</code> function reference to <a href="/receiver">${receiver}</a>; do not <em>invoke it during transfer</em>.</p>`,
    `将现有的 ${reference} 函数引用发送给${receiverCn}；不要在传递过程中调用它。`, ["将现有的", "函数引用发送给", receiverCn, "；不要", "在传递过程中调用它"],
    [{type: "transfer_callable", object: reference, receiver, forbidden_action: "invoke it during transfer"}], [[1, "函数引用", "发送给"], [2, receiverCn], [3, "不要"], [4, "调用"]]);
}

export function correctiveCases() {return structuredClone(cases);}
export function assertCorrectiveReference(sample) {
  if (!sample.semantic_facts?.length || !sample.natural_reference?.trim() || !sample.slot_contracts?.length) throw new Error("Missing corrective meaning/ownership declaration");
  for (const rule of sample.slot_contracts) if (rule.required.some(term => !sample.reference_slots[rule.slot]?.includes(term)))
    throw new Error("Missing declared action or range: " + sample.id);
}
