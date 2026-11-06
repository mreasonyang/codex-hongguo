$ErrorActionPreference = 'Stop'
& (Join-Path $env:PLUGIN_ROOT 'bin\run-node.exe') hook
exit $LASTEXITCODE
