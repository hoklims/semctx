# Thin PowerShell wrapper: runs the semantic-layer stress test through Git Bash.
# The real, execution-proven test logic lives in semantic-stress-test.sh; the semctx CLI runs
# under Bun. Set KEEP=1 to keep the throwaway repo:  $env:KEEP = '1'; .\semantic-stress-test.ps1
$sh = Join-Path $PSScriptRoot 'semantic-stress-test.sh'
$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) { Write-Host 'bash not found on PATH. Install Git for Windows (it provides bash).'; exit 1 }
& $bash.Source $sh @args
exit $LASTEXITCODE
