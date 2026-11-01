"""SFT with an optional reference-relative DPO term, on target tokens only."""


def causal_logps(logits, labels):
    import torch
    import torch.nn.functional as functional
    if logits.ndim != 3 or labels.shape != logits.shape[:2]:
        raise ValueError("Expected aligned causal logits and labels")
    target = labels[:, 1:]; mask = target != -100
    counts = mask.sum(dim=-1)
    if (counts == 0).any(): raise ValueError("No supervised target tokens")
    losses = functional.cross_entropy(logits[:, :-1].float().reshape(-1, logits.shape[-1]),
        target.reshape(-1), ignore_index=-100, reduction="none").reshape_as(target)
    return -(losses * mask).sum(dim=-1), counts


def preference_objective(policy_logps, counts, reference_logps, paired, *, beta, weight):
    import torch
    import torch.nn.functional as functional
    if not 0 < beta <= 1 or not 0 <= weight <= 1: raise ValueError("Invalid bounded preference settings")
    if policy_logps.ndim != 2 or policy_logps.shape[1] != 2 or counts.shape != policy_logps.shape or reference_logps.shape != policy_logps.shape or paired.shape != policy_logps.shape[:1]:
        raise ValueError("Expected chosen/rejected paired sequence sums")
    if not torch.isfinite(policy_logps).all() or not torch.isfinite(reference_logps).all() or (counts <= 0).any():
        raise ValueError("Invalid target log probabilities")
    sft = -policy_logps[:, 0] / counts[:, 0]
    margin = (policy_logps[:, 0] - policy_logps[:, 1]) - (reference_logps[:, 0] - reference_logps[:, 1])
    preference = functional.softplus(-beta * margin)
    # Replay examples have no negative target and contribute only chosen CE.
    loss = (sft + weight * paired.float() * preference).mean()
    return loss, {"chosen_ce": sft, "preference": preference, "reference_relative_margin": margin}


def preference_trainer_class(trainer):
    class PreferenceTrainer(trainer):
        def __init__(self, *args, beta, preference_weight, **kwargs):
            super().__init__(*args, **kwargs)
            self.beta, self.preference_weight = beta, preference_weight
            self.model_accepts_loss_kwargs = False

        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            values = dict(inputs); labels = values.pop("labels")
            reference = values.pop("reference_logps"); paired = values.pop("paired")
            outputs = model(**values)
            logps, counts = causal_logps(outputs.logits, labels)
            # Collator emits [chosen0, rejected0, chosen1, rejected1, ...].
            loss, _ = preference_objective(logps.reshape(-1, 2), counts.reshape(-1, 2), reference, paired,
                beta=self.beta, weight=self.preference_weight)
            return (loss, outputs) if return_outputs else loss
    return PreferenceTrainer
