// Authored synthetic pairs, not independently human-reviewed translations.
// Different views of a case are not independent examples. Never train holdout.
const cases = [];
function add(split, family, key, html, natural, slots, facts, checks = [], badDraft) {
  cases.push({id: `v4-${split}-${family}-${key}`, split, family: `v4-${family}`, category: "semantic-rewrite",
    html, natural_reference: natural, reference_slots: slots, semantic_facts: facts,
    slot_contracts: checks.map(([slot, ...required]) => ({slot, required})),
    ...(badDraft ? {contrastive_draft: badDraft} : {}),
    context_url: "https://example.com/pagelingo-v4-authored", origin: {kind: "authored"},
    probes: [], review_status: "assistant_audited_synthetic"});
}
for (const [word, relation, cn, natural, bad] of [
  ["before", "before", "早于", "监听器注册其处理程序之前，调用 push_notice() 发送通知。", "监听器注册其处理程序之后，调用 push_notice() 发送通知。"],
  ["after", "after", "晚于", "监听器注册其处理程序之后，调用 push_notice() 发送通知。"],
]) add("train", "notice-registration", word,
  `<p>Use <code>push_notice()</code> to send the notice <em>${word}</em> <a href="/listener">the listener</a> registers its handler.</p>`,
  natural, ["调用", "发送通知；发送通知的时机必须", cn, "监听器", "注册其处理程序。"],
  [{type: "order", first: "send notice", relation, second: "listener registers handler"}, {type: "action", verb: "send", object: "notice"}],
  [[1, "发送", "通知"], [2, cn], [3, "监听器"]], bad);
for (const [word, relation, cn, natural] of [
  ["before", "before", "早于", "向客户端确认之前，使用 persist_reply() 存储响应。"],
  ["after", "after", "晚于", "向客户端确认之后，使用 persist_reply() 存储响应。"],
]) add("train", "response-storage", word,
  `<p>Use <code>persist_reply()</code> to store the response <strong>${word}</strong> <a href="/ack">acknowledging the client</a>.</p>`,
  natural, ["调用", "存储响应；存储响应的时机必须", cn, "向客户端确认"], [{type: "order", first: "store response", relation, second: "acknowledge client"}],
  [[1, "存储", "响应"], [2, cn], [3, "客户端", "确认"]]);
for (const [modal, target, negative, natural, bad] of [
  ["must not", "不得", true, "pinned 为真时，不得移除缓存条目。", "pinned 为真时，必须移除缓存条目。"],
  ["must", "必须", false, "pinned 为真时，必须移除缓存条目。"],
]) add("train", "pinned-cache", negative ? "prohibit" : "require",
  `<p>The <a href="/entry">cache entry</a> <em>${modal}</em> be removed when <code>pinned</code> is true.</p>`,
  natural, ["对于", "缓存条目", target, "在", "为真时移除。"], [{type: "modality", predicate: "remove cache entry", negative, condition: "pinned=true"}],
  [[1, "缓存", "条目"], [2, target], [4, "移除"]], bad);
for (const [result, cn, natural] of [
  ["succeeds", "成功", "仅当 validate_signature() 成功时，才记录该结果。"],
  ["fails", "失败", "仅当 validate_signature() 失败时，才记录该结果。"],
]) add("train", "conditional-record", result,
  `<p>Record the <a href="/result">verification result</a> only if <code>validate_signature()</code> ${result}.</p>`,
  natural.replace("该结果", "验证结果"), ["记录", "验证结果", "的必要条件是", `${cn}。`],
  [{type: "condition", action: "record verification result", only_if: `validate_signature() ${result}`}], [[0, "记录"], [1, "验证结果"], [3, cn]]);
add("train", "code-tail-actions", "workers",
  '<p>This example creates and launches two workers using <a href="/pool"><code>WorkerPool</code></a>:</p>',
  "这个示例使用 WorkerPool 创建并启动两个工作线程：", ["这个示例会创建并启动两个工作线程，使用的是"],
  [{type: "actions", verbs: ["create", "launch"], object: "two workers", tool: "WorkerPool"}], [[0, "创建", "启动", "两个", "工作线程"]],
  "这个示例使用 WorkerPool 管理两个工作线程：");
add("train", "code-tail-actions", "channel",
  '<p>This snippet opens and configures a channel through <a href="/channel"><code>Channel</code></a>:</p>',
  "这段代码通过 Channel 打开并配置一个通道：", ["这段代码会打开并配置一个通道，所用类为"],
  [{type: "actions", verbs: ["open", "configure"], object: "a channel", tool: "Channel"}], [[0, "打开", "配置", "通道"]]);
add("train", "copy-direction", "to-audit",
  '<p>Copy the record from <a href="/staging">the staging log</a> to <a href="/audit">the audit log</a> without deleting the source copy.</p>',
  "将记录从暂存日志复制到审计日志，不要删除源副本。", ["将记录从", "暂存日志", "复制到", "审计日志", "，不要删除源副本。"],
  [{type: "transfer", verb: "copy", from: "staging log", to: "audit log", source_retained: true}], [[1, "暂存日志"], [2, "复制"], [3, "审计日志"]],
  "将记录从审计日志复制到暂存日志，不要删除源副本。");
add("train", "copy-direction", "to-staging",
  '<p>Copy the record from <a href="/audit">the audit log</a> to <a href="/staging">the staging log</a> and retain the original.</p>',
  "将记录从审计日志复制到暂存日志，并保留原件。", ["将记录从", "审计日志", "复制到", "暂存日志", "，并保留原件。"],
  [{type: "transfer", verb: "copy", from: "audit log", to: "staging log", source_retained: true}], [[1, "审计日志"], [2, "复制"], [3, "暂存日志"]]);
add("train", "copy-versus-move", "copy",
  '<p><a href="/copy">Copy the snapshot</a> into <code>backup.bin</code>; the original must remain available.</p>',
  "将快照复制到 backup.bin，原件必须保持可用。", ["复制快照", "并存入", "；原件必须保持可用。"],
  [{type: "transfer", verb: "copy", object: "snapshot", to: "backup.bin", source_retained: true}], [[0, "复制", "快照"], [2, "原件", "可用"]]);
add("train", "copy-versus-move", "move",
  '<p><a href="/move">Move the snapshot</a> into <code>archive.bin</code>; the old location must no longer hold a copy.</p>',
  "将快照移动到 archive.bin，旧位置不得再保留副本。", ["移动快照", "并存入", "；旧位置不得再保留副本。"],
  [{type: "transfer", verb: "move", object: "snapshot", to: "archive.bin", source_retained: false}], [[0, "移动", "快照"], [2, "不得", "副本"]]);
add("train", "nonce-and-digest", "nonce",
  '<p>The <a href="/nonce">challenge nonce</a> is a one-use random value, not <em>an encryption key</em>.</p>',
  "质询随机数是仅使用一次的随机值，不是加密密钥。", ["该", "质询随机数", "是仅使用一次的随机值，不是", "加密密钥"],
  [{type: "distinction", subject: "challenge nonce", is: "one-use random value", is_not: "encryption key"}], [[1, "质询", "随机数"], [2, "一次", "不是"], [3, "加密密钥"]],
  "质询随机数是一种非对称加密密钥。");
add("train", "nonce-and-digest", "digest",
  '<p>The <a href="/digest">content digest</a> detects changed bytes; it does not <em>encrypt the payload</em>.</p>',
  "内容摘要用于检测字节变化，它不会加密载荷。", ["该", "内容摘要", "用于检测字节变化，它不会", "加密载荷"],
  [{type: "distinction", subject: "content digest", does: "detect changed bytes", does_not: "encrypt payload"}], [[1, "内容摘要"], [2, "检测", "不会"], [3, "加密", "载荷"]]);
add("train", "cancellation-state", "committed",
  '<p>Cancelling <a href="/caller">the waiting caller</a> does not undo <code>commit_record()</code>.</p>',
  "取消等待中的调用者不会撤销 commit_record()。", ["取消", "等待中的调用者", "不会撤销"],
  [{type: "negation", action: "cancel waiting caller", does_not: "undo commit_record()"}], [[1, "等待", "调用者"], [2, "不会", "撤销"]]);
add("train", "cancellation-state", "pending",
  '<p>Cancelling <a href="/operation">the pending operation</a> prevents <code>commit_record()</code> from starting.</p>',
  "取消待执行的操作会阻止 commit_record() 开始执行。", ["取消", "待执行的操作", "会阻止", "开始执行。"],
  [{type: "prevention", action: "cancel pending operation", prevents: "start commit_record()"}], [[1, "待执行", "操作"], [2, "阻止"], [3, "开始"]]);
add("train", "count-and-role", "ceiling",
  '<p>The queue accepts <strong>at most two</strong> items from <a href="/producer">each producer</a>.</p>',
  "队列从每个生产者接受的条目最多为两个。", ["队列接受的条目数量", "最多为两个", "；这一上限适用于", "每个生产者"],
  [{type: "bound", maximum: 2, unit: "items", scope: "each producer"}], [[1, "最多", "两个"], [3, "每个", "生产者"]],
  "队列从每个生产者接受的条目至少为两个。");
add("train", "count-and-role", "floor",
  '<p>The queue requires <strong>at least two</strong> acknowledgements from <a href="/replicas">different replicas</a>.</p>',
  "队列要求来自不同副本的确认至少为两次。", ["队列要求确认数量", "至少为两次", "；确认必须来自", "不同副本"],
  [{type: "bound", minimum: 2, unit: "acknowledgements", scope: "different replicas"}], [[1, "至少", "两次"], [3, "不同", "副本"]]);
add("train", "measurement-units", "bytes",
  '<p>Limit the <a href="/length">payload length</a> to <code>64</code> bytes, not Unicode characters.</p>',
  "将载荷长度限制为 64 字节，而不是 Unicode 字符。", ["将", "载荷长度", "限制为", "字节，而不是 Unicode 字符。"],
  [{type: "measurement", object: "payload length", limit: 64, unit: "bytes", not_unit: "Unicode characters"}], [[1, "载荷", "长度"], [3, "字节", "不是", "字符"]]);
add("train", "measurement-units", "characters",
  '<p>Measure the <a href="/width">label width</a> in Unicode characters, not <code>UTF-8</code> bytes.</p>',
  "测量标签宽度时按 Unicode 字符计量，而不是按 UTF-8 字节计量。", ["测量", "标签宽度", "时按 Unicode 字符计量，而不是按", "字节计量。"],
  [{type: "measurement", object: "label width", unit: "Unicode characters", not_unit: "UTF-8 bytes"}], [[1, "标签宽度"], [2, "字符", "不是"]]);
add("train", "linked-action-extent", "refresh",
  '<p>Before retrying, <a href="/refresh">refresh the access token</a> and <em>discard the old nonce</em>.</p>',
  "重试之前，刷新访问令牌并丢弃旧的随机数。", ["重试之前，", "刷新访问令牌", "并", "丢弃旧的随机数"],
  [{type: "actions", verbs: ["refresh", "discard"], objects: ["access token", "old nonce"], before: "retry"}], [[1, "刷新", "访问令牌"], [3, "丢弃", "旧", "随机数"]],
  "重试之前，刷新访问令牌并保留旧的随机数。");
add("train", "linked-action-extent", "resume",
  '<p>After recovery, <a href="/resume">resume the paused consumer</a> and <em>keep the existing offset</em>.</p>',
  "恢复之后，继续运行已暂停的消费者并保留现有偏移量。", ["恢复之后，", "继续运行已暂停的消费者", "并", "保留现有偏移量"],
  [{type: "actions", verbs: ["resume", "keep"], objects: ["paused consumer", "existing offset"], after: "recovery"}], [[1, "继续运行", "已暂停", "消费者"], [3, "保留", "现有偏移量"]]);

for (const [family, entries] of [
  ["ordinary-schedule", [
    ["museum", "The museum opens at nine in the morning, but visitors must arrive before four in the afternoon to enter. The building closes one hour later.", "博物馆上午九点开门，但游客必须在下午四点之前到达才能入场。大楼会在一小时后关闭。"],
    ["bus", "The last bus leaves the village at six in the evening. Buying a ticket does not reserve a seat, so passengers should join the queue before boarding.", "最后一班公交车在傍晚六点离开村庄。购票并不等于预留座位，因此乘客上车前应先排队。"],
  ]],
  ["ordinary-science", [
    ["water", "Water expands when it freezes. A container filled to the top may crack in a freezer, even when the container was not damaged beforehand.", "水结冰时会膨胀。装得满满的容器放入冰箱冷冻后可能开裂，即使容器此前并未损坏。"],
    ["shadow", "A tree does not move across the garden during the day, but its shadow changes direction as the position of the sun changes.", "树木白天并不会在花园里移动，但随着太阳位置变化，它的影子会改变方向。"],
  ]],
  ["ordinary-instructions", [
    ["jars", "Write the date on each jar before putting it on the shelf. Keep the newest jars behind the older ones, and do not mix products with different ingredients.", "把罐子放上架子之前，先在每个罐子上写明日期。将较新的罐子放在较旧的罐子后面，不要混放成分不同的产品。"],
    ["paint", "Wait until the first layer is dry before adding the next one. A surface that looks dry may still be wet underneath, especially in cold weather.", "等第一层干燥后再涂下一层。表面看起来干燥，内部仍可能潮湿，天气寒冷时尤其如此。"],
  ]],
  ["ordinary-communication", [
    ["invitation", "The letter invites residents to discuss the proposal. Attending the meeting does not mean that a resident agrees with the plan or promises to support it.", "这封信邀请居民讨论提案。参加会议并不表示居民同意该计划，也不表示承诺支持它。"],
    ["booking", "The message confirms that the request was received, not that a room has been booked. A separate confirmation will arrive after availability has been checked.", "这条消息确认的是请求已收到，并不是房间已订好。确认有空房后，还会另行发来预订确认。"],
  ]],
]) for (const [key, source, target] of entries) add("train", family, key, `<p>${source}</p>`, target, [target], [{type: "whole_sentence", contract: "Preserve all stated conditions, negation, times and actions; no shortening"}]);

add("validation", "success-after-checksum", "success",
  '<p>Return a success response only <em>after</em> <a href="/check">the checksum has been verified</a>. An unreadable file must not be reported as valid.</p>',
  "只有校验和验证通过之后，才能返回成功响应。无法读取的文件不得被报告为有效。", ["返回成功响应的时机必须", "晚于", "校验和验证通过", "。无法读取的文件不得被报告为有效。"],
  [{type: "order", first: "return success", relation: "after", second: "verify checksum"}], [[1, "晚于"], [2, "校验和", "验证通过"], [3, "不得", "有效"]]);
add("validation", "success-after-checksum", "failure",
  '<p>Return an error response if <a href="/check">the checksum verification fails</a>. A timeout leaves the outcome <strong>unknown</strong>, not successful.</p>',
  "校验和验证失败时，应返回错误响应。超时会使结果处于未知状态，不表示成功。", ["应返回错误响应，如果", "校验和验证失败", "。超时会使结果处于", "未知状态", "，不表示成功。"],
  [{type: "condition", action: "return error", if: "checksum verification fails"}, {type: "distinction", timeout_is: "unknown", timeout_is_not: "success"}], [[1, "校验和", "失败"], [3, "未知"]]);
add("validation", "observer-activation", "attach",
  '<p><a href="/attach">Attach the observer</a> through <code>watch_changes()</code> before enabling notifications. Attaching alone must not send a notification.</p>',
  "启用通知之前，先通过 watch_changes() 附加观察者。仅附加观察者不得发送通知。", ["附加观察者", "时调用", "，之后再启用通知。仅附加观察者不得发送通知。"],
  [{type: "order", first: "attach observer", relation: "before", second: "enable notifications"}], [[0, "附加", "观察者"], [2, "之后", "不得", "通知"]]);
add("validation", "observer-activation", "detach",
  '<p>Disable notifications before calling <code>unwatch_changes()</code> to <a href="/detach">detach the observer</a>. Disabling is not the same as detaching.</p>',
  "调用 unwatch_changes() 分离观察者之前，应先禁用通知。禁用并不等于分离。", ["先禁用通知，然后调用", "来", "分离观察者", "。禁用并不等于分离。"],
  [{type: "order", first: "disable notifications", relation: "before", second: "detach observer"}], [[0, "先禁用", "然后"], [2, "分离", "观察者"]]);
add("validation", "reply-recipient", "reviewer",
  '<p>Send <a href="/receipt">the signed receipt</a> from <a href="/reviewer">the reviewer</a> to <a href="/requester">the requester</a>. Do not reverse the sender and recipient.</p>',
  "将签名回执从审核人发给请求方，不要颠倒发送方和接收方。", ["发送", "签名回执", "时，发送方为", "审核人", "，接收方为", "请求方", "。不要颠倒发送方和接收方。"],
  [{type: "transfer", object: "signed receipt", from: "reviewer", to: "requester"}], [[1, "签名", "回执"], [3, "审核人"], [5, "请求方"]]);
add("validation", "reply-recipient", "requester",
  '<p>Send <a href="/request">the revision request</a> from <a href="/requester">the requester</a> to <a href="/reviewer">the reviewer</a>. The receipt is not a revision request.</p>',
  "将修订请求从请求方发给审核人。回执并不是修订请求。", ["发送", "修订请求", "时，发送方为", "请求方", "，接收方为", "审核人", "。回执并不是修订请求。"],
  [{type: "transfer", object: "revision request", from: "requester", to: "reviewer"}], [[1, "修订", "请求"], [3, "请求方"], [5, "审核人"]]);
add("validation", "nonce-challenge", "reuse",
  '<p>A challenge contains <a href="/nonce">a freshly generated nonce</a>. Reusing that value in another challenge defeats the freshness check; it does not choose an encryption algorithm.</p>',
  "质询包含一个新生成的随机数。在另一次质询中复用该值会使新鲜性检查失效；它并不会选择加密算法。", ["质询包含", "一个新生成的随机数", "。在另一次质询中复用该值会使新鲜性检查失效；它并不会选择加密算法。"],
  [{type: "distinction", nonce_is: "fresh random value", reuse: "defeats freshness", not: "encryption algorithm selection"}], [[1, "新生成", "随机数"], [2, "复用", "失效", "不会"]]);
add("validation", "nonce-challenge", "record",
  '<p>Record the challenge identifier together with <a href="/nonce">its nonce</a>. Receiving the identifier twice does not create a second independent challenge.</p>',
  "记录质询标识符及其随机数。两次收到该标识符并不会创建第二个独立质询。", ["记录质询标识符及", "其随机数", "。两次收到该标识符并不会创建第二个独立质询。"],
  [{type: "identity", identifier_repeated: true, creates_new_challenge: false}], [[1, "随机数"], [2, "不会", "独立质询"]]);

add("holdout", "compound-initialization", "handle",
  '<p>A minimal routine allocates the descriptor, checks its mode, and initializes <a href="/handle"><code>FileHandle</code></a>:</p>',
  "一个最小例程会分配描述符、检查其模式，并初始化 FileHandle：", ["一个最小例程会分配描述符、检查其模式，并进行初始化，初始化的对象是"],
  [{type: "actions", verbs: ["allocate", "check", "initialize"], objects: ["descriptor", "its mode", "FileHandle"]}], [[0, "分配", "描述符", "检查", "模式", "初始化"]]);
add("holdout", "compound-initialization", "policy",
  '<p>The helper authenticates the caller and installs the policy using <a href="/binder"><code>PolicyBinder</code></a>:</p>',
  "这个辅助函数使用 PolicyBinder 认证调用者并安装策略：", ["这个辅助函数会认证调用者并安装策略，使用的是"],
  [{type: "actions", verbs: ["authenticate", "install"], objects: ["caller", "policy"], tool: "PolicyBinder"}], [[0, "认证", "调用者", "安装", "策略"]]);
add("holdout", "lease-release", "after",
  '<p>Release the lease through <code>drop_lease()</code> only <strong>after</strong> the final reader has exited. A reader that timed out may still be active.</p>',
  "只有最后一个读取器退出之后，才能通过 drop_lease() 释放租约。超时的读取器仍可能处于活动状态。", ["释放租约时调用", "；释放租约的时机必须", "晚于", "最后一个读取器退出。超时的读取器仍可能处于活动状态。"],
  [{type: "order", first: "release lease", relation: "after", second: "last reader exits"}], [[0, "释放", "租约"], [2, "晚于"], [3, "仍可能", "活动"]]);
add("holdout", "lease-release", "before",
  '<p>Release the lease through <code>drop_lease()</code>, and do so <strong>before</strong> returning the descriptor to the pool. Returning it first may allow a second owner to reuse it.</p>',
  "把描述符归还池之前，先通过 drop_lease() 释放租约。先归还描述符可能让另一个所有者复用它。", ["释放租约时调用", "；释放租约的时机必须", "早于", "将描述符归还池。先归还描述符可能让另一个所有者复用它。"],
  [{type: "order", first: "release lease", relation: "before", second: "return descriptor"}], [[0, "释放", "租约"], [2, "早于"], [3, "复用"]]);
add("holdout", "action-labels", "invalidate",
  '<p>If the revision changes, <a href="/invalidate">invalidate the cached response</a> and <em>request a fresh copy</em>. Keeping the old response is not a refresh.</p>',
  "修订发生变化时，应使缓存响应失效，并请求新副本。保留旧响应并不等于刷新。", ["修订发生变化时，", "使缓存响应失效", "并", "请求新副本", "。保留旧响应并不等于刷新。"],
  [{type: "actions", verbs: ["invalidate", "request"], objects: ["cached response", "fresh copy"]}], [[1, "缓存响应", "失效"], [3, "请求", "新副本"]]);
add("holdout", "action-labels", "retain",
  '<p>If the revision is unchanged, <a href="/retain">retain the cached response</a> and <em>skip the network request</em>. An unchanged revision is not evidence that the cache was deleted.</p>',
  "修订未变化时，应保留缓存响应，并跳过网络请求。修订未变化并不表明缓存已被删除。", ["修订未变化时，", "保留缓存响应", "并", "跳过网络请求", "。修订未变化并不表明缓存已被删除。"],
  [{type: "actions", verbs: ["retain", "skip"], objects: ["cached response", "network request"]}], [[1, "保留", "缓存响应"], [3, "跳过", "网络请求"]]);
add("holdout", "ordinary-uncertainty", "estimate",
  '<p>The report gives an estimate of the number of visitors, not an exact count. Rain may reduce attendance, but a forecast of rain does not prove that the event will be cancelled.</p>',
  "报告给出的是游客人数估计值，而不是精确计数。降雨可能减少到场人数，但预报有雨并不能证明活动会取消。", ["报告给出的是游客人数估计值，而不是精确计数。降雨可能减少到场人数，但预报有雨并不能证明活动会取消。"],
  [{type: "uncertainty", estimate_is_not_exact: true, rain_forecast_implies_cancellation: false}]);
add("holdout", "ordinary-uncertainty", "parcel",
  '<p>The tracking page says the parcel has left the warehouse. This does not mean it has reached the destination. Delivery can be confirmed only after the recipient signs for it.</p>',
  "物流页面显示包裹已离开仓库。这并不表示包裹已到达目的地。只有收件人签收后，才能确认已送达。", ["物流页面显示包裹已离开仓库。这并不表示包裹已到达目的地。只有收件人签收后，才能确认已送达。"],
  [{type: "distinction", left_warehouse_is_not_arrived: true, delivered_only_after: "recipient signs"}]);

export function semanticCases() {return structuredClone(cases);}
export function assertDeclaredSlotContracts(sample) {
  if (!sample.semantic_facts?.length || !sample.natural_reference?.trim()) throw new Error("Missing paired meaning reference");
  for (const rule of sample.slot_contracts) {
    if (rule.required.some(word => !sample.reference_slots[rule.slot]?.includes(word))) throw new Error("Required action/role missing in source slot: " + sample.id);
  }
}
