# Typed prose punctuation and label scope v12

This experimental en→zh-Hans arm extends [v11 ownership](OWNED_PROJECTION_V11.md). It keeps the default provider/model path unchanged. Original production MT slots, natural requests and fixed requests are preserved. The additional writing authority described here is explicitly bounded; it must not be described as editing only the original production MT slots.

## Writing authority

The serializer's opt-in trace records `editableContext` from the same production context policy used for ordinary text. Pure counters, dates, identifiers and whitespace still do not become model slots. The default eligibility and request behavior are unchanged.

With `captureOwnedSource(root, {punctuationPolicy: "prose-v1"})`, the application may additionally own an existing standalone text node containing exactly one ASCII prose mark plus ASCII horizontal whitespace. Allowed alternatives are:

| Source | Allowed target mark |
| --- | --- |
| `.` | `.` / `。` |
| `,` | `,` / `，` / `、` |
| `:` | `:` / `：` |
| `;` | `;` / `；` |
| `!` | `!` / `！` |
| `?` | `?` / `？` |

The node must be in an eligible visible prose context, outside links, explicit no-translate ancestry and whitespace-preserving CSS (`pre`, `pre-wrap`, `break-spaces`). Its source prefix must contain letters. When text follows, the punctuation must be separated from that text by whitespace. Compact dotted identifiers, URL schemes, versions, operators, digits, quotes, NBSP and arbitrary symbols are not admitted by this contract. Code descendants remain opaque and unchanged.

Whitespace in an admitted punctuation node may use zero or more ASCII spaces/tabs; arbitrary whitespace-only nodes remain readonly. A terminal source punctuation role must map to the absolute end of the target, rather than an earlier sentence or a punctuation mark inside code. Other roles need one ordered assignment together with every protected anchor. Multiple valid assignments remain a refusal.

The extra slots are program-owned original Text objects, separate from `segment.textSlots`, and do not enter the model prompt. The annotation's legacy `immutable: true` denotes a deterministic anchor in this arm: `anchor_kind: "prose-punctuation"` has the finite alternative rule above; opaque code and literal anchors retain byte-for-byte equality. No arbitrary text writing is authorized by the new role.

The compiler validates the complete frozen target, all anchor assignments and original nesting/order before writing. A punctuation slot can receive only its matched typed mark and permitted horizontal whitespace. It cannot become an empty carrier, accept words/HTML or consume protected code. The existing fixed-text renderer applies the bounded edits and restores the original Text objects. Later website edits win during restore. Source changes and CSS changes that invalidate punctuation ownership reject pending writes.

## Format label colon

For a mutable format annotation whose source text ends in `:`, the original wrapper must include the target `:` or `：`. The projection postprocessor may include exactly one immediately adjacent equivalent colon. It may not skip whitespace/words, search a later colon, expand across words or rewrite the candidate. The compiler independently rejects an incomplete colon scope and still rejects crossing/nonnested ranges after this adjustment.

This is an explicit source-derived delimiter rule, not a manual repair to one sample. Raw and adjusted offsets are saved in projection diagnostics. It does not complete concepts such as `dereferencing` and does not prove phrase meaning.

## Experiment and release limits

Use `tools/mt-owned-projection-firefox.py --mode capture --punctuation-policy prose-v1` with the v11 arguments. Plan creation selects `typed-punctuation-projection-v12`, pins all source/evaluation TypeScript dependencies plus the tools, and records the extra writing authority. Existing strict captures still use v11 rules. The aligner keeps the same weights, threshold 0.55 and complete source content-word coverage; only the typed anchor resolver and label-colon closure differ.

Preview leaves original DOM untouched. Live writes continue to require a research review bound to source contract, policy, complete candidate and exact spans. No unreviewed/wrong/uncertain proposal is admitted. The review is not an automatic semantic validator or a product approval UI. The final admission decision must also refuse a known substantial meaning error; record scope and whole-meaning grades separately. The browser's legacy `scope_rejected` status covers any failed bound research review and must not be counted as exclusively a scope error. Minor terminology/style issues remain explicitly labeled.

v10/v11 pages are seen regressions. The additional MDN HTTP caching, Python logging and Docker build pages use the existing source-only complexity selection before any new model output. Both natural and fixed requests run through the unchanged native CPU runner using the formal v0.2.2 Q5 model. These selected pages are new to this experiment, not random web sampling or an independently human-blinded quality benchmark. They are evaluation-only and never optimizer input.

After those initial new-page results exposed a coverage gap (the admitted rows had no standalone punctuation role), an additional source-only stratum selects the first DOM-order paragraph per page with 80..420 normalized characters and a bounded terminal role, excluding the 10 previously generated sources. Its model outputs are generated only after selection. This added stratum is separately labeled as a response to the coverage gap, not part of the original preregistration; all original refusals remain in the report.

Keep default integration disabled until automatic complete phrase scopes and independent page regressions pass. A higher candidate/display count is not enough. Report candidate refusals, alignment refusals, compilation refusals, reviewed scope decisions, actual writes and structural checks separately; do not label valid Chinese punctuation substitutions as translation errors.
