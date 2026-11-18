# v29 paired paraphrase pilot

This is an experimental GPU handoff, not an approved model release. Production prompts, DOM handling and the formal Q5_K_M model stay unchanged. The v28 compact-context experiment repaired some consumed examples but did not improve its new-page or actual Firefox comparisons; see [the retained results](../../eval/mt-quality/results/2026-11-16-mt-compact-context-v28.md).

The next question is whether a small update can teach ordinary Chinese paraphrases around immutable code positions without damaging natural translation. The two candidates start independently from the verified formal v0.2.2 adapter, use identical source/target rows and optimizer settings, and differ only in their fixed-task prompts. The compact arm uses the archived v28 `scope-map` prompt; the legacy arm uses the existing production prompt. This compares complete prompt policies, including permission to rearrange plain prose, rather than isolating the code map alone.

| Item | Frozen value |
| --- | --- |
| Base | `tencent/Hy-MT2-1.8B`, local original BF16 weights |
| Base file SHA-256 | `29e9117a44c79f81857613601968ff482d8a23c2d6736a1710bba9e5ca4762e5` |
| Initial adapter | `outputs/pagelingo-hymt-1.8b-v0.2.2-micro-repair/final` |
| Adapter file SHA-256 | `28a0bd981feab75390ec045a9b97b02401e8a5ab973118d7e54da7b9e77cf859` |
| Adapter config SHA-256 | `1e55f31f99fc13ea21a25bc4f4b8c60f1b5a6b3d52ff6497ab778b1f4a4efa10` |
| Candidates | Legacy prompt and compact prompt; fresh loads of the same adapter |
| Optimization | Final 32 steps each, 64 total; LR `5e-6`; batch 1; accumulation 8; seed 42 |
| LoRA | Rank 32, alpha 64; dropout disabled; base frozen |
| Loss | Sequence mean target CE, supervised EOS; prompt/padding masked |
| Training | 128 authored source pairs; 256 rows per candidate, half fixed and half natural |
| Validation | 32 other source pairs; 64 rows per candidate |
| Synthetic holdout | 32 other source pairs; no optimizer access |

The 192 sources cover eight relation categories and 32 split-disjoint syntactic families. Protected identifiers use deterministic hexadecimal nonces. References were authored and audited by the assistant, not independently human reviewed. Every fixed reference passes the unchanged production decoder; this establishes frame validity, not automatically proven semantic equivalence. Source and delexicalized wire identities are checked against visible prior project material. No model output is used as a training target.

Before any model load, the GPU host must also compare all 192 authored and six new web sources against the frozen original-data hash inventory. The inventory covers 24 original data files and 6,429 recognized canonical/delexicalized sources; the original file hashes are verified again. A missing inventory, modified source file or collision stops the workflow. The inventory was collected while the share was readable, but its complete comparison was not finished remotely after SMB became unavailable. The package therefore requires the actual local check rather than claiming it passed. Exact recognized-format exclusions cannot prove semantic novelty or absence from foundation-model pretraining.

The fresh web paragraphs were selected from MDN Promise/then, Python asyncio synchronization and Rust Result documentation before any v29 generation. A subsequent static-data amendment removed split/template numerals from authored protected names; it changed neither the web sources nor the authored English templates or semantic reference policy. All real web sources remain evaluation only.

## Frozen GPU evaluation

Each of the formal baseline and two candidates receives the same 168 unconstrained BF16 requests: 96 synthetic holdout requests (32 sources × legacy/compact/natural), 12 new-web requests (six × legacy/compact), 28 consumed v28 regression requests, and 32 consumed FLORES regression requests. Total: at most 504 generation calls. Only source user messages and output budgets reach generation. Production grammar is stored for downstream native/WASM checks but is not applied during BF16 evaluation. Raw generations, token identities, timing and partial failures are retained.

The formal baseline is generated before either update. Both candidates use the same initial trainable-tensor digest, which is recorded before optimization and is distinct from the serialized adapter-file SHA-256. The second candidate must match the first initialization; it never resumes the first candidate's trained weights. Validation loss does not choose a checkpoint or a winner.

## Main PC entry

Keep the existing `PageLingo-MT.cmd` environment entry. Open it on the GPU PC at its local `E:\PageLingo-MT` directory, then run `x.cmd`. The root needs only these two CMD files. The immutable kit and active-task pointer use a new `paraphrase-v29` prefix, so an old completed scope-choice task cannot silently consume this run.

The launcher uses the existing environment and places caches, temporary files and output on the project drive. It performs private-source exclusion, file/tokenizer/EOS checks, formal BF16 baseline, two training runs, candidate BF16 evaluation, and a model-free `gpu-handoff.zip`. It installs nothing and runs no Firefox, CPU conversion or upload. It preserves original models and prior results. `x.cmd status` is read-only; `x.cmd check` performs preflight without training and does not consume the actual run. Repeating a completed task does not start another training process.

The first baseline run encountered Windows error 5 while replacing its progress JSON. Its saved file contains 148 generations, and the complete temporary checkpoint contains the same 148 followed by one more. The recovery package pins both files and the failed run metadata. It verifies every recovered prompt and tokenizer ID hash against the frozen plan, then generates the last 19 baseline outputs before starting the two candidates. The original run remains available for diagnosis. Checkpoint replacement retries transient Windows sharing errors. During an active run, monitor the append-only stage logs and open the progress JSON after its writer has stopped.

After return of the handoff, Cloud performs semantic review, quantization, native regression, and actual Firefox/wllama tests. Adapters remain on the main PC until needed for conversion. No GPU training is started through MCP.

## Acceptance

No automatic winner, upload or production activation is allowed. A replacement needs at least two complete repairs on the frozen new real paragraphs in actual Firefox against formal production, no new critical semantic or code/link/emphasis ownership regression, exact DOM restoration, and median first-output latency at most 1.5 times baseline. BF16/native-only improvement or lower loss does not satisfy this gate. Negative and partial results are retained.

## Reproduce the package

From a verified clean source commit:

```sh
npm run eval:mt-paraphrase
python -m unittest discover -s training/mt-fixed-slots/tests
python tools/mt-paraphrase-package.py \
  --out /path/to/new-kit \
  --data artifacts/mt-quality/paraphrase-v29-data \
  --plan artifacts/mt-quality/paraphrase-v29-plan.json \
  --web eval/mt-quality/external/paraphrase-web-v29.json \
  --private-plan /path/to/private-exclusion-plan.json \
  --registration /path/to/preregister.json
```

The private plan binds the frozen inventory identity and generated source fingerprints; it does not contain private targets. The builder checks paired targets, data/source bindings, archive CRC and member hashes. Run the packaged `research_v2.py --root <kit-parent-project> --plan` for a stdlib-only plan check without loading models or consuming the task.
