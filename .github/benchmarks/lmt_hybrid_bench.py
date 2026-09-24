import json
import re
import time
from pathlib import Path

import requests
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

BASE = "http://127.0.0.1:1234"
OUT = Path("lmt-hybrid-bench")
SITES = [
    ("openclaw", "https://docs.openclaw.ai/quickstart"),
    ("github", "https://github.com/openclaw/openclaw"),
]
MODEL_REPO = "https://huggingface.co/mradermacher/LMT-60-0.6B-GGUF"
QUANT = "Q4_K_M"

TOKEN_RE = re.compile(r"__PL_[SEP][0-9]{4}__")
SLOT_RE = re.compile(r"__PL_S([0-9]{4})__(.*?)__PL_E\1__", re.S)
PROTECT_RE = re.compile(
    r"https?://[^\s<]+|"
    r"\b(?:OpenClaw|GitHub|Node[.]js|PowerShell|WebChat|WSL2|CLI|API|HTTP|HTTPS|JSON|YAML|npm|npx|Codex|Claude|DeepWiki|Docker|Nix|macOS|iOS|Android|Windows|Linux|Discord|iMessage|Slack|Teams|Telegram|WhatsApp)\b|"
    r"\b[A-Za-z][A-Za-z0-9_.]*-[A-Za-z0-9_.-]+\b"
)

SYSTEM = """You are a precise machine-translation engine.
Translate English to Simplified Chinese.
The user supplies READ-ONLY CONTEXT plus one MARKED_STREAM for the same web block.
Translate only the human-readable English inside each __PL_S####__ ... __PL_E####__ pair.
Use the entire context to understand meaning, but never output the context itself.
Every __PL_S####__, __PL_E####__, and __PL_P####__ token is immutable.
Copy all immutable tokens exactly once and in exactly the same order.
Never move meaning between slots, repeat neighboring text, add explanations, or output Markdown.
Return only the complete MARKED_STREAM."""

RETRY_SYSTEM = SYSTEM + """
This is a format retry. Preserve the immutable-token sequence exactly.
Output nothing before the first __PL_S token or after the final __PL_E token."""

COLLECT = r"""
const sels=["main h1","main h2","main h3","main p","main li","article h1","article h2","article h3","article p","article li",".markdown-body h1",".markdown-body h2",".markdown-body h3",".markdown-body p",".markdown-body li"];
const out=[],seen=new Set();
function fp(root){
  const rows=[];
  const walk=e=>{
    if(e.nodeType!==1)return;
    const attrs=[...e.attributes].filter(a=>a.name!=="data-pl-bench").map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0]));
    rows.push([e.tagName,attrs]);
    for(const c of e.children)walk(c);
  };
  walk(root);return JSON.stringify(rows);
}
function nodes(root){
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),a=[];let n;
  while(n=w.nextNode()){
    const p=n.parentElement;
    if(!p||p.closest("script,style,noscript,svg,button,[aria-hidden=true],code,pre,kbd,samp"))continue;
    const raw=n.nodeValue||"",trim=raw.trim();
    if(!trim||!/[A-Za-z]{2}/.test(trim))continue;
    const at=raw.indexOf(trim);
    a.push({text:trim,lead:raw.slice(0,at),trail:raw.slice(at+trim.length)});
  }
  return a;
}
for(const sel of sels)for(const el of document.querySelectorAll(sel)){
  if(seen.has(el)||el.closest("nav,footer,aside,[role=navigation]"))continue;
  const r=el.getBoundingClientRect(),t=(el.innerText||"").trim().replace(/\s+/g," ");
  if(r.width<10||r.height<8||t.length<25||t.length>650||!/[A-Za-z]{3}/.test(t))continue;
  const id="pl-"+out.length;el.dataset.plBench=id;seen.add(el);
  out.push({id,text:t,fingerprint:fp(el),nodes:nodes(el)});
  if(out.length>=12)return out;
}
return out;
"""

APPLY = r"""
const el=document.querySelector('[data-pl-bench="'+arguments[0]+'"]');
if(!el)return {found:false};
const translations=arguments[1],w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),a=[];let n;
while(n=w.nextNode()){
  const p=n.parentElement;
  if(!p||p.closest("script,style,noscript,svg,button,[aria-hidden=true],code,pre,kbd,samp"))continue;
  const raw=n.nodeValue||"",trim=raw.trim();
  if(!trim||!/[A-Za-z]{2}/.test(trim))continue;
  const at=raw.indexOf(trim);
  a.push({node:n,lead:raw.slice(0,at),trail:raw.slice(at+trim.length)});
}
if(a.length!==translations.length)return {found:true,count_ok:false};
a.forEach((x,i)=>x.node.nodeValue=x.lead+translations[i]+x.trail);
function fp(root){
  const rows=[];
  const walk=e=>{
    if(e.nodeType!==1)return;
    const attrs=[...e.attributes].filter(a=>a.name!=="data-pl-bench").map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0]));
    rows.push([e.tagName,attrs]);
    for(const c of e.children)walk(c);
  };
  walk(root);return JSON.stringify(rows);
}
return {found:true,count_ok:true,fingerprint:fp(el),text:(el.innerText||"").trim().replace(/\s+/g," ")};
"""

def api(path, method="GET", payload=None, timeout=240):
    response = requests.request(method, BASE + path, json=payload, timeout=timeout)
    if not response.ok:
        raise RuntimeError("{} {}: {} {}".format(method, path, response.status_code, response.text[:800]))
    return response.json()

def unload():
    try:
        for model in api("/api/v1/models").get("models", []):
            for inst in model.get("loaded_instances", []) or []:
                iid = inst.get("id") or inst.get("instance_id")
                if iid:
                    requests.post(BASE + "/api/v1/models/unload", json={"instance_id": iid}, timeout=30)
    except Exception as exc:
        print("UNLOAD_WARN", repr(exc), flush=True)

def download_model():
    last = None
    for attempt in range(1, 5):
        try:
            start = api("/api/v1/models/download", "POST", {"model": MODEL_REPO, "quantization": QUANT})
            if start.get("status") not in ("completed", "already_downloaded"):
                job = start.get("job_id")
                if not job:
                    raise RuntimeError("missing download job")
                for _ in range(480):
                    status = api("/api/v1/models/download/status/" + job)
                    if status.get("status") == "completed":
                        break
                    if status.get("status") == "failed":
                        raise RuntimeError(json.dumps(status))
                    time.sleep(1)
                else:
                    raise RuntimeError("download timeout")

            for _ in range(120):
                for model in api("/api/v1/models").get("models", []):
                    desc = "{} {}".format(model.get("key",""), model.get("display_name","")).lower()
                    if model.get("type") == "llm" and "lmt-60-0.6b" in desc:
                        return model
                time.sleep(1)
            raise RuntimeError("model not indexed")
        except Exception as exc:
            last = exc
            print("DOWNLOAD_RETRY", attempt, repr(exc), flush=True)
            time.sleep(min(5 * attempt, 15))
    raise RuntimeError("download failed: {}".format(last))

def load_model(model):
    result = api("/api/v1/models/load", "POST", {
        "model": model["key"],
        "context_length": 8192,
        "flash_attention": False,
        "offload_kv_cache_to_gpu": False,
        "echo_load_config": True,
    })
    if result.get("status") != "loaded":
        raise RuntimeError(json.dumps(result))
    return model["key"]

def chat(model, text, max_tokens=1536):
    started = time.perf_counter()
    response = api("/api/v1/chat", "POST", {
        "model": model,
        "input": text,
        "temperature": 0,
        "max_output_tokens": max_tokens,
        "reasoning": "off",
        "context_length": 8192,
        "store": False,
    }, timeout=180)
    elapsed = (time.perf_counter() - started) * 1000
    output = "\n".join(
        item.get("content","")
        for item in response.get("output",[])
        if item.get("type") == "message"
    ).strip()
    return output, elapsed

def browser():
    options = Options()
    options.add_argument("-headless")
    options.set_preference("font.name.sans-serif.zh-CN", "Noto Sans CJK SC")
    driver = webdriver.Firefox(options=options)
    driver.set_window_size(1440, 1200)
    return driver

def protect(text, mapping, next_id):
    def repl(match):
        token = "__PL_P{:04d}__".format(next_id[0])
        next_id[0] += 1
        mapping[token] = match.group(0)
        return token
    return PROTECT_RE.sub(repl, text)

def make_stream(nodes):
    mapping, next_id, pieces = {}, [1], []
    for index, node in enumerate(nodes, 1):
        body = protect(node["text"], mapping, next_id)
        sid = "{:04d}".format(index)
        pieces.append("__PL_S{}__{}__PL_E{}__".format(sid, body, sid))
    return "".join(pieces), mapping

def parse_stream(output, count):
    matches = SLOT_RE.findall(output)
    if len(matches) != count:
        return None
    ids = [slot_id for slot_id, _ in matches]
    if ids != ["{:04d}".format(i) for i in range(1, count + 1)]:
        return None
    return [body for _, body in matches]

def restore(value, mapping):
    for token, original in mapping.items():
        value = value.replace(token, original)
    return value

def english_residue(text):
    protected = {
        "openclaw","github","node","npm","npx","api","cli","http","https","json","yaml",
        "docker","nix","windows","linux","android","discord","slack","teams","telegram",
        "whatsapp","deepwiki","webchat","codex","claude","powershell","macos"
    }
    return len([
        word for word in re.findall(r"\b[A-Za-z]{3,}\b", text)
        if word.lower() not in protected
    ])

def duplicate_suspect(values):
    normalized = [re.sub(r"\s+","",x) for x in values if len(re.sub(r"\s+","",x)) >= 12]
    return len(normalized) != len(set(normalized))

def smoke_model(model):
    samples = [
        "Install the Gateway service.",
        "This opens the Control UI in your browser. If it loads, everything is working.",
        "The installer supports macOS, Linux, and Windows.",
    ]
    rows = []
    for source in samples:
        prompt = (
            "Translate the following text from English into Chinese:\n"
            "English: " + source + "\n"
            "Chinese:"
        )
        translated, elapsed = chat(model, prompt, 512)
        row = {
            "source": source,
            "translated": translated,
            "cjk": bool(re.search(r"[\u3400-\u9fff]", translated)),
            "ms": round(elapsed, 1),
        }
        rows.append(row)
        print("LMT_SMOKE_RESULT=" + json.dumps(row, ensure_ascii=False, separators=(",",":")), flush=True)
    return rows

stats = {"calls":0,"retry":0,"format_fail":0}

def translate_block(context, nodes, model):
    marked, mapping = make_stream(nodes)
    expected = TOKEN_RE.findall(marked)
    request = (
        "Translate the following text from English into Chinese.\n"
        "Keep every token beginning with __PL_ exactly unchanged and in the same order.\n"
        "Return only the translated marked text.\n"
        "English:\n" + marked + "\n"
        "Chinese:"
    )
    stats["calls"] += 1
    output, elapsed = chat(model, request)
    if TOKEN_RE.findall(output) != expected:
        stats["retry"] += 1
        stats["calls"] += 1
        retry_request = (
            "Translate the following text from English into Chinese.\n"
            "CRITICAL: copy every __PL_ token exactly once and in exactly the same order.\n"
            "Do not add explanations.\n"
            "English:\n" + marked + "\n"
            "Chinese:"
        )
        output2, elapsed2 = chat(model, retry_request)
        output, elapsed = output2, elapsed + elapsed2

    if TOKEN_RE.findall(output) != expected:
        stats["format_fail"] += 1
        return [node["text"] for node in nodes], elapsed, False, False

    parsed = parse_stream(output, len(nodes))
    if parsed is None:
        stats["format_fail"] += 1
        return [node["text"] for node in nodes], elapsed, False, False

    protected_ok = all(output.count(token) == 1 for token in mapping)
    restored = [restore(value, mapping) for value in parsed]
    return restored, elapsed, True, protected_ok

def run_site(site, url, model):
    driver = browser()
    try:
        driver.get(url)
        WebDriverWait(driver, 40).until(lambda d: d.execute_script("return document.readyState") == "complete")
        time.sleep(5)
        items = driver.execute_script(COLLECT)
        if len(items) < 6:
            raise RuntimeError("too few blocks {}: {}".format(site, len(items)))

        rows, total_ms = [], 0.0
        for item in items:
            outputs, elapsed, marker_ok, protected_ok = translate_block(item["text"], item["nodes"], model)
            applied = driver.execute_script(APPLY, item["id"], outputs)
            structure_ok = (
                marker_ok
                and bool(applied.get("count_ok"))
                and applied.get("fingerprint") == item["fingerprint"]
            )
            translated = applied.get("text") or ""
            total_ms += elapsed
            row = {
                "source": item["text"],
                "translated": translated,
                "slots": len(item["nodes"]),
                "marker_ok": marker_ok,
                "protected_ok": protected_ok,
                "structure_ok": bool(structure_ok),
                "duplicate_suspect": duplicate_suspect(outputs),
                "ms": round(elapsed,1),
                "english_residue": english_residue(translated),
            }
            rows.append(row)
            print("LMT_RESULT=" + json.dumps(row,ensure_ascii=False,separators=(",",":")), flush=True)

        driver.save_screenshot(str(OUT / "{}-lmt-hybrid.png".format(site)))
        try:
            driver.get_full_page_screenshot_as_file(str(OUT / "full-{}-lmt-hybrid.png".format(site)))
        except Exception as exc:
            print("FULL_SCREENSHOT_WARN", site, repr(exc), flush=True)

        summary = {
            "site":site,
            "blocks":len(rows),
            "marker_pass":sum(x["marker_ok"] for x in rows),
            "protected_pass":sum(x["protected_ok"] for x in rows),
            "structure_pass":sum(x["structure_ok"] for x in rows),
            "duplicate_suspect":sum(x["duplicate_suspect"] for x in rows),
            "avg_ms":round(total_ms/len(rows),1),
            "english_residue":sum(x["english_residue"] for x in rows),
            "rows":rows,
        }
        print("LMT_SITE_SUMMARY=" + json.dumps(summary,ensure_ascii=False,separators=(",",":")), flush=True)
        return summary
    finally:
        driver.quit()

def self_test():
    nodes = [{"text":"Install OpenClaw with npm."},{"text":"Quick start keeps the Gateway running."}]
    marked, mapping = make_stream(nodes)
    assert len(TOKEN_RE.findall(marked)) == 6
    fake = marked.replace("Install ","安装 ").replace(" with ","，使用 ").replace(
        "Quick start keeps the Gateway running.","快速启动会保持网关运行。"
    )
    parsed = parse_stream(fake, 2)
    assert parsed is not None
    restored = [restore(x,mapping) for x in parsed]
    assert "OpenClaw" in restored[0] and "npm" in restored[0]
    print("LMT_HYBRID_SELF_TEST=PASS")

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    self_test()
    unload()
    model_info = download_model()
    print("LMT_MODEL=" + json.dumps({
        "key":model_info.get("key"),
        "display_name":model_info.get("display_name"),
        "quantization":QUANT,
    },ensure_ascii=False), flush=True)
    model = load_model(model_info)
    try:
        smoke = smoke_model(model)
        results = [run_site(site,url,model) for site,url in SITES]
    finally:
        unload()

    compact = [{
        key: result[key]
        for key in ("site","blocks","marker_pass","protected_pass","structure_pass","duplicate_suspect","avg_ms","english_residue")
    } for result in results]
    final = {"model":"LMT-60-0.6B","quantization":QUANT,"smoke":smoke,"summary":compact,"stats":stats,"results":results}
    print("LMT_FINAL=" + json.dumps({"summary":compact,"stats":stats},ensure_ascii=False), flush=True)
    (OUT/"lmt-hybrid-results.json").write_text(json.dumps(final,ensure_ascii=False,indent=2),encoding="utf-8")

if __name__ == "__main__":
    main()
