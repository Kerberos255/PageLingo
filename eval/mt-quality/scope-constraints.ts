// Research only. These constraints reject unsafe scopes; they do not prove translation meaning.
export interface ScopeAnnotation {
  id: string; start: number; end: number; parent: string | null;
  immutable: boolean; kind: "format" | "block" | "flow" | "readonly";
}
export interface ScopeSpan {id: string; start: number; end: number}
export interface SourceScopeConstraint {
  id: string; parent: string | null; full_parent: boolean; exact_immutable: string | null;
  floor: number; ceiling: number; source_word_cut: boolean; format: boolean;
  literal_anchor: {start: number; end: number} | null;
  related_source_terms: Array<{text: string; start: number; end: number; shared_stem: string}>;
}
const words = (text: string, language: string) => [...new Intl.Segmenter(language, {granularity: "word"}).segment(text)]
  .filter(w => w.isWordLike).map(w => ({start: w.index, end: w.index + w.segment.length}));
const cutsWord = (start: number, end: number, lexical: Array<{start: number; end: number}>) => lexical.some(w =>
  w.start < start && start < w.end || w.start < end && end < w.end);

// This detects a source ambiguity, not a positive/negative meaning. A prefix
// relationship alone never identifies the correct Chinese translation.
function relatedSourceTerms(source: string, a: ScopeAnnotation, parent: {start: number; end: number}) {
  const focus = source.slice(a.start, a.end).trim();
  if (!/^[A-Za-z]+(?:-[A-Za-z]+)*$/u.test(focus)) return [];
  const forms = (word: string) => {
    const value = word.toLowerCase().replace(/-/gu, ""), values = new Set([value]);
    for (const prefix of ["de", "dis", "non", "un", "re", "en", "in", "im"]) {
      if (value.startsWith(prefix) && value.length - prefix.length >= 4) values.add(value.slice(prefix.length));
    }
    return values;
  };
  const focused = forms(focus), normalized = focus.toLowerCase().replace(/-/gu, "");
  return [...source.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*/gu)].flatMap(m => {
    const start = m.index, end = start + m[0].length;
    if (start < parent.start || end > parent.end || start < a.end && end > a.start
      || m[0].toLowerCase().replace(/-/gu, "") === normalized) return [];
    const shared = [...forms(m[0])].find(stem => stem.length >= 4 && focused.has(stem));
    return shared ? [{text: m[0], start, end, shared_stem: shared}] : [];
  });
}

export function deriveSourceScopeConstraints(sourceText: string, annotations: ScopeAnnotation[], target: string, immutable: ScopeSpan[]): SourceScopeConstraint[] {
  const byId = new Map(annotations.map(a => [a.id, a])), fixed = new Map(immutable.map(s => [s.id, s]));
  const lexical = words(sourceText, "en"), atoms = annotations.filter(a => a.immutable);
  if (byId.size !== annotations.length || atoms.some(a => !fixed.has(a.id))) throw new Error("Scope constraints need unique source and immutable identities");
  const literals = new Map<string, {start: number; end: number}>();
  for (const a of annotations) {
    if (a.immutable || a.kind !== "format") continue;
    const value = sourceText.slice(a.start, a.end);
    if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(value)) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = "(?<![A-Za-z0-9_$])" + escaped + "(?![A-Za-z0-9_$])";
    const sourceMatches = [...sourceText.matchAll(new RegExp(pattern, "gu"))], targetMatches = [...target.matchAll(new RegExp(pattern, "gu"))];
    if (sourceMatches.length === 1 && sourceMatches[0]!.index === a.start && targetMatches.length === 1) {
      literals.set(a.id, {start: targetMatches[0]!.index, end: targetMatches[0]!.index + value.length});
    }
  }
  // A unique unchanged literal belongs inside its original formatting scope.
  // Its exact position bounds disjoint sibling scopes without guessing the
  // complete translation of that literal's wrapper (which may expand in Chinese).
  const anchors = [...atoms, ...annotations.filter(a => literals.has(a.id))];
  const targetAnchor = (a: ScopeAnnotation) => fixed.get(a.id) ?? literals.get(a.id)!;
  return annotations.filter(a => !a.immutable).map(a => {
    const parent = a.parent === null ? {start: 0, end: sourceText.length} : byId.get(a.parent);
    if (!parent || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end)
      || a.start < parent.start || a.end > parent.end || a.start >= a.end) throw new Error("Scope constraints invalid source nesting");
    const before = anchors.filter(b => b.end <= a.start), after = anchors.filter(b => b.start >= a.end);
    const floor = Math.max(0, ...before.map(b => targetAnchor(b).end));
    const ceiling = Math.min(target.length, ...after.map(b => targetAnchor(b).start));
    if (floor > ceiling) throw new Error("Scope constraints reversed immutable fences");
    const exact = atoms.filter(b => b.start === a.start && b.end === a.end);
    return {id: a.id, parent: a.parent, full_parent: a.start === parent.start && a.end === parent.end,
      exact_immutable: exact.length === 1 ? exact[0]!.id : null, floor, ceiling,
      literal_anchor: literals.get(a.id) ?? null,
      related_source_terms: a.kind === "format" ? relatedSourceTerms(sourceText, a, parent) : [],
      source_word_cut: a.kind === "format" && cutsWord(a.start, a.end, lexical), format: a.kind === "format"};
  });
}

export function assertSourceScopeConstraints(sourceText: string, annotations: ScopeAnnotation[], target: string, immutable: ScopeSpan[], spans: ScopeSpan[], {rejectRelatedSourceConcepts = false}: {rejectRelatedSourceConcepts?: boolean} = {}) {
  const byId = new Map(spans.map(s => [s.id, s])), lexical = words(target, "zh");
  for (const c of deriveSourceScopeConstraints(sourceText, annotations, target, immutable)) {
    const s = byId.get(c.id), parent = c.parent === null ? {start: 0, end: target.length} : byId.get(c.parent);
    if (!s || !parent) throw new Error("Scope constraints missing proposed scope");
    if (s.start < c.floor || s.end > c.ceiling) throw new Error("Scope crosses an original immutable anchor fence");
    if (c.full_parent && (s.start !== parent.start || s.end !== parent.end)) throw new Error("Whole-parent source scope must cover the whole target parent");
    if (c.literal_anchor && (s.start > c.literal_anchor.start || s.end < c.literal_anchor.end)) throw new Error("Scope omits its unique unchanged formatted literal");
    if (c.exact_immutable) {
      const anchor = byId.get(c.exact_immutable)!;
      if (s.start !== anchor.start || s.end !== anchor.end) throw new Error("Code-only source wrapper must share its immutable scope");
    }
    if (!c.format) continue;
    if (c.source_word_cut || cutsWord(s.start, s.end, lexical)) throw new Error("Format scope cuts a source or target lexical word");
    if (c.full_parent || c.exact_immutable) continue;
    if (rejectRelatedSourceConcepts && c.related_source_terms.length && !c.literal_anchor) {
      throw new Error("Related source concepts lack an independent local scope witness");
    }
    // A neural choice is insufficient to distinguish identical target phrases.
    // Only source-owned immutable/literal fences narrow it, not guessed scopes.
    const value = target.slice(s.start, s.end);
    let matches = 0, next = c.floor;
    while (value && next <= c.ceiling - value.length) {
      const index = target.indexOf(value, next);
      if (index < 0 || index + value.length > c.ceiling) break;
      if (!cutsWord(index, index + value.length, lexical) && ++matches > 1) throw new Error("Repeated target scope lacks an immutable occurrence witness");
      next = index + 1;
    }
  }
}
