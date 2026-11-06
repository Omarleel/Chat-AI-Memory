param(
  [string]$AdapterDir = 'data/lora_adapter',
  [string]$MergedDir = 'data/merged_model',
  [string]$GgufPath = 'data/model-q8.gguf',
  [ValidatePattern('^[a-zA-Z0-9_.:-]+$')][string]$ModelName = 'mi-modelo',
  # q4_K_M cabe junto a un modelo de razonamiento en 16 GB de VRAM; requiere Docker para llama-quantize.
  [ValidateSet('q8_0','q4_K_M')][string]$Quant = 'q8_0',
  # Prompt de sistema con que se entrenó; queda como SYSTEM en el Modelfile.
  [string]$SystemPrompt = ''
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $projectDir '.venv-lora/Scripts/python.exe'
Push-Location $projectDir
try {
  $report = Get-Content -Raw -LiteralPath (Join-Path $AdapterDir 'training-report.json') | ConvertFrom-Json
  if ($report.audit.supervised_tokens -le 0 -or $report.audit.train_validation_session_overlap -ne 0) {
    throw 'El entrenamiento no tiene una auditoría válida de etiquetas y particiones'
  }
  if ($report.final.eval_loss -ge $report.baseline.eval_loss) {
    throw 'El modelo entrenado no mejoró la pérdida de validación respecto al modelo base'
  }
  & $pythonExe scripts/merge_lora.py --adapter $AdapterDir --output $MergedDir --model $report.base_model
  if ($LASTEXITCODE -ne 0) { throw 'Error al fusionar LoRA' }
  if (Test-Path -LiteralPath $GgufPath) {
    Remove-Item -Force -LiteralPath $GgufPath
  }
  if ($Quant -eq 'q8_0') {
    & $pythonExe scripts/llama_cpp/convert_hf_to_gguf.py $MergedDir --outfile $GgufPath --outtype q8_0
    if ($LASTEXITCODE -ne 0) { throw 'Error al convertir a GGUF' }
  } else {
    # Ollama no cuantiza GGUF a K-quants; se cuantiza desde F16 con la imagen oficial de llama.cpp.
    $f16 = [IO.Path]::ChangeExtension($GgufPath, '.f16.gguf')
    & $pythonExe scripts/llama_cpp/convert_hf_to_gguf.py $MergedDir --outfile $f16 --outtype f16
    if ($LASTEXITCODE -ne 0) { throw 'Error al convertir a GGUF F16' }
    $dir = (Resolve-Path (Split-Path -Parent $GgufPath)).Path
    docker run --rm -v "${dir}:/models" ghcr.io/ggml-org/llama.cpp:full --quantize "/models/$(Split-Path -Leaf $f16)" "/models/$(Split-Path -Leaf $GgufPath)" Q4_K_M
    $code = $LASTEXITCODE
    Remove-Item -Force -LiteralPath $f16
    if ($code -ne 0) { throw 'Error al cuantizar a Q4_K_M' }
  }
  $containerId = (docker compose ps -q ollama).Trim()
  if (-not $containerId) { throw 'Ollama no está iniciado en este proyecto' }
  docker cp $GgufPath "${containerId}:/tmp/coherence-model.gguf"
  if ($LASTEXITCODE -ne 0) { throw 'Error al copiar GGUF' }
  New-Item -ItemType Directory -Force -Path work | Out-Null
  $modelLines = @('FROM /tmp/coherence-model.gguf','PARAMETER temperature 0.35','PARAMETER top_p 0.85','PARAMETER stop "<|im_end|>"','PARAMETER stop "<|endoftext|>"')
  # El prompt de entrenamiento como SYSTEM marca el modelo como entrenado: REPLY_WRITER_PROMPT=auto lo usa al redactar.
  if ($SystemPrompt) { $modelLines += 'SYSTEM """' + $SystemPrompt + '"""' }
  $modelLines | Set-Content -Encoding utf8 work/Modelfile
  docker cp work/Modelfile "${containerId}:/tmp/Modelfile"
  if ($LASTEXITCODE -ne 0) { throw 'Error al copiar Modelfile' }
  docker exec $containerId ollama create $ModelName -f /tmp/Modelfile
  if ($LASTEXITCODE -ne 0) { throw 'Error al registrar el modelo' }
  Write-Host "Modelo disponible en Ollama: $ModelName."
} finally { Pop-Location }
