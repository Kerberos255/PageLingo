// Input provenance verification for recorded GPU semantic runs. Pure data checks;
// no inference or accuracy claim is implied by a valid capture.
export interface CapturedSemanticJob {
  key: string; case_id: string; mode: string; request_sha256: string;
  request?: {messages: Array<{role: string; content: string}>; max_tokens: number};
  request_template?: {prefix: string; suffix: string; max_tokens: number}; draft_from_key?: string;
}
export async function verifySemanticCapture(jobs: CapturedSemanticJob[], rows: any[], digest: (value: string) => string | Promise<string>) {
  if (jobs.length !== rows.length) throw new Error("Incomplete semantic capture");
  const prior = new Map<string, any>();
  for (const [index, job] of jobs.entries()) {
    const row = rows[index];
    if (job.request_sha256 !== await digest(JSON.stringify(job.request ?? job.request_template))) throw new Error("Frozen semantic request digest changed");
    if (row.key !== job.key || row.case_id !== job.case_id || row.mode !== job.mode || row.planned_request_sha256 !== job.request_sha256) throw new Error("Semantic job identity changed");
    let request = job.request;
    if (job.mode === "rewrite") {
      const draft = prior.get(job.draft_from_key!);
      if (!draft?.executed || draft.finish_reason !== "stop") {
        if (row.executed || row.finish_reason !== "skipped") throw new Error("An incomplete draft was compiled");
        prior.set(job.key, row); continue;
      }
      if (row.executed) {
        if (row.draft_from_key !== job.draft_from_key || row.draft_text_sha256 !== await digest(draft.text)) throw new Error("Rewrite used an unrelated draft");
        request = {messages: [{role: "user", content: job.request_template!.prefix + JSON.stringify(draft.text) + job.request_template!.suffix}], max_tokens: job.request_template!.max_tokens};
        if (JSON.stringify(row.actual_messages) !== JSON.stringify(request.messages)) throw new Error("Rewrite actual prompt changed");
      } else {
        if (row.finish_reason !== "skipped" || !row.skip_reason?.includes("context")) throw new Error("Unexpected skipped rewrite");
        prior.set(job.key, row); continue;
      }
    }
    if (!row.executed || !request || row.actual_request_sha256 !== await digest(JSON.stringify(request)) || row.max_tokens !== request.max_tokens) throw new Error("Actual semantic request changed");
    if (!Number.isInteger(row.prompt_tokens) || row.prompt_tokens < 1 || row.prompt_tokens + row.max_tokens > 3072 || !/^[a-f0-9]{64}$/u.test(row.input_ids_sha256) || !/^[a-f0-9]{64}$/u.test(row.prompt_sha256)) throw new Error("Invalid recorded token identity or context");
    if (!Number.isInteger(row.new_tokens) || row.new_tokens < 1 || row.new_tokens > row.max_tokens) throw new Error("Invalid generated token count");
    if (row.finish_reason !== (row.last_token_id === 120020 ? "stop" : row.new_tokens >= row.max_tokens ? "length" : "other")) throw new Error("Recorded EOS/finish status changed");
    prior.set(job.key, row);
  }
}
