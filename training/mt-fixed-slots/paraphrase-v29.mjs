// Assistant-authored fictional API examples. No observed web/model output is a target.
// Each template belongs to exactly one split; changing a code name alone never
// supplies a new model-visible source. The exporter checks the actual wire too.
import {createHash} from 'node:crypto';
const sets = {
  train: [["cache entry","缓存条目"],["network message","网络消息"],["database record","数据库记录"],["file handle","文件句柄"],
    ["timer event","定时器事件"],["image frame","图像帧"],["queue item","队列项"],["configuration block","配置块"]],
  validation: [["sensor reading","传感器读数"],["transaction state","事务状态"],["document node","文档节点"],["packet fragment","数据包片段"]],
  holdout: [["pending operation","待处理操作"],["journal entry","日志条目"],["stream segment","流片段"],["render command","渲染命令"]],
};
const escape = s => s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const text = (source, target, tag = null) => ({source,target,tag,code:false});
const code = (value, link = false) => ({source:value,target:value,code:true,tag:link?"a":null});
const dot = () => text(".",".");
function sample(split, category, variant, index, parts, natural, facts) {
  const merged=[];
  for(const part of parts){const last=merged.at(-1);if(last&&!last.code&&!last.tag&&!part.code&&!part.tag){last.source+=part.source;last.target+=part.target;}else merged.push({...part});}
  const html = '<p>'+merged.map(p=>p.code
    ? (p.tag?'<a href="/v29/code">':'')+'<code>'+escape(p.source)+'</code>'+(p.tag?'</a>':'')
    : p.tag?'<'+p.tag+(p.tag==='a'?' href="/v29/topic"':'')+'>'+escape(p.source)+'</'+p.tag+'>':escape(p.source)).join('')+'</p>';
  const slots=merged.filter(p=>!p.code&&/\p{L}/u.test(p.source)).map(p=>p.target);
  return {id:`v29-${split}-${category}-${variant}-${index}`,split,family:`v29-${category}-form${variant}`,category,
    html,natural_reference:natural,reference_slots:slots,semantic_facts:facts,
    context_url:"https://example.org/pagelingo/v29-authored",origin:{kind:"authored_fictional_api"},
    review_status:"assistant_audited_synthetic",probes:[],template_parts:merged};
}
export function paraphraseCases(){const cases=[];
 for(const [split,topics] of Object.entries(sets))for(const variant of split==='train'?[1,2]:split==='validation'?[3]:[4])for(const [j,[en,zh]] of topics.entries()){
  const nonce=createHash('sha256').update(en+'|'+variant).digest('hex').slice(0,8);
  const a=`read_${nonce}()`,b=`Cell_${nonce}`,err=`Absent_${nonce}`,enter=`enter_${nonce}()`,exit=`leave_${nonce}()`;
  const value=`Value_${nonce}`,promise=`Promise_${nonce}`,self=`Self_${nonce}`,nil=`Nil_${nonce}`,ready=`Ready_${nonce}`;
  const noun=text(en,zh,'a');let p,n,f;
  // A result/condition order that English and Chinese can express without moving code.
  if(variant===1){p=[text('Returns ','返回'),code('true'),text(` when the ${en} is a `,`，当${zh}属于`),code(ready,true),text(' and its checksum is valid.','且其校验和有效时。')];n=`当${zh}属于${ready}且其校验和有效时，返回true。`;f={result:'true',state:ready,operator:'and',condition:'checksum valid'};}
  if(variant===2){p=[text('Produces ','输出'),code('false'),text(` if the ${en} is a `,`，当${zh}属于`),code(ready,true),text(' or its checksum is invalid.','或其校验和无效时。')];n=`如果${zh}属于${ready}或其校验和无效，则输出false。`;f={result:'false',state:ready,operator:'or',condition:'checksum invalid'};}
  if(variant===3){p=[text('Gives ','输出'),code('true'),text(` provided the ${en} has type `,`，当${zh}的类型为`),code(ready,true),text(' and its checksum has been verified.','且其校验和已经过验证时。')];n=`如果${zh}的类型为${ready}且其校验和已经过验证，就输出true。`;f={result:'true',state:ready,operator:'and',condition:'checksum verified'};}
  if(variant===4){p=[text('The result is ','结果为'),code('true'),text(` only when the ${en} is a `,`，但仅当${zh}属于`),code(ready,true),text(' and its checksum is correct.','且其校验和正确时才成立。')];n=`只有${zh}属于${ready}且其校验和正确时，结果才为true。`;f={result:'true',state:ready,operator:'only_when_and',condition:'checksum correct'};}
  cases.push(sample(split,'result-condition',variant,j,p,n,f));
  // Method first, receiver second. Code-only links keep their original code.
  if(variant===1)p=[text('Calling ','调用'),code(a,true),text(' on ','，作用对象为'),code(b),text(` refreshes the ${en}.`,`，会刷新${zh}。`)];
  if(variant===2)p=[text('Invoking ','调用'),code(a,true),text(' on ','，作用对象为'),code(b),text(` clears the ${en}.`,`，会清除${zh}。`)];
  if(variant===3)p=[text('An invocation of ','调用'),code(a,true),text(' on ','，作用对象为'),code(b),text(` retains the ${en}.`,`，会保留${zh}。`)];
  if(variant===4)p=[text('When ','调用'),code(a,true),text(' is invoked on ','，作用对象为'),code(b),text(`, it rebuilds the ${en}.`,`时，会重建${zh}。`)];
  const verb=['','refresh','clear','retain','rebuild'][variant],cn=['','刷新','清除','保留','重建'][variant];
  n=`对${b}调用${a}会${cn}${zh}。`;cases.push(sample(split,'method-receiver',variant,j,p,n,{method:a,receiver:b,action:verb,object:en}));
  const condition=` holds the ${en} and is not shared.`,conditionCn=`持有${zh}且未被共享。`;
  if(variant===1)p=[text('Use ','使用'),code(a,true),text(' when you know that ','，当已确认'),code(b),text(condition,conditionCn.replace('。','时。'))];
  if(variant===2)p=[text('Choose ','选择'),code(a,true),text(' if ','，当'),code(b),text(condition,conditionCn.replace('。','时。'))];
  if(variant===3)p=[text('Direct access through ','直接访问可采用以下方法：'),code(a,true),text(' is appropriate once ','，它适用于'),code(b),text(condition,conditionCn.replace('。','的情形。'))];
  if(variant===4)p=[text('Prefer ','优先采用'),code(a,true),text(' whenever ','，每当'),code(b),text(condition,conditionCn.replace('。','时。'))];
  n=variant===1?`已确认${b}持有${zh}且未被共享时，使用${a}。`:variant===2?`如果${b}持有${zh}且未被共享，则选择${a}。`:variant===3?`${b}持有${zh}且未被共享时，适合通过${a}直接访问。`:`${b}持有${zh}且未被共享时，优先采用${a}。`;
  cases.push(sample(split,'use-condition',variant,j,p,n,{method:a,condition_object:b,holds:en,shared:false}));
  // Front-load a temporal description rather than dropping while/only while.
  if(variant===1)p=[text(`The reference to the ${en} in `,`指向${zh}且位于`),code(a),text(' stays valid while ','的引用，在以下对象有效期间保持有效：'),code(b,true),text(' is valid.','。')];
  if(variant===2)p=[text(`A reference to the ${en} kept in `,`指向${zh}且保存在`),code(a),text(' may be used only while ','中的引用，仅可在以下对象仍有效期间使用：'),code(b,true),text(' remains valid.','。')];
  if(variant===3)p=[text(`A reference to the ${en} held by `,`指向${zh}且由`),code(a),text(' remains usable for as long as ','持有的引用，在以下对象仍有效期间可继续使用：'),code(b,true),text(' stays valid.','。')];
  if(variant===4)p=[text(`The borrowed ${en} referenced through `,`经由`),code(a),text(' can be accessed only while ',`访问的借用${zh}，仅可在以下对象仍然有效期间访问：`),code(b,true),text(' continues to be valid.','。')];
  n=variant===2||variant===4?`只有在${b}仍有效期间，才可${variant===4?'经由'+a+'访问借用的'+zh:'使用保存在'+a+'中、指向'+zh+'的引用'}。`:`在${b}仍有效期间，${a}中指向${zh}的引用${variant===3?'仍可使用':'保持有效'}。`;
  cases.push(sample(split,'while-lifetime',variant,j,p,n,{reference:a,owner:b,object:en,condition:'owner valid',only:variant===2||variant===4}));
  // Adjacent code nodes leave no editable gap: finish the first clause before its code.
  const starts=[null,`The ${en} uses the token returned by `,`The ${en} operates with the token supplied by `,`For the ${en}, the token comes from `,`The token used by the ${en} is obtained from `];
  const prefix=[null,`${zh}使用以下函数返回的令牌：`,`运行${zh}所用的令牌由以下函数提供：`,`对于${zh}，令牌来自以下函数：`,`${zh}所用的令牌由以下函数提供：`];
  const tails=[null,` is raised when the ${en} has no active token.`,` signals that the token for the ${en} is unavailable.`,` is reported if the token for the ${en} is missing.`,` is thrown unless the token for the ${en} is present.`];
  const ends=[null,`会在${zh}没有活动令牌时抛出。`,`表示${zh}的令牌不可用。`,`会在${zh}的令牌缺失时报告。`,`会在${zh}的令牌不存在时抛出。`];
  p=[text(starts[variant],prefix[variant]),code(a,true),text('; ','; '),code(err,true),text(tails[variant],ends[variant])];
  n=`${zh}使用${a}${variant===1?'返回':'提供'}的令牌；${variant===2?`${err}表示${zh}的令牌不可用`:variant===1?`若${zh}没有活动令牌，则抛出${err}`:`若${zh}的令牌缺失，则${variant===3?'报告':'抛出'}${err}`}。`;
  cases.push(sample(split,'adjacent-function-exception',variant,j,p,n,{supplier:a,error:err,object:en,condition:variant===1?'no active token':'token unavailable'}));
  if(variant===1)p=[text(`The ${en} supplies a default `,`${zh}为以下方法提供默认实现：`),code(enter,true),text(' returning ','，它返回'),code(self),text('; ','; '),code(exit,true),text(' stays abstract and returns ','保持抽象，默认返回'),code(nil),text(' by default.','。')];
  if(variant===2)p=[text('For the ','对于该'),noun,text(', ',', '),code(enter,true),text(' has a default implementation that returns ','具有默认实现，返回'),code(self),text('; ','; '),code(exit,true),text(' is abstract and its default result is ','为抽象方法，默认结果为'),code(nil),dot()];
  if(variant===3)p=[text(`For the ${en}, `,`对于${zh}，`),code(enter,true),text(' is implemented by default and yields ','已有默认实现，返回'),code(self),text('; ','; '),code(exit,true),text(' remains abstract with a default return of ','仍为抽象方法，默认返回'),code(nil),dot()];
  if(variant===4)p=[text(`In the ${en}, a default body for `,`在${zh}中，以下方法具有默认实现：`),code(enter,true),text(' gives ','，返回'),code(self),text('; ','; '),code(exit,true),text(' has no concrete implementation and returns ','没有具体实现，默认返回'),code(nil),text(' by default.','。')];
  n=`${zh}为${enter}提供默认实现，返回${self}；${exit}${variant===4?'没有具体实现':'保持抽象'}，默认返回${nil}。`;
  cases.push(sample(split,'method-return-values',variant,j,p,n,{default_method:enter,default_returns:self,abstract_method:exit,abstract_returns:nil,object:en}));
  if(variant===1)p=[text('The ','该'),noun,text(' calls ','会调用'),code(a,true),text(' and returns ','并返回'),code(promise),text(' which resolves to ','，其解析结果为'),code(value),dot()];
  if(variant===2)p=[text(`The ${en} returns `,`${zh}返回`),code(promise),text(' from ','，它由以下调用产生：'),code(a,true),text('; the promise eventually yields ','；其最终结果为'),code(value),dot()];
  if(variant===3)p=[text('From ','调用'),code(a,true),text(` the ${en} gets a `,`，${zh}由此得到`),code(promise),text(' that later resolves with a ','，其随后解析得到的值为'),code(value),dot()];
  if(variant===4)p=[text('After ','以下调用先完成：'),code(a,true),text(` completes, the ${en} exposes a `,`，之后${zh}会提供`),code(promise),text(' whose result becomes ','，其结果为'),code(value),dot()];
  n=variant===1?`${zh}调用${a}，并返回解析结果为${value}的${promise}。`:variant===2?`${zh}返回由${a}产生的${promise}，其最终结果为${value}。`:variant===4?`${a}完成后，${zh}提供结果为${value}的${promise}。`:`${zh}调用${a}并获得${promise}，其随后解析结果为${value}。`;
  cases.push(sample(split,'promise-result',variant,j,p,n,{call:a,promise,result:value,object:en,after_completion:variant===4}));
  if(variant===1)p=[text('Call ','调用'),code(a,true),text(' before ','的时间应早于'),code(enter,true),text(` and do not discard the ${en}.`,`，并且不要丢弃${zh}。`)];
  if(variant===2)p=[text('Run ','执行'),code(a,true),text(' after ','前须先成功完成'),code(enter,true),text(` succeeds, but never overwrite the ${en}.`,`，但绝不能覆盖${zh}。`)];
  if(variant===3)p=[text('Do not invoke ','暂勿调用'),code(a,true),text(' until ','，须先等以下调用完成：'),code(enter,true),text(` finishes; keep the ${en} intact.`,`；保持${zh}完整。`)];
  if(variant===4)p=[text('Invoke ','调用'),code(a,true),text(' only after ','只能发生在以下调用返回后：'),code(enter,true),text(' returns; the ','；该'),noun,text(' must not be removed.','不得被移除。')];
  n=variant===1?`应先调用${a}，再调用${enter}，并且不要丢弃${zh}。`:variant===2?`${enter}成功后再执行${a}，但绝不能覆盖${zh}。`:variant===3?`须等${enter}完成后才调用${a}，并保持${zh}完整。`:`只有在${enter}返回后才可调用${a}，且不得移除${zh}。`;
  cases.push(sample(split,'order-negation',variant,j,p,n,{first:a,second:enter,relation:variant===1?'before':'after',object:en,negative_action:variant===1?'discard':variant===2?'overwrite':variant===4?'remove':null}));
 }
 return cases;
}
