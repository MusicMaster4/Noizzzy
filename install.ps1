param([switch]$Cpu)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerRoot = Join-Path $projectRoot "worker"
$webRoot = Join-Path $projectRoot "web"
$workerPython = Join-Path $workerRoot ".venv\Scripts\python.exe"
$enhancerPython = Join-Path $workerRoot ".clearvoice-venv\Scripts\python.exe"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js não encontrado no PATH." }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "FFmpeg não encontrado no PATH." }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw "FFprobe não encontrado no PATH." }

Write-Host "[1/4] Instalando a interface..."
& npm.cmd install --prefix $webRoot
Write-Host "[2/4] Criando o ambiente do worker/separador..."
if (-not (Test-Path -LiteralPath $workerPython)) { & py -3.12 -m venv (Join-Path $workerRoot ".venv") }
& $workerPython -m pip install --upgrade pip
$separatorExtra = if ($Cpu) { "separation" } else { "separation-gpu" }
& $workerPython -m pip install -e "$workerRoot[$separatorExtra,dev]"
if (-not $Cpu) {
  & $workerPython -m pip install --force-reinstall torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 --index-url "https://download.pytorch.org/whl/cu128"
}
Write-Host "[3/4] Criando o ambiente isolado do restaurador..."
if (-not (Test-Path -LiteralPath $enhancerPython)) { & py -3.12 -m venv (Join-Path $workerRoot ".clearvoice-venv") }
& $enhancerPython -m pip install --upgrade pip
& $enhancerPython -m pip install clearvoice==0.1.2
if (-not $Cpu) {
  & $enhancerPython -m pip install --force-reinstall torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 --index-url "https://download.pytorch.org/whl/cu128"
  # torchvision's broad NumPy requirement may upgrade to 2.x; ClearVoice 0.1.2 requires 1.x.
  & $enhancerPython -m pip install --force-reinstall numpy==1.26.4
}
Write-Host "[4/4] Verificando a instalação..."
& $workerPython -m pytest (Join-Path $workerRoot "tests")
Write-Host "Pronto. Execute .\run.ps1 e acesse http://localhost:27295" -ForegroundColor Green
