# Keep the website independent of release timing; the release asset owns installer behavior.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$file = Join-Path ([IO.Path]::GetTempPath()) ("clio-coder-install-" + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
	Invoke-WebRequest -UseBasicParsing 'https://github.com/iowarp/clio-coder/releases/latest/download/install.ps1' -OutFile $file
	# Native -File parsing preserves named flags; array splatting a script block binds them positionally.
	& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file @args
	if ($LASTEXITCODE -ne 0) { throw "Clio Coder installer exited with code $LASTEXITCODE" }
} finally {
	Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
