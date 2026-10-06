# Released assets own behavior; beta's installer also understands dev snapshots.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$channel = if ($env:CLIO_CODER_CHANNEL) { $env:CLIO_CODER_CHANNEL } else { 'latest' }
$version = $env:CLIO_CODER_VERSION
for ($i = 0; $i -lt $args.Count; $i++) {
	if ($args[$i] -eq '-Channel' -and $i + 1 -lt $args.Count) { $i++; $channel = $args[$i] }
	elseif ($args[$i] -eq '-Version' -and $i + 1 -lt $args.Count) { $i++; $version = $args[$i] }
}
if ($version -in @('latest', 'beta', 'dev')) { $channel = $version }
$file = Join-Path ([IO.Path]::GetTempPath()) ("clio-coder-install-" + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
	$url = 'https://github.com/iowarp/clio-coder/releases/latest/download/install.ps1'
	if ($channel -in @('beta', 'dev')) {
		try {
			$rc = (Invoke-RestMethod -UseBasicParsing 'https://registry.npmjs.org/@iowarp/clio-coder/beta').version
			if ($rc -match '^\d+\.\d+\.\d+(-rc\.\d+)?$') { $url = "https://github.com/iowarp/clio-coder/releases/download/v$rc/install.ps1" }
		} catch { # A missing beta channel still uses the stable installer.
		}
	}
	try { Invoke-WebRequest -UseBasicParsing $url -OutFile $file }
	catch { Invoke-WebRequest -UseBasicParsing 'https://github.com/iowarp/clio-coder/releases/latest/download/install.ps1' -OutFile $file }
	# Native -File parsing preserves named flags; script-block array splatting is positional.
	$forwarded = @($args)
	if (-not $version) { $forwarded += @('-Version', $channel) }
	& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file @forwarded
	if ($LASTEXITCODE -ne 0) { throw "Clio Coder installer exited with code $LASTEXITCODE" }
} finally {
	Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
