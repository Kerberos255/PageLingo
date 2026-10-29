"""Construct the real Trainer arguments before loading any model weights."""


def build_training_arguments(config, output, *, probe=False, use_cpu=False, synthetic_candidate=False):
    from transformers import TrainingArguments

    selection = config.get("checkpoint_selection", "lowest_validation_loss")
    if selection not in ["lowest_validation_loss", "final"]:
        raise ValueError("Unknown checkpoint selection mode")
    choose_best = synthetic_candidate and selection == "lowest_validation_loss"
    # Both 5.6 and 5.17 accept a fraction here. 5.17 removed warmup_ratio.
    return TrainingArguments(
        output_dir=str(output), num_train_epochs=config["epochs"],
        max_steps=config["candidate_max_steps"] if synthetic_candidate else config["probe_max_steps"] if probe else -1,
        per_device_train_batch_size=config["batch_size"], per_device_eval_batch_size=1,
        gradient_accumulation_steps=config["gradient_accumulation_steps"],
        learning_rate=config["learning_rate"], weight_decay=config["weight_decay"],
        warmup_steps=config["warmup_ratio"], lr_scheduler_type="cosine",
        bf16=not use_cpu, use_cpu=use_cpu, gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False}, optim="adamw_torch", max_grad_norm=1.0,
        eval_strategy="epoch", save_strategy="epoch", save_total_limit=2, logging_steps=1, report_to=[],
        load_best_model_at_end=choose_best, metric_for_best_model="eval_loss" if choose_best else None,
        greater_is_better=False if choose_best else None,
        seed=config["seed"], data_seed=config["seed"], dataloader_num_workers=0, push_to_hub=False,
        remove_unused_columns=config.get("semantic_marker_weight") is None)
