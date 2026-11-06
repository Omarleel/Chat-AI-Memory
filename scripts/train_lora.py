"""QLoRA con etiquetas explícitas: solo se aprende la respuesta final del titular.
La validación comprueba las máscaras antes de cargar los pesos en GPU.
"""
import argparse
import json
from pathlib import Path
import random


def encode_example(row, tokenizer, max_length=1024):
    prompt = list(row['prompt'])
    completion = row['completion']
    if len(completion) != 1 or completion[0]['role'] != 'assistant':
        raise ValueError('Se requiere una única respuesta final de assistant')
    if not prompt or prompt[-1]['role'] != 'user':
        raise ValueError('El contexto debe terminar en user')
    # Recortar turnos antiguos enteros, nunca el objetivo ni su EOS.
    while True:
        prefix = tokenizer.apply_chat_template(prompt, tokenize=False, add_generation_prompt=True)
        full = tokenizer.apply_chat_template(prompt + completion, tokenize=False, add_generation_prompt=False)
        if not full.startswith(prefix):
            raise ValueError('La plantilla no preserva el prefijo de generación')
        prefix_ids = tokenizer.encode(prefix, add_special_tokens=False)
        ids = tokenizer.encode(full, add_special_tokens=False)
        if ids[:len(prefix_ids)] != prefix_ids:
            raise ValueError('El límite prompt/respuesta no coincide con los tokens')
        if len(ids) <= max_length:
            labels = [-100] * len(prefix_ids) + ids[len(prefix_ids):]
            if not any(x != -100 for x in labels):
                raise ValueError('Máscara vacía: ninguna respuesta se entrenaría')
            return {'input_ids': ids, 'attention_mask': [1] * len(ids), 'labels': labels}
        if len(prompt) <= 2:
            return None
        prompt.pop(1 if prompt[0]['role'] == 'system' else 0)


def load_rows(path, tokenizer, max_length):
    rows = [json.loads(line) for line in Path(path).read_text(encoding='utf-8-sig').splitlines() if line.strip()]
    encoded = [encode_example(row, tokenizer, max_length) for row in rows]
    return rows, [row for row in encoded if row is not None]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='Qwen/Qwen2.5-7B-Instruct')
    parser.add_argument('--dataset', default='data/dataset')
    parser.add_argument('--output', default='data/lora_adapter')
    parser.add_argument('--steps', type=int, default=400)
    parser.add_argument('--batch-size', '--batch_size', type=int, default=2)
    parser.add_argument('--gradient-accumulation', type=int, default=4)
    parser.add_argument('--max-length', type=int, default=1024)
    parser.add_argument('--learning-rate', type=float, default=5e-5)
    parser.add_argument('--overwrite', action='store_true', help='Sobrescribir directorio de salida')
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Reanudar desde el último checkpoint del destino, si existe')
    args = parser.parse_args()
    import torch
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = 'right'
    train_source, train = load_rows(Path(args.dataset) / 'train.jsonl', tokenizer, args.max_length)
    val_source, val = load_rows(Path(args.dataset) / 'validation.jsonl', tokenizer, args.max_length)
    train_sessions = {r['provenance']['session'] for r in train_source}
    val_sessions = {r['provenance']['session'] for r in val_source}
    if train_sessions & val_sessions:
        raise ValueError('Fuga de contexto entre entrenamiento y validación')
    if not train or not val:
        raise ValueError('Dataset vacío tras tokenización')
    audit = {'train': len(train), 'validation': len(val),
             'skipped_oversized_train': len(train_source)-len(train),
             'skipped_oversized_validation': len(val_source)-len(val),
             'supervised_tokens': sum(sum(x != -100 for x in r['labels']) for r in train),
             'masked_tokens': sum(sum(x == -100 for x in r['labels']) for r in train),
             'max_length': args.max_length, 'train_validation_session_overlap': 0}
    print(json.dumps(audit), flush=True)
    Path('work').mkdir(exist_ok=True)
    Path('work/training-mask-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
    if args.validate_only:
        return
    output = Path(args.output)
    # Un trabajo interrumpido conserva sus checkpoints (cada 100 pasos): se reanuda en vez de empezar de cero.
    checkpoints = sorted(output.glob('checkpoint-*'), key=lambda p: int(p.name.split('-')[-1])) if args.resume and output.exists() else []
    resume_from = str(checkpoints[-1]) if checkpoints else None
    if resume_from:
        print('RESUME', json.dumps({'checkpoint': Path(resume_from).name}), flush=True)
    elif output.exists() and any(output.iterdir()):
        if args.overwrite:
            import shutil
            shutil.rmtree(output)
            output.mkdir(parents=True, exist_ok=True)
        else:
            raise ValueError('El destino ya tiene archivos; usa un directorio nuevo o --overwrite')
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig, Trainer, TrainingArguments, DataCollatorForSeq2Seq
    from peft import LoraConfig, prepare_model_for_kbit_training, get_peft_model
    from datasets import Dataset
    if not torch.cuda.is_available():
        raise RuntimeError('Se requiere GPU CUDA para este entrenamiento QLoRA')
    model = AutoModelForCausalLM.from_pretrained(args.model,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
        device_map={'': 0}, dtype=torch.bfloat16)
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32,
        target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'],
        lora_dropout=0.05, bias='none', task_type='CAUSAL_LM'))
    model.config.use_cache = False
    # Muestra de entrenamiento y validación homogénea y reproducible
    random.Random(42).shuffle(train)
    random.Random(42).shuffle(val)
    val = val[:128]
    settings = TrainingArguments(output_dir=args.output, max_steps=args.steps,
        per_device_train_batch_size=args.batch_size, gradient_accumulation_steps=args.gradient_accumulation,
        per_device_eval_batch_size=2, learning_rate=args.learning_rate,
        warmup_ratio=0.05, lr_scheduler_type='cosine', logging_steps=10,
        eval_strategy='steps', eval_steps=100, save_strategy='steps', save_steps=100,
        save_total_limit=2, load_best_model_at_end=True, metric_for_best_model='eval_loss',
        greater_is_better=False, bf16=True, gradient_checkpointing=True, report_to='none',
        seed=42, dataloader_num_workers=0, optim='adamw_torch', remove_unused_columns=False)
    trainer = Trainer(model=model, args=settings, train_dataset=Dataset.from_list(train),
        eval_dataset=Dataset.from_list(val), processing_class=tokenizer,
        data_collator=DataCollatorForSeq2Seq(tokenizer, padding=True, label_pad_token_id=-100))
    baseline = trainer.evaluate()
    print('BASELINE', json.dumps(baseline), flush=True)
    trainer.train(resume_from_checkpoint=resume_from)
    final = trainer.evaluate()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)
    report = {'base_model': args.model, 'dataset_manifest': json.loads((Path(args.dataset)/'manifest.json').read_text()),
              'audit': audit, 'baseline': baseline, 'final': final,
              'best_checkpoint': trainer.state.best_model_checkpoint,
              'note': 'La pérdida de validación no sustituye la revisión de respuestas generadas.'}
    (output/'training-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('FINAL', json.dumps(final), flush=True)


if __name__ == '__main__':
    main()
