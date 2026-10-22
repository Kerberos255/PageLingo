"""Construct the real Trainer arguments before loading any model weights."""


def build_training_arguments(config, output, *, probe=False, use_cpu=False):
    from transformers import TrainingArguments

    # Both 5.6 and 5.17 accept a fraction here. 5.17 removed warmup_ratio.
    return TrainingArguments(
        output_dir=str(output), num_train_epochs=config["epochs"],
        max_steps=config["probe_max_steps"] if probe else -1,
        per_device_train_batch_size=config["batch_size"], per_device_eval_batch_size=1,
        gradient_accumulation_steps=config["gradient_accumulation_steps"],
        learning_rate=config["learning_rate"], weight_decay=config["weight_decay"],
        warmup_steps=config["warmup_ratio"], lr_scheduler_type="cosine",
        bf16=not use_cpu, use_cpu=use_cpu, gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False}, optim="adamw_torch", max_grad_norm=1.0,
        eval_strategy="epoch", save_strategy="epoch", save_total_limit=2, logging_steps=1, report_to=[],
        seed=config["seed"], data_seed=config["seed"], dataloader_num_workers=0, push_to_hub=False)
