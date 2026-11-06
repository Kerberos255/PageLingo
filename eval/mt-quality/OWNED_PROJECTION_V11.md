# Production-owned frozen projection v11

This is an offline research path. The default PageLingo translator and model are unchanged. The production serializer has an opt-in ownership trace; no translation request is added or changed by enabling that trace. The v11 live-page evidence is a seen regression evaluation, not a new blind holdout or a browser model inference benchmark.

## Source ownership

`serializeRichSegment(root, {fixedTextSlots: true, captureOwnership: true})` records its own traversal. Consumers must not reconstruct ownership from `root.textContent` or a second set of DOM eligibility rules. The trace records:

- Exact original `Text` nodes and production slot IDs.
- Opaque code and literal text with no editable production slot, including independent punctuation and whitespace nodes.
- Inline wrappers and flattened block containers.
- Omitted generated, hidden, time and independent child roots, plus `BR`/`WBR` boundaries.
- Link-label fallback and transport trimming. Fallback text does not create a new editable slot.

`captureOwnedSource` checks the resulting logical text against the existing natural request preparation. Only production-owned slots can change. An explicit `translate="no"` slot is conservatively rejected by this experimental path; this does not change the production eligibility policy. Protected API declarations are excluded before replay.

## Frozen target and range contract

The candidate must reach EOS and pass existing translation-quality guards after immutable spans are masked. These guards detect some malformed/short outputs; they do not establish semantic equivalence.

The complete candidate text is frozen. Immutable anchors require one ordered, exact assignment. Code anchors use Latin identifier boundaries; literal punctuation/whitespace use literal matching. No punctuation normalization, deleted character, new carrier, target rewrite or manual span correction is allowed to make a case pass.

Each original format/block wrapper needs a target range. Explicit `FLOW` regions separate text around hard boundaries. A flow covering its complete source parent may inherit that parent's existing range; partial flows cannot claim the whole target. Proposed ranges must fit original nesting/order and allocate every target character to an existing owned slot or exact readonly anchor. Crossing ranges, absent carriers, ambiguous adjacent text nodes, invalid UTF-16 boundaries and nonoptional emptied slots are refused before original DOM writes.

The neural arm remains mutual argmax on frozen INT8 multilingual BERT features, cosine ≥ 0.55 and complete source content-word coverage, excluding only a/an/the. The public export is truncated pretrained multilingual BERT layer 8, not an asserted official fine-tuned AWESOME checkpoint. v11 does not loosen alignment thresholds or train this model.

## Source changes, application and restoration

Compilation and application check live node identity, parentage, tree order, attributes, URL, slot text and a fresh production trace. A stylesheet changing ownership invalidates an earlier capture. Excluded child-root/hidden text may change independently when the production input remains unchanged. Changes to owned text, readonly code/literals or structure invalidate pending results.

Live replay recaptures the current nodes and requires the exact request and ownership contract before using cached output. It binds review to the canonical source contract, complete candidate and exact ranges, not a sample ID. The contract intentionally excludes omitted child text, while the freshly captured frame preserves that text. `source_version_refreshed` in evidence means outer HTML differs from capture, not a global DOM version counter.

The compiler prepares application-owned detached markup using `textContent`, then calls the existing fixed-text renderer. It never accepts model HTML or replaces/moves original nodes. Application checks its invariants and clears its writes on failure. Restore retains later website text edits.

## Scope review is a research gate

`preview` compiles proposals without changing original DOM. `commit` additionally requires a `confirmed` review bound to that exact proposal. `wrong`, `uncertain`, absent and stale reviews refuse writes.

This is an assistant/human research annotation, not an automatic semantic validator or a production user approval flow. In v11 two `dereferencing → 引用` proposals remain wrong, and three `Note:/Warning:` proposals leave the colon outside the emphasis range. The reviewed live stage blocks them; the aligner itself has not solved them. Mechanically compilable does not mean semantically correct.

## Reproduction

Use fresh output paths: the tools refuse to overwrite earlier evidence. Capture public pages using `tools/mt-owned-projection-firefox.py --mode capture` with `--sites`, frozen v10 `--parent`, `--firefox`, `--geckodriver` and `--output`. The helper uses the configured proxy, a temporary trusted public-CA profile and `acceptInsecureCerts=false`.

Create each plan with `node tools/mt-owned-projection.mjs --mode plan --parent <v10-plan> --capture <capture-result> --native <v10-native-run> --out <new-plan>`. Plans pin source hashes, parent/native/capture digests, model identity and exact cached requests. This step refuses candidates before encoder inference where possible. It never requests training or translator generations.

Run `tools/mt-frozen-align.py --plan <new-plan> --model <onnx-directory> --sha256 <model-sha> --output <new-alignment>` in the matched Python runtime. Then run `node tools/mt-owned-projection.mjs --mode input --plan <new-plan> --run <new-alignment> --model <label> --out <new-input>`. The input retains every supported source, including refusals. Preview and commit use the same Firefox tool with `--mode preview|commit --input <input>` and the capture arguments. Review decisions must be recorded after inspecting the preview and before committing; do not alter the target or spans.

Evidence must retain exact inputs/outputs, refusals, reviews, runtime/source snapshots, hashes and full page captures. Report source coverage, candidate acceptance, mechanical compilation, reviewed admission and structural checks separately. Keep excluded sources and source changes outside model-error rates. A lower display count caused by strict independent punctuation ownership is not proof of lower translation quality.

## Release gate

Keep this path disabled by default until an automatic range method passes independent complex-page cases, including compound concepts, punctuation scope, reordered/repeated anchors, nested links, hidden/child roots and BR/block boundaries. Correct punctuation ownership or prompt contracts in a separate evaluated arm; never grant arbitrary writes to readonly code/identifiers. Neither training PageLingo-MT nor switching weights is justified by v11's ownership/word-alignment failures alone.
