"""Separate supervised text, frame-marker and EOS losses without changing training."""
import math
import re

MARKER = re.compile(r"⟦/?\d+⟧|⟪P\d+⟫")


def target_kinds(text, offsets):
    mask = [False] * len(text)
    for marker in MARKER.finditer(text):
        mask[marker.start():marker.end()] = [True] * (marker.end() - marker.start())
    kinds = []
    for start, end in offsets:
        if not 0 <= start < end <= len(text):
            raise ValueError("Invalid target token offset")
        # A token containing any prose remains content, even if BPE spans a boundary.
        kinds.append("marker" if all(mask[start:end]) else "content")
    return kinds + ["eos"]


def loss_summary(losses, kinds):
    if len(losses) != len(kinds) or not losses or any(not math.isfinite(v) or v < 0 for v in losses):
        raise ValueError("Invalid supervised losses")
    if kinds[-1] != "eos" or kinds.count("eos") != 1 or any(k not in ["content", "marker", "eos"] for k in kinds):
        raise ValueError("One supervised EOS and explicit loss categories are required")
    if "content" not in kinds:
        raise ValueError("No content tokens in validation target")
    return {key: {"tokens": kinds.count(key), "sum_nll": sum(v for v, kind in zip(losses, kinds) if kind == key)}
            for key in ["content", "marker", "eos"]}


def aggregate(rows):
    if not rows:
        raise ValueError("Missing validation measurements")
    result = {}
    for key in ["content", "marker", "eos"]:
        tokens = sum(row[key]["tokens"] for row in rows)
        loss = sum(row[key]["sum_nll"] for row in rows)
        result[key] = {"tokens": tokens, "mean_nll": loss / tokens if tokens else None}
    total = sum(result[k]["tokens"] for k in result)
    result["all_target_tokens"] = total
    result["token_weighted_nll"] = sum(row[k]["sum_nll"] for row in rows for k in ["content", "marker", "eos"]) / total
    result["mean_sample_nll"] = sum(sum(row[k]["sum_nll"] for k in ["content", "marker", "eos"]) /
        sum(row[k]["tokens"] for k in ["content", "marker", "eos"]) for row in rows) / len(rows)
    return result


def target_losses(logits, prompt_tokens, target_ids):
    import torch
    import torch.nn.functional as F
    if logits.ndim != 3 or logits.shape[0] != 1 or prompt_tokens < 1 or not target_ids:
        raise ValueError("Expected one unpadded supervised sequence")
    if logits.shape[1] < prompt_tokens + len(target_ids):
        raise ValueError("Supervised sequence was truncated")
    # Target token zero is predicted by the last prompt position, not its own position.
    predictions = logits[0, prompt_tokens-1:prompt_tokens+len(target_ids)-1].float()
    return F.cross_entropy(predictions, torch.tensor(target_ids,device=logits.device),reduction="none")
