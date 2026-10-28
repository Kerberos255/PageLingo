// Assistant-authored references, not independent human translations. Preserve v2
// exports: v3 repairs source-slot ownership without changing the production prompt.
import {trainTemplates as previous, trainingEntities, validationEntities} from './targeted-v2.mjs';

const fixes = {
  'protected-promise-term': ([n,,z], old) => [old[0], old[1], '，这是一个对象，具有可调用的', '方法。thenable 并不一定可迭代。'],
  'rollback-only-pending': ([n,,z]) => ['取消', `待处理的${z}（仅限这些条目）`, '；已完成的条目必须保持不变。'],
  'long-ownership': (entity, old) => [old[0], '，并将只读引用传给', old[2], old[3].replace(/^传递只读引用。/u, '。'), ...old.slice(4)],
  'long-thenables': (entity, old) => [old[0], old[1], '。thenable 是一个对象，具有可调用的', ...old.slice(3)],
  'long-rich-version-history': (entity, old) => [old[0], old[1], '任何准备中的替代版本对新读取器可见。写入器记录决定时先调用', old[3].replace(/^记录决定，再/u, '，再'), ...old.slice(4)],
  'hard-release-after-storage-ack': ([n,,z], old) => [`释放${z}时调用`, '；释放的时机必须', ...old.slice(2)],
  'hard-notify-after-commit': ([n,,z], old) => [`向观察者通知${z}时使用`, '；通知的时机必须', ...old.slice(2)],
  'hard-register-before-enabling': ([n,,z], old) => [`注册${z}时，先调用`, '并确保成功，', ...old.slice(2)],
  'hard-finish-before-visible': ([n,,z], old) => [`完成${z}验证时，先调用`, '并确保成功，', ...old.slice(2)],
  'hard-three-stage-code-order': ([n,,z]) => [`首先准备${z}时调用`, '；然后记录决定时调用', '；之后才能调用', '来通知等待者。绝不能交换最后两个步骤。'],
  'hard-two-checks-before-grant': ([n,,z]) => [`授予对${z}的访问权限必须等到`, '和', '均成功。只有一项检查成功还不够；失败时必须保持现有权限不变。'],
  'hard-long-order-and-bounds': ([n,,z], old) => [old[0].replace(/通过$/u, '删除任何内容前，先检查已提交副本的数量；删除时调用'), old[1].replace(/^删除任何内容之前，必须先检查已提交副本的数量。/u, '。')],
};

// These checks preserve critical actions in their original source text slot.
// They deliberately do not claim to be a general semantic equivalence checker.
const ownership = {
  'protected-promise-term': [[2, '对象']],
  'long-ownership': [[1, '只读引用']],
  'long-thenables': [[2, '对象']],
  'long-rich-version-history': [[2, '记录决定']],
  'hard-release-after-storage-ack': [[0, '释放', '$entity']],
  'hard-notify-after-commit': [[0, '通知', '$entity']],
  'hard-register-before-enabling': [[0, '注册', '$entity']],
  'hard-finish-before-visible': [[0, '验证', '$entity']],
  'hard-three-stage-code-order': [[0, '准备', '$entity'], [1, '记录决定']],
  'hard-two-checks-before-grant': [[0, '授予', '访问权限', '$entity']],
  'hard-long-order-and-bounds': [[0, '检查', '删除']],
};

export function assertSlotOwnership(sample) {
  for (const rule of sample.slot_contracts ?? []) {
    const text = sample.reference_slots[rule.slot];
    if (typeof text !== 'string' || rule.required.some(word => !text.includes(word)))
      throw new Error(`${sample.id ?? sample.family}: required action/object left source slot ${rule.slot}`);
  }
}

const row = (name, html, slots, contract, requirements = []) => ({name, build: entity => ({
  html: html(entity), reference_slots: slots(entity),
  slot_contracts: requirements.map(([slot, ...required]) => ({slot, required: required.map(word => word === '$entity' ? entity[2] : word)})),
}), contract});
const plain = (name, source, target, contract) => row(name, e => `<p>${source(e)}</p>`, e => [target(e)], contract);

const addedTrain = [
  plain('nonce-is-single-use', ([n]) => `A nonce in the ${n} is a random value used once. It is not an asymmetric encryption key.`,
    ([n,,z]) => `${z}中的 nonce 是仅使用一次的随机值，不是非对称加密密钥。`, 'nonce is a one-use random value; no invented key exchange'),
  row('nonce-link-label', ([n]) => `<p>The ${n} contains <a href="/nonce">a nonce</a> for this challenge. Do not reuse that random value in another challenge.</p>`,
    ([n,,z]) => [`${z}包含`, '一个随机数', '，用于此次质询。不得在另一次质询中重复使用该随机值。'], 'linked nonce remains a random value, with one-challenge scope'),
  plain('nonce-versus-digest', ([n]) => `The ${n} stores a nonce and a digest separately. The nonce prevents replay; the digest detects changed bytes. Neither value is a private key.`,
    ([n,,z]) => `${z}分别存储随机数和摘要。随机数用于防止重放，摘要用于检测字节变化。这两个值都不是私钥。`, 'nonce and digest have distinct roles'),
  row('action-before-call', ([n]) => `<p>Authenticate the ${n} with <code>verify_proof()</code>, and connect only when authentication succeeds. Failure must leave the connection closed.</p>`,
    ([n,,z]) => [`认证${z}时调用`, '，并且只有认证成功后才能连接。失败时必须保持连接关闭。'], 'authentication retained before protected call; successful authentication precedes connection', [[0, '认证', '$entity']]),
  row('delivery-before-call', ([n]) => `<p>Transmit the ${n} using <code>send_frame()</code>. Wait for acknowledgement, then close the stream. A failed transmission must not be reported as delivered.</p>`,
    ([n,,z]) => [`传输${z}时使用`, '。等待确认，然后关闭流。传输失败时，不得报告为已送达。'], 'transmit object retained; acknowledgement before close', [[0, '传输', '$entity']]),
  row('copy-not-move', ([n]) => `<p>Duplicate the ${n} in <a href="/backup">the backup log</a>, keeping its active copy unchanged. Remove the active copy only once the duplicate has been confirmed.</p>`,
    ([n,,z]) => [`将${z}复制到`, '备份日志', '，保持活动副本不变。只有确认复制成功之后，才能移除活动副本。'], 'copy rather than move; confirmation precedes removal', [[0, '复制', '$entity']]),
  row('create-bind-start-all', ([n]) => `<p>The ${n} task is configured through <code>Executor</code>. Initialization allocates the task, binds its error callback, and starts execution with <code>execute_task()</code>:</p>`,
    ([n,,z]) => [`${z}任务通过`, '进行配置。初始化过程会分配任务、绑定错误回调，并启动执行，调用的是'], 'allocate, bind callback and start all retained before final protected call', [[1, '分配', '绑定', '启动']]),
  row('disconnect-after-notice', ([n]) => `<p>Disconnect the ${n} reader through <code>disconnect_reader()</code> only <strong>after</strong> the notice has been acknowledged. An unacknowledged notice must keep the reader connected.</p>`,
    ([n,,z]) => [`断开${z}读取器时调用`, '；断开的时机必须', '晚于', '通知得到确认。通知未得到确认时，必须保持读取器连接。'], 'acknowledgement precedes disconnect; no forced clause reversal', [[0, '断开', '$entity']]),
  row('permission-not-fact', ([n]) => `<p>For the ${n}, <em>no</em> operator is allowed to bypass authentication. This is a restriction, not a statement that authentication has already happened.</p>`,
    ([n,,z]) => [`对于${z}，`, '没有', '任何操作员被允许绕过认证。这是一项限制，不表示认证已经发生。'], 'prohibition remains a prohibition'),
  row('count-and-role', ([n]) => `<p>The ${n} requires <strong>exactly two</strong> approvals from different reviewers. Two retries by one reviewer still count as one approval.</p>`,
    ([n,,z]) => [`${z}需要`, '恰好两次', '来自不同审核人的批准。同一审核人的两次重试仍只算一次批准。'], 'exact cardinality and distinct reviewer requirement'),
  plain('append-is-not-commit', ([n]) => `Appending the ${n} to a local log does not commit it. A durable commit requires the quorum to acknowledge the same value. A retry must reuse the existing request identifier.`,
    ([n,,z]) => `将${z}追加到本地日志并不等于提交。持久提交要求法定数量的节点确认同一个值。重试必须复用原有请求标识符。`, 'append differs from commit; retry preserves request identity'),
  plain('timeout-keeps-unknown', ([n]) => `A timeout while storing the ${n} leaves the outcome unknown. Query the stored status before retrying. Do not infer failure or success merely from the timeout.`,
    ([n,,z]) => `存储${z}时超时，意味着结果未知。重试之前应查询已存储的状态。不得仅根据超时推断失败或成功。`, 'timeout is unknown; inspect before retry'),
  plain('bytes-versus-characters', ([n]) => `The ${n} length is measured in UTF-8 bytes, not Unicode characters. A character may occupy more than one byte. Keep the original byte limit when validating the payload.`,
    ([n,,z]) => `${z}的长度按 UTF-8 字节计量，而不是按 Unicode 字符计量。一个字符可能占用多个字节。验证载荷时，应保留原有字节上限。`, 'byte count and character count are distinct'),
  plain('release-acquire-visibility', ([n]) => `A release store publishes the ${n} to a reader that performs the matching acquire load. It does not make unrelated operations atomic. The reader must still obey the ownership rules.`,
    ([n,,z]) => `release 存储会将${z}发布给执行匹配 acquire 加载的读取器。它不会使不相关的操作具有原子性。读取器仍必须遵守所有权规则。`, 'release/acquire visibility does not imply unrelated atomicity'),
  plain('cancel-does-not-undo', ([n]) => `Cancelling the caller does not undo a committed ${n}. The server may already have stored the result. Use the original request identifier to retrieve it instead of submitting the same operation as a new request.`,
    ([n,,z]) => `取消调用者不会撤销已提交的${z}。服务器可能已经存储了结果。应使用原请求标识符取回结果，而不是把同一操作作为新请求再次提交。`, 'cancellation is not rollback; retrieve original result'),
  row('bound-callback-owner', ([n]) => `<p>Keep the ${n} callback bound to <a href="/owner">its original owner</a>. Renaming a worker does not bind the callback, and binding it to another owner changes which object receives the request.</p>`,
    ([n,,z]) => [`保持${z}回调绑定到`, '其原始所有者', '。重命名工作线程不会绑定回调，绑定到另一个所有者则会改变接收请求的对象。'], 'binding identity differs from naming'),
];

const newValidation = [
  row('validation-parse-failure', ([n]) => `<p>If parsing the ${n} fails, <strong>do not</strong> call <code>activate()</code>. Preserve the previous active state and report the parse error.</p>`,
    ([n,,z]) => [`如果解析${z}失败，`, '不得', '调用', '。应保留此前的活动状态，并报告解析错误。'], 'parse failure prevents activation; previous state retained'),
  row('validation-persist-before-retire', ([n]) => `<p>A ${n} reader may be retired once <a href="/observer">the observer</a> has durably stored its receipt. Until that confirmation arrives, keep the reader alive.</p>`,
    ([n,,z]) => [`${z}读取器可以退出，前提是`, '观察者', '已持久存储其回执。在该确认到达之前，必须保持读取器存活。'], 'durable receipt is prerequisite for retirement'),
  row('validation-counter-ceiling', ([n]) => `<p>The retry counter for the ${n} ranges from <code>0</code> to <code>3</code> inclusive. A value above the upper bound must be rejected; resetting the counter does not approve the request.</p>`,
    ([n,,z]) => [`${z}的重试计数器范围从`, '到', '，包含两端。超过上限的值必须被拒绝；重置计数器并不等于批准请求。'], 'inclusive bounds; reset is not approval'),
  row('validation-prepare-attach-run', ([n]) => `<p>For the ${n}, setup prepares the resources, attaches the completion handler, and then invokes <code>run_ready()</code> to start work. Merely preparing resources starts nothing.</p>`,
    ([n,,z]) => [`对于${z}，设置过程会准备资源、附加完成处理程序，然后调用`, '来启动工作。仅准备资源不会启动任何工作。'], 'prepare, attach and start all retained', [[0, '准备', '附加'], [1, '启动']]),
  row('validation-reply-direction', ([n]) => `<p>For the ${n}, <a href="/receiver">the receiver</a> replies to <a href="/sender">the sender</a>. Reversing those labels would change who receives the reply.</p>`,
    ([n,,z]) => [`对于${z}，`, '接收方', '回复', '发送方', '。颠倒这些标签会改变谁接收回复。'], 'receiver replies to sender; link labels keep roles'),
  plain('validation-fresh-challenge', ([n]) => `The ${n} includes a fresh challenge value called a nonce. It must differ from the previous challenge. This requirement does not create an encryption key or choose a cipher.`,
    ([n,,z]) => `${z}包含一个新的质询值，称为 nonce（随机数）。它必须与上一次质询不同。这项要求不会创建加密密钥，也不会选择密码算法。`, 'nonce freshness does not imply key generation'),
  plain('validation-failed-refresh', ([n]) => `Refreshing the ${n} may fail after a new version has been prepared. Keep serving the committed version until the replacement has been accepted. A prepared replacement is not yet the active version.`,
    ([n,,z]) => `准备好新版本之后，刷新${z}仍可能失败。替代版本被接受之前，应继续提供已提交的版本。准备好的替代版本尚不是活动版本。`, 'prepared differs from accepted; retain committed version'),
  row('validation-copy-error', ([n]) => `<p>Duplicating the ${n} through <code>copy_entry()</code> can fail. In that case the source must remain intact; an error response is not evidence that a destination copy exists.</p>`,
    ([n,,z]) => [`复制${z}时调用`, '，此操作可能失败。失败时源内容必须保持不变；错误响应不能证明目标副本已经存在。'], 'copy retained before call; failure preserves source', [[0, '复制', '$entity']]),
];

export const trainTemplates = previous.map(template => ({...template, build: entity => {
  const value = template.build(entity);
  const reference_slots = fixes[template.name]?.(entity, value.reference_slots) ?? value.reference_slots;
  return {...value, reference_slots, reference_repaired: Boolean(fixes[template.name]),
    slot_contracts: (ownership[template.name] ?? []).map(([slot, ...required]) => ({slot, required: required.map(word => word === '$entity' ? entity[2] : word)}))};
}})).concat(addedTrain);
export const validationTemplates = newValidation;
export const repairedFamilies = Object.keys(fixes);

export function targetedCases() {
  return [['train', trainTemplates, trainingEntities], ['validation', validationTemplates, validationEntities]].flatMap(([split, templates, entities]) =>
    templates.flatMap(template => entities.map((entity, index) => {
      const value = template.build(entity);
      const sample = {id: `v3-${template.name}-${index}`, split, family: `v3-${template.name}`,
        category: template.name.includes('long') ? 'long_synthetic' : 'targeted_synthetic',
        ...value, context_url: 'https://example.com/pagelingo-targeted-v3', origin: {kind: 'authored'},
        review_status: 'assistant_audited_synthetic', semantic_contract: template.contract, probes: []};
      assertSlotOwnership(sample);
      return sample;
    })));
}
