$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $projectRoot
try {
  & npm.cmd run dev
  if ($LASTEXITCODE -ne 0) { throw "O Noizzzy encerrou com código $LASTEXITCODE." }
}
finally {
  Pop-Location
}
