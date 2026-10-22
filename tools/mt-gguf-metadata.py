"""Verify Hy-MT GGUF stop tokens; optionally repair a separate derived output copy.

llama.cpp b11785 exports this base with EOS=3 ('$') although its source config
requires EOS=120020. This tool never edits its input or changes tensor bytes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct

FORMATS = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}


def metadata(path):
    values, offsets = {}, {}
    with Path(path).open("rb") as stream:
        def read(fmt):
            size = struct.calcsize("<" + fmt)
            raw = stream.read(size)
            if len(raw) != size:
                raise ValueError("Truncated GGUF metadata")
            return struct.unpack("<" + fmt, raw)[0]

        def string():
            return stream.read(read("Q")).decode("utf-8")

        def value(kind):
            if kind == 8:
                return string()
            if kind == 9:
                subtype, size = read("I"), read("Q")
                return [value(subtype) for _ in range(size)]
            if kind not in FORMATS:
                raise ValueError("Unsupported GGUF metadata type")
            return read(FORMATS[kind])

        if stream.read(4) != b"GGUF" or read("I") != 3:
            raise ValueError("Expected GGUF version 3")
        tensor_count, count = read("Q"), read("Q")
        for _ in range(count):
            key, kind = string(), read("I")
            offsets[key] = (stream.tell(), kind)
            values[key] = value(kind)
    return values, offsets, tensor_count


def verify(model, source_config):
    model, source_config = Path(model), Path(source_config)
    config = json.loads((source_config / "config.json").read_text())
    tokenizer = json.loads((source_config / "tokenizer_config.json").read_text())
    values, offsets, count = metadata(model)
    checks = {}
    tokens = values.get("tokenizer.ggml.tokens", [])
    for name, key in [("bos", "bos"), ("eos", "eos"), ("pad", "padding")]:
        expected = config[name + "_token_id"]
        actual = values.get(f"tokenizer.ggml.{key}_token_id")
        if not isinstance(expected, int):
            raise ValueError("This verifier requires a single explicit stop-token ID")
        text = tokens[actual] if isinstance(actual, int) and 0 <= actual < len(tokens) else None
        expected_text = tokenizer.get(name + "_token")
        if isinstance(expected_text, dict):
            expected_text = expected_text.get("content")
        checks[name] = {"expected_id": expected, "actual_id": actual, "actual_text": text,
                        "passed": actual == expected and (expected_text is None or text == expected_text)}
    template_path = source_config / "chat_template.jinja"
    expected_template = template_path.read_text() if template_path.exists() else tokenizer.get("chat_template")
    checks["chat_template"] = {"passed": expected_template == values.get("tokenizer.chat_template")}
    return {"model": str(model), "tensor_count": count, "checks": checks,
            "passed": all(check["passed"] for check in checks.values())}, offsets


def repair_eos(model, source_config, output):
    model, output = Path(model).resolve(), Path(output).resolve()
    if model == output or output.exists():
        raise ValueError("Repair requires a new output path, distinct from the untouched input")
    before, offsets = verify(model, source_config)
    for key, check in before["checks"].items():
        if key != "eos" and not check["passed"]:
            raise ValueError("Refusing automatic repair of non-EOS metadata: " + key)
    position, kind = offsets["tokenizer.ggml.eos_token_id"]
    if kind not in [4, 5, 10, 11]:
        raise ValueError("Unsupported EOS metadata integer type")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(model, output)
    with output.open("r+b") as stream:
        stream.seek(position)
        stream.write(struct.pack("<" + FORMATS[kind], before["checks"]["eos"]["expected_id"]))
    after, _ = verify(output, source_config)
    if not after["passed"]:
        raise ValueError("Repaired output failed verification")
    with output.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"input_unchanged": True, "before": before, "after": after, "changed_metadata": ["tokenizer.ggml.eos_token_id"],
            "output_sha256": digest}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--source-config", type=Path, required=True)
    parser.add_argument("--repair-eos", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.repair_eos:
        if not args.output:
            parser.error("--repair-eos requires --output; input files are never modified")
        result = repair_eos(args.model, args.source_config, args.output)
    else:
        result, _ = verify(args.model, args.source_config)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.repair_eos and not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
