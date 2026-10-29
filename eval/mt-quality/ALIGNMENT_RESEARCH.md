# 句级翻译与原始文本节点对齐研究

[本轮实测和发布判断](results/2026-10-29-sentence-alignment.md)记录 132 次实际 CPU 生成、99 次 Firefox 输出回放，以及独立验证的 8 项生产结构回归。所有对齐代码仅位于 `eval/`，扩展默认推理不导入它们。

## 两种研究方法

`sentence-alignment.ts` 只给链接、强调、普通格式 span 和不可变代码等边界加标记，应用文本槽包装不发给模型。提供受保护内容的只读上下文。输出必须按原顺序包含所有边界，且全部文字可以投影回原文本槽，再经过现有固定槽解码与质量检查。没有可承接 Text 的文字、多节点歧义或不完整生成会保留整段原文。

`phrase-alignment.ts` 另做完整草稿和独立格式短语翻译，使用精确唯一子串定位后再要求相同顺序和完整覆盖。它不使用按字符长度切分、模糊置信分数或模型自报置信度。这个方案覆盖率不足，未启用；唯一子串也不是语义正确性证明。

## 原生 CPU 计划、采集与回放

需要 Node 24 项目依赖、已有 llama.cpp server 和自行提供的 GGUF。工具不会下载或上传模型，不接入主力机 GPU。

```bash
node tools/mt-sentence-alignment.mjs plan \
  --input /path/to/matrix-plan.json \
  --ids release-v2-handoff-order-before,release-v2-handoff-order-after,d-asyncio-task-04,d-pythread-06,d-html-headings-05,v2-hard-validation-check-before-connect-0,v2-hard-validation-history-before-prune-0,v2-hard-validation-after-exchange-0,v2-hard-validation-stop-before-close-0 \
  --output artifacts/research/sentence-plan.json

python3 tools/mt-sentence-native.py \
  --server /path/to/llama-server --model /path/to/model.gguf \
  --sha256 EXPECTED_GGUF_SHA256 \
  --plan artifacts/research/sentence-plan.json \
  --output artifacts/research/sentence-run

node tools/mt-sentence-alignment.mjs replay \
  --input artifacts/research/sentence-plan.json \
  --results artifacts/research/sentence-run/run.json \
  --output artifacts/research/sentence-replay.json

node tools/mt-phrase-alignment.mjs plan \
  --input artifacts/research/sentence-plan.json \
  --output artifacts/research/phrase-plan.json

python3 tools/mt-sentence-native.py \
  --server /path/to/llama-server --model /path/to/model.gguf \
  --sha256 EXPECTED_GGUF_SHA256 \
  --plan artifacts/research/phrase-plan.json \
  --output artifacts/research/phrase-run

node tools/mt-phrase-alignment.mjs replay \
  --input artifacts/research/phrase-plan.json \
  --results artifacts/research/phrase-run/run.json \
  --output artifacts/research/phrase-replay.json
```

输入可以是含 `cases` 的质量 corpus 或此前冻结的 matrix-plan。研究编码器保守拒绝不能唯一投影的多节点区域，不支持的样本不能当作成功生成。模型 SHA、完整计划 SHA、实际提示和 token 摘要、请求 SHA、EOS/截断、首输出和速度均记录。原生工具使用 Linux `/proc` 记录 RSS 高水位；运行结果目录必须是新的。

计划冻结执行源码。后续改动生产源码后，旧计划的回放会拒绝来源不匹配。要逐字核对本轮实验，应使用证据包的 `frozen-source/`，不要修改旧计划中的来源摘要；当前源码可生成新的独立计划。生产结构修复在模型诊断结束后单独验证，不与原始模型实测混算。

## Firefox

需要已安装 Firefox、geckodriver 和 Selenium；主力机无需安装浏览器。

```bash
python3 tools/mt-alignment-firefox.py \
  --sentence-plan artifacts/research/sentence-plan.json \
  --sentence-runs artifacts/research/sentence-run/run.json \
  --phrase-plan artifacts/research/phrase-plan.json \
  --phrase-runs artifacts/research/phrase-run/run.json \
  --firefox /path/to/firefox --geckodriver /path/to/geckodriver \
  --output artifacts/research/firefox-replay

python3 tools/mt-structure-firefox.py \
  --firefox /path/to/firefox --geckodriver /path/to/geckodriver \
  --output artifacts/research/production-structure
```

第一项严格核对冻结结果并用真实 `PageTranslator` 回放；不是重新在 wllama 生成。第二项使用确定性 completion，验证动态所有权、网站更新、链接、原始节点恢复及长槽位分句；不是翻译质量测试。两者均只服务本机回环页面，输出完整结果 JSON，失败返回非零。

第二项也由 `.github/workflows/browser-regression.yml` 在 PR 中自动执行，结果与浏览器运行时摘要随工作流 artifact 上传，无需 Hugging Face 访问权限或主力机 GPU。
