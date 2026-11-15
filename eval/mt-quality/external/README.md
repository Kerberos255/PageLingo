# External evaluation references

`flores200-32.json` contains 32 English/Simplified-Chinese dev pairs sampled from the original FLORES-200 release, before the new candidates were trained or generated. It is evaluation data only and is excluded from optimizer inputs.

Source: [FLORES-200](https://github.com/facebookresearch/flores/tree/main/flores200), NLLB Team et al. (2022), distributed by Meta. The original archive URL, SHA-256, sampling seed and line numbers are recorded in the JSON. The English text is HTML-escaped for the fixture representation; the underlying source and reference wording is unchanged.

The source/reference text in that file remains under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), including attribution to the FLORES-200 contributors. This data license applies to these external texts, separately from the project's software license. Publication of the benchmark does not establish that a pretrained model has never seen it.

`independent-web-v23.json` freezes eight source paragraphs selected from four new website URLs before observing model output, plus two separately registered post-diagnostic confirmation paragraphs. It records source HTML, URLs, selection rules, normalized hashes and source attribution. These cases are evaluation only, are not optimizer inputs, and contain no preferred target translations. Local duplicate checks cover only visible project material; they do not establish absence from foundation-model pretraining. See the [v23 results](../results/2026-11-14-independent-web-v23.md) for actual model output and rejected experiments. Excerpts remain under their original sources' content terms.

`independent-web-v24.json` adds six source-only selections from MDN streams, PostgreSQL constraints and Node.js error documentation, frozen before the protected-literal experiment. It records the preregistered selection, normalized hashes and attribution; it is evaluation only and excluded from optimizer inputs. See the [v24 results](../results/2026-11-15-mt-cache-and-context-v24.md) for the rejected protocol, retained cache optimization and actual outputs. Original source content terms continue to apply.
