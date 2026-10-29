"""Explicit, v4-only marker weighting. Prompt/padding never enter the loss."""
import math

from validation_metrics import target_kinds


def token_weights(text, offsets, marker_weight):
    if isinstance(marker_weight, bool) or not isinstance(marker_weight, (int, float)) or not math.isfinite(marker_weight) or not 0 < marker_weight <= 1:
        raise ValueError("Marker weight must be finite and in (0, 1]")
    kinds = target_kinds(text, offsets)
    return [marker_weight if kind == "marker" else 1.0 for kind in kinds], kinds


def weighted_causal_loss(logits, labels, weights):
    import torch
    import torch.nn.functional as functional
    if logits.ndim != 3 or labels.shape != logits.shape[:2] or weights.shape != labels.shape:
        raise ValueError("Expected aligned [batch, sequence] labels and weights")
    shifted_labels = labels[:, 1:]
    shifted_weights = weights[:, 1:].float()
    if not torch.isfinite(shifted_weights).all() or (shifted_weights < 0).any():
        raise ValueError("Invalid supervised weights")
    if (shifted_weights[shifted_labels == -100] != 0).any() or (shifted_weights[shifted_labels != -100] <= 0).any():
        raise ValueError("Prompt/padding must have zero weight; supervised targets must be positive")
    denominator = shifted_weights.sum()
    if denominator <= 0:
        raise ValueError("No supervised target mass")
    losses = functional.cross_entropy(logits[:, :-1].float().reshape(-1, logits.shape[-1]), shifted_labels.reshape(-1), ignore_index=-100, reduction="none")
    return (losses.reshape_as(shifted_weights) * shifted_weights).sum() / denominator


def semantic_trainer_class(trainer):
    class SemanticTrainer(trainer):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            # Loss is a per-microbatch weighted mean. Trainer must apply its
            # normal accumulation scaling, rather than token-count kwargs.
            self.model_accepts_loss_kwargs = False

        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            values = dict(inputs)
            weights = values.pop("loss_weights")
            labels = values.pop("labels")
            outputs = model(**values)
            loss = weighted_causal_loss(outputs.logits, labels, weights)
            return (loss, outputs) if return_outputs else loss

    return SemanticTrainer
