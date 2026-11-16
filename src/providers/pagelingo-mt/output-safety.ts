interface SlotText {source: string}

// Detect protocol echoes, not general imperative prose. Compare bilingual
// categories with the source so documentation about these instructions remains valid.
const instructionFeatures = [
  /\bnumbered\s+(?:pairs?|text\s+nodes?)\b|(?:每(?:个|一)?|所有|原)(?:编号对|编号字符(?:组)?)/iu,
  /\bfixed\s+text\s+(?:nodes?|slots?)\b|固定(?:的)?(?:文本|文字)(?:节点|槽)/iu,
  /\b(?:protected|opaque)\s+(?:tokens?|markers?|slots?)\b|受保护(?:的)?(?:标记|令牌|token|槽)/iu,
  /\b(?:output\s+only|only\s+output|do\s+not\s+add\s+(?:html|explanations?|labels?))\b|只(?:能|需|要)?输出[^。\n]{0,32}(?:译文|翻译|标记)|不要(?:添加|输出)[^。\n]{0,16}(?:HTML|解释|标签|注释)/iu,
  /\btranslate\s+(?:the\s+following|(?:this|the)\s+(?:english|source)\s+text)\b|将(?:以下|英文|英语|源文)[^。\n]{0,32}(?:译为|翻译(?:成|为)?)(?:简体)?中文/iu,
  /\b(?:hard\s+constraints?|translation\s+task|constraint\s+requirements?)\b|【(?:硬性要求|约束要求|待翻译文本|翻译任务|源文)】/iu,
];
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

export function assertMtOutputSafety(slots: readonly SlotText[], values: readonly string[]): void {
  const source = slots.map(slot => slot.source).join("\n"), translated = values.join("\n");
  const introduced = instructionFeatures.map(feature => feature.test(translated) && !feature.test(source));
  if (introduced.filter(Boolean).length >= 2 && [0, 1, 2, 5].some(index => introduced[index])) {
    throw new Error("MT introduced protocol instructions into the translation; original paragraph retained");
  }

  // A short connective cannot own the same complete multi-sentence passage as
  // another slot. Leave ordinary repeated labels, source repetitions and long
  // equivalent source passages alone; this is not a general semantic classifier.
  const seen = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const text = normalize(value);
    if ((text.match(/[\u3400-\u9fff]/gu) ?? []).length < 24 || (text.match(/[。！？!?]/gu) ?? []).length < 2) continue;
    const other = seen.get(text);
    if (other !== undefined) {
      const left = slots[other]!.source, right = slots[index]!.source;
      const isShortConnective = (s: string) => (s.match(/[A-Za-z]+/gu) ?? []).length <= 4 && normalize(s).length <= 24;
      if (normalize(left) !== normalize(right) && (isShortConnective(left) || isShortConnective(right))) {
        throw new Error("MT repeated a whole passage in unrelated text slots; original paragraph retained");
      }
    } else seen.set(text, index);
  }
}
