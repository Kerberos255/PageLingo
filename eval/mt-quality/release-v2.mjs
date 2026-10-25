// Freeze these contrastive checks before candidate training. Never export them as optimizer inputs.
const pair = (family, rows, contract) => rows.map(([suffix, html, reference_slots]) => ({
  id: `release-v2-${family}-${suffix}`, split: "holdout", family: `release-v2-${family}`,
  category: "contrastive_semantics", html: `<p>${html}</p>`, reference_slots,
  context_url: "https://example.com/pagelingo-release-v2", origin: {kind: "authored"},
  review_status: "assistant_audited_synthetic", semantic_contract: contract[suffix], probes: [],
}));
export function releaseCases() {
  return [
    ...pair("handoff-order", [
      ["before", 'Give <code>token</code> to <a href="/scheduler">the scheduler</a> <em>before</em> subscribing to updates.', ["先将", "交给", "调度器", "然后", "订阅更新。"]],
      ["after", 'Give <code>token</code> to <a href="/scheduler">the scheduler</a> <em>after</em> subscribing to updates.', ["将", "交给", "调度器", "应晚于", "订阅更新。"]],
    ], {before: "Handoff precedes subscription.", after: "Subscription precedes handoff."}),
    ...pair("replication-roles", [
      ["replica", 'The <strong>replica</strong> waits for the <strong>leader</strong>, not the other way around.', ["", "副本", "等待", "主节点", "，方向不能颠倒。"]],
      ["leader", 'The <strong>leader</strong> waits for the <strong>replica</strong>, not the other way around.', ["", "主节点", "等待", "副本", "，方向不能颠倒。"]],
    ], {replica: "Replica waits for leader; leader does not wait for replica.", leader: "Leader waits for replica; replica does not wait for leader."}),
    ...pair("backup-bound", [
      ["minimum", 'Preserve <em>at least</em> <code>4</code> backups before pruning.', ["保留", "至少", "份备份后再进行清理。"]],
      ["maximum", 'Preserve <em>at most</em> <code>4</code> backups before pruning.', ["保留", "至多", "份备份后再进行清理。"]],
    ], {minimum: "Four is a lower bound.", maximum: "Four is an upper bound."}),
    ...pair("lease-permission", [
      ["allowed", 'The publisher <em>can</em> renew the lease.', ["发布者", "可以", "续租。"]],
      ["forbidden", 'The publisher <em>cannot</em> renew the lease.', ["发布者", "不能", "续租。"]],
    ], {allowed: "Renewal is permitted.", forbidden: "Renewal is not permitted."}),
    ...pair("duplicates-scope", [
      ["not-all", '<strong>Not all</strong> arrivals are duplicates.', ["并非所有", "到达项都是重复项。"]],
      ["none", '<strong>None</strong> of the arrivals are duplicates.', ["没有", "任何到达项是重复项。"]],
    ], {"not-all": "At least one arrival is not a duplicate; some may be duplicates.", none: "No arrival is a duplicate."}),
    ...pair("ready-condition", [
      ["unless", 'Keep <code>ready</code> disabled <em>unless</em> initialization succeeds.', ["让", "保持禁用，", "除非", "初始化成功。"]],
      ["until", 'Keep <code>ready</code> disabled <em>until</em> initialization succeeds.', ["让", "保持禁用，", "直到", "初始化成功。"]],
    ], {unless: "Initialization success is the exception allowing readiness.", until: "Readiness must remain disabled before initialization succeeds."}),
    ...pair("boolean-connective", [
      ["and", 'Start only when <code>signed</code> <em>and</em> <code>fresh</code> are true.', ["仅当", "且", "两者均为真时才启动。"]],
      ["or", 'Start only when <code>signed</code> <em>or</em> <code>fresh</code> is true.', ["仅当", "或", "至少一项为真时才启动。"]],
    ], {and: "Both signed and fresh are required.", or: "At least one of signed and fresh is required."}),
    ...pair("protocol-definition", [
      ["thenable", 'A <a href="/thenable">thenable</a> must provide a callable <code>then</code> method; iteration is optional.', ["一个", "thenable", "必须提供可调用的", "方法；迭代能力是可选的。"]],
      ["iterable", 'An <a href="/iterable">iterable</a> must provide a callable <code>Symbol.iterator</code> method; a <code>then</code> method is optional.', ["一个", "可迭代对象", "必须提供可调用的", "方法；", "方法是可选的。"]],
    ], {thenable: "Callable then is required; iteration is optional.", iterable: "Callable Symbol.iterator is required; then is optional."}),
  ];
}
