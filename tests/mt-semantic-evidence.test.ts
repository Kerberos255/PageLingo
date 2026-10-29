import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import {verifySemanticCapture, type CapturedSemanticJob} from "../eval/mt-quality/semantic-evidence";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function capture() {
  const request = {messages: [{role: "user", content: "English"}], max_tokens: 48};
  const frame = {prefix: "prefix", suffix: "suffix", max_tokens: 48};
  const jobs: CapturedSemanticJob[] = [
    {key: "natural/a", case_id: "a", mode: "natural", request, request_sha256: hash(JSON.stringify(request))},
    {key: "rewrite/a", case_id: "a", mode: "rewrite", request_template: frame, draft_from_key: "natural/a", request_sha256: hash(JSON.stringify(frame))},
  ];
  const draft = '中文\n"draft"', chained = {messages: [{role: "user", content: frame.prefix + JSON.stringify(draft) + frame.suffix}], max_tokens: 48};
  const common = {executed: true, finish_reason: "stop", last_token_id: 120020, new_tokens: 12, prompt_tokens: 100, input_ids_sha256: "a".repeat(64), prompt_sha256: "b".repeat(64), max_tokens: 48};
  return {jobs, rows: [{...common, key: jobs[0]!.key, case_id: "a", mode: "natural", planned_request_sha256: jobs[0]!.request_sha256, actual_request_sha256: hash(JSON.stringify(request)), text: draft},
    {...common, key: jobs[1]!.key, case_id: "a", mode: "rewrite", planned_request_sha256: jobs[1]!.request_sha256, actual_request_sha256: hash(JSON.stringify(chained)), actual_messages: chained.messages,
      draft_from_key: jobs[0]!.key, draft_text_sha256: hash(draft), text: "framed target"}]};
}
describe("semantic capture provenance", () => {
  it("checks a chain constructed from its own exact recorded draft", async () => {const c = capture(); await verifySemanticCapture(c.jobs, c.rows, hash);});
  it("rejects unrelated drafts, changed actual prompts and mismatched token/stop identities", async () => {
    for (const mutate of [(rows: any[]) => {rows[1].draft_text_sha256 = "0".repeat(64);},
      (rows: any[]) => {rows[1].actual_messages[0].content = "another model's draft";},
      (rows: any[]) => {rows[0].actual_request_sha256 = "0".repeat(64);},
      (rows: any[]) => {rows[0].last_token_id = 3;},
      (rows: any[]) => {rows[0].prompt_tokens = 3072;}]) {
      const c = capture(); mutate(c.rows); await expect(verifySemanticCapture(c.jobs, c.rows, hash)).rejects.toThrow();
    }
  });
});
