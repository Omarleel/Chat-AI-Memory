"""
Fusiona los pesos del adaptador LoRA con el modelo base Qwen2.5-3B-Instruct.
Exporta el modelo consolidado completo en formato Safetensors de Hugging Face.
"""

import sys
import os
import argparse
from pathlib import Path
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

def merge_lora(
    base_model_name="Qwen/Qwen2.5-3B-Instruct",
    adapter_dir="data/lora_adapter",
    output_dir="data/merged_model"
):
    print("==================================================")
    print("FUSIONANDO MODELO BASE + ADAPTADOR LORA")
    print(f"Modelo base: {base_model_name}")
    print(f"Adaptador:   {adapter_dir}")
    print(f"Destino:     {output_dir}")
    print("==================================================")

    if Path(output_dir).exists() and any(Path(output_dir).iterdir()):
        import shutil
        shutil.rmtree(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    print("1. Cargando tokenizer...")
    # Preservar exactamente los tokens y la plantilla usados al entrenar.
    tokenizer = AutoTokenizer.from_pretrained(adapter_dir)

    print("2. Cargando modelo base (FP16)...")
    base_model = AutoModelForCausalLM.from_pretrained(
        base_model_name,
        torch_dtype=torch.float16,
        device_map="cpu",
        low_cpu_mem_usage=True,
        trust_remote_code=False
    )

    print("3. Cargando adaptador LoRA...")
    lora_model = PeftModel.from_pretrained(base_model, adapter_dir)

    print("4. Ejecutando fusión matemática de pesos (merge_and_unload)...")
    merged_model = lora_model.merge_and_unload()

    print(f"5. Guardando modelo fusionado en {output_dir}...")
    merged_model.save_pretrained(output_dir, safe_serialization=True)
    tokenizer.save_pretrained(output_dir)

    print("\n==================================================")
    print("FUSIÓN COMPLETADA EXITOSAMENTE")
    print(f"Ruta: {output_dir}")
    print("==================================================")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='Qwen/Qwen2.5-3B-Instruct')
    parser.add_argument('--adapter', default='data/lora_adapter')
    parser.add_argument('--output', default='data/merged_model')
    args = parser.parse_args()
    merge_lora(args.model, args.adapter, args.output)

