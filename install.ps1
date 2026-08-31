$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerRoot = Join-Path $projectRoot "worker"
$workerPython = Join-Path $workerRoot ".venv\Scripts\python.exe"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 24+ não encontrado no PATH." }
if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw "Python 3.12 não encontrado. Instale-o antes de continuar." }

Write-Host "[1/4] Instalando dependências do Electron..."
& npm.cmd ci --prefix $projectRoot
Write-Host "[2/4] Instalando dependências da interface..."
& npm.cmd ci --prefix (Join-Path $projectRoot "web")
Write-Host "[3/4] Preparando o worker..."
if (-not (Test-Path -LiteralPath $workerPython)) { & py -3.12 -m venv (Join-Path $workerRoot ".venv") }
& $workerPython -m pip install --upgrade pip
& $workerPython -m pip install -e "$workerRoot[dev]" "pyinstaller>=6.16,<7"
Write-Host "[4/4] Executando os testes..."
& npm.cmd test --prefix $projectRoot
& $workerPython -m pytest (Join-Path $workerRoot "tests")
Write-Host "Pronto. Execute .\run.ps1 para abrir o Noizzzy." -ForegroundColor Green
