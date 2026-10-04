# Clio Coder installer for Windows: a private Node.js runtime plus the npm
# package, in your user profile, with no administrator rights and no system Node.
#
#   irm https://coder.iowarp.ai/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://coder.iowarp.ai/install.ps1))) -Version 0.6.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Package .\iowarp-clio-coder-0.6.0.tgz
#
# The Windows counterpart of scripts/install.sh, with the same layout so
# `clio-coder doctor`, `upgrade` and `uninstall` read both the same way:
#   <InstallDir>\runtime\node-v<ver>-win-<arch>\node.exe
#   <InstallDir>\versions\<version>\lib\node_modules\@iowarp\clio-coder
#   <InstallDir>\install.json
#   <BinDir>\clio-coder.cmd
# It downloads the official win-x64 or win-arm64 zip, verifies it against
# SHASUMS256.txt (and that file's OpenPGP signature when gpg is on PATH), and
# never changes the user PATH unless -AddToPath (or CLIO_CODER_MODIFY_PATH=1).
#
# Native Windows is best effort for Clio Coder; Linux, macOS and WSL are the
# primary platforms.
#
# Everything runs inside Install-ClioCoder, called on the last line, so a
# truncated download fails to parse and runs nothing.
[CmdletBinding()]
param(
	[string]$Version = $env:CLIO_CODER_VERSION,
	[string]$Channel = $(if ($env:CLIO_CODER_CHANNEL) { $env:CLIO_CODER_CHANNEL } else { "latest" }),
	[string]$Package = $env:CLIO_CODER_PACKAGE,
	[string]$NodeVersion = $(if ($env:CLIO_CODER_NODE_VERSION) { $env:CLIO_CODER_NODE_VERSION } else { "24" }),
	[string]$NodeZip = $env:CLIO_CODER_NODE_TARBALL,
	[string]$InstallDir = $env:CLIO_CODER_INSTALL_DIR,
	[string]$BinDir = $env:CLIO_CODER_BIN_DIR,
	[switch]$OmitOptional,
	[switch]$IncludeClaudeSdk,
	[switch]$AddToPath,
	[switch]$NoModifyPath,
	[switch]$NoAutoUpdate,
	[switch]$AutoUpdate,
	[switch]$Rollback,
	[switch]$NoPostInstall,
	[switch]$RefreshRuntime,
	[switch]$Force,
	[switch]$DryRun
)

function Install-ClioCoder {
	param($Options)
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"
	# Windows PowerShell 5.1 defaults to TLS 1.0, which nodejs.org refuses.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$PackageName = "@iowarp/clio-coder"
	# Mirrors package.json engines.node.
	$NodeMin = [version]"22.19.0"
	$LauncherMark = "# clio-coder-installer launcher"
	$OfficialBase = if ($env:CLIO_CODER_NODE_MIRROR) { $env:CLIO_CODER_NODE_MIRROR.TrimEnd("/") } else { "https://nodejs.org/dist" }
	$KeyringUrl = "https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx"

	function Say([string]$Text) { Write-Host "[install] $Text" }
	function Ok([string]$Text) { Write-Host "[install] ok: $Text" }
	function Warn([string]$Text) { Write-Warning $Text }
	function Fail([string]$Text) { throw "[install] error: $Text" }

	function Get-File([string]$Url, [string]$Out) {
		if ($Url.StartsWith("file://")) {
			Copy-Item -LiteralPath ([uri]$Url).LocalPath -Destination $Out
			return
		}
		Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out
	}

	if ($Options.Channel -notin @("latest", "beta", "dev")) { Fail "-Channel must be latest, beta or dev, got '$($Options.Channel)'" }
	$spec = $Options.Channel
	if ($Options.Version) {
		$v = $Options.Version -replace "^v(?=\d)", ""
		if ($v -notmatch "^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$" -and $v -notmatch "^[a-z][a-z0-9-]{0,31}$") {
			Fail "invalid -Version '$($Options.Version)'; use an exact version such as 0.6.0 or a dist-tag such as beta"
		}
		$spec = $v
	}

	$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	$build = switch ($arch) {
		"AMD64" { "win-x64" }
		"ARM64" { "win-arm64" }
		default { Fail "unsupported CPU '$arch'; Node.js ships win-x64 and win-arm64" }
	}
	$installRoot = if ($Options.InstallDir) { $Options.InstallDir } elseif ($env:CLIO_CODER_HOME) { Join-Path $env:CLIO_CODER_HOME "install" } else { Join-Path $env:LOCALAPPDATA "clio-coder\install" }
	$binDir = if ($Options.BinDir) { $Options.BinDir } else { Join-Path $env:USERPROFILE ".local\bin" }
	# Resolve against the PowerShell location: [IO.Path]::GetFullPath uses the
	# process directory, which `cd` in an interactive session does not move.
	function Get-AbsolutePath([string]$Path) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }
	$installRoot = Get-AbsolutePath $installRoot
	$binDir = Get-AbsolutePath $binDir
	$launcher = Join-Path $binDir "clio-coder.cmd"
	$installSpec = if ($Options.Package) { Get-AbsolutePath $Options.Package } else { "$PackageName@$spec" }
	if ($Options.Package -and -not (Test-Path -LiteralPath $installSpec)) { Fail "-Package $installSpec does not exist" }

	Say "platform:     Windows $build (PowerShell $($PSVersionTable.PSVersion))"
	Say "package:      $installSpec"
	Say "install root: $installRoot"
	Say "launcher:     $launcher"

	if ((Test-Path -LiteralPath $launcher) -and -not ((Get-Content -LiteralPath $launcher -Raw) -match [regex]::Escape($LauncherMark)) -and -not $Options.Force) {
		Fail "refusing to overwrite $launcher, which this installer did not write; move it aside, choose another -BinDir, or pass -Force"
	}
	if ($Options.DryRun) {
		if ($Options.Rollback) {
			Say "would point $launcher back at the previous version recorded in $installRoot\install.json"
			Ok "dry run complete; nothing was changed"
			return
		}
		Say "would install Node $($Options.NodeVersion) ($build) and run its npm: npm install --prefix $installRoot\versions\<version>\lib $installSpec"
		Ok "dry run complete; nothing was downloaded or changed"
		return
	}

	$manifestFile = Join-Path $installRoot "install.json"
	if ($Options.Rollback -and -not (Test-Path -LiteralPath $manifestFile)) { Fail "no installer manifest at $manifestFile; nothing to roll back" }
	New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
	$lock = Join-Path $installRoot ".install-lock"
	try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null }
	catch { Fail "installation locked at $lock. If its pid process has exited, remove only that lock directory and retry." }
	[IO.File]::WriteAllText((Join-Path $lock "pid"), [string]$PID)
	$work = $null
	try {
	if ($Options.Rollback) {
		$old = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
		$helper = Join-Path $old.current "lib\node_modules\@iowarp\clio-coder\scripts\native-install.cjs"
		& $old.node $helper rollback $installRoot
		if ($LASTEXITCODE -ne 0) { Fail "rollback failed; active install preserved" }
		return
	}
	if (-not $Options.Version -and -not $Options.Package -and (Test-Path -LiteralPath $manifestFile)) {
		$policy = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
		if ($policy.versionPin) { $Options.Version = [string]$policy.versionPin; $installSpec = "$PackageName@$($policy.versionPin)" }
	}
	$owner = Join-Path $installRoot ".installer-owner"
	if (-not (Test-Path -LiteralPath (Join-Path $installRoot "install.json")) -and -not (Test-Path -LiteralPath $owner)) {
		if ((Test-Path -LiteralPath (Join-Path $installRoot "runtime")) -or (Test-Path -LiteralPath (Join-Path $installRoot "versions"))) { Fail "refusing to claim existing runtime/versions directories without installer ownership" }
	}
	[IO.File]::WriteAllText($owner, "clio-coder-installer")
	New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "runtime"), (Join-Path $installRoot "versions"), $binDir | Out-Null
	$work = Join-Path $installRoot (".work." + [guid]::NewGuid().ToString("N").Substring(0, 8))
	New-Item -ItemType Directory -Force -Path $work | Out-Null
		# Resolve the Node version: an exact x.y.z passes through, a major picks
		# the newest release that ships this build's zip.
		$nodeVersion = $Options.NodeVersion -replace "^v", ""
		$zipName = $null
		if ($Options.NodeZip) {
			$zipName = Split-Path -Leaf $Options.NodeZip
			if ($zipName -notmatch "^node-v(\d+\.\d+\.\d+)-(win-[a-z0-9]+)\.zip$") { Fail "-NodeZip must keep its release file name, such as node-v24.11.1-win-x64.zip" }
			$nodeVersion = $Matches[1]
			if ($Matches[2] -ne $build) { Fail "-NodeZip architecture $($Matches[2]) does not match $build" }
		} elseif ($nodeVersion -notmatch "^\d+\.\d+\.\d+$") {
			if ($nodeVersion -notmatch "^\d+$") { Fail "invalid Node version '$nodeVersion'; use a major such as 24 or an exact version" }
			$index = Join-Path $work "index.json"
			Get-File "$OfficialBase/index.json" $index
			$release = (Get-Content -LiteralPath $index -Raw | ConvertFrom-Json) |
				Where-Object { $_.version -like "v$nodeVersion.*" -and $_.files -contains "$build-zip" } |
				Select-Object -First 1
			if (-not $release) { Fail "no Node.js $nodeVersion.x release at $OfficialBase ships $build" }
			$nodeVersion = $release.version.TrimStart("v")
		}
		if ([version]$nodeVersion -lt $NodeMin) { Fail "Node $nodeVersion is older than Clio Coder's floor $NodeMin" }
		if (-not $zipName) { $zipName = "node-v$nodeVersion-$build.zip" }
		$runtimeDir = Join-Path $installRoot "runtime\node-v$nodeVersion-$build"
		$node = Join-Path $runtimeDir "node.exe"

		if ((Test-Path -LiteralPath $node) -and -not $Options.RefreshRuntime) {
			Ok "reusing Node v$nodeVersion at $runtimeDir"
		} else {
			$zip = Join-Path $work $zipName
			$sums = Join-Path $work "SHASUMS256.txt"
			if ($Options.NodeZip) {
				Copy-Item -LiteralPath $Options.NodeZip -Destination $zip
				$localSums = if ($env:CLIO_CODER_NODE_SHASUMS) { $env:CLIO_CODER_NODE_SHASUMS } else { Join-Path (Split-Path -Parent $Options.NodeZip) "SHASUMS256.txt" }
				if (-not (Test-Path -LiteralPath $localSums)) { Fail "no SHASUMS256.txt next to $($Options.NodeZip); copy it from the same release or set CLIO_CODER_NODE_SHASUMS" }
				Copy-Item -LiteralPath $localSums -Destination $sums
				if (Test-Path -LiteralPath "$localSums.asc") { Copy-Item -LiteralPath "$localSums.asc" -Destination "$sums.asc" }
			} else {
				Say "downloading $OfficialBase/v$nodeVersion/$zipName"
				Get-File "$OfficialBase/v$nodeVersion/$zipName" $zip
				Get-File "$OfficialBase/v$nodeVersion/SHASUMS256.txt" $sums
				try { Get-File "$OfficialBase/v$nodeVersion/SHASUMS256.txt.asc" "$sums.asc" } catch { Remove-Item -LiteralPath "$sums.asc" -ErrorAction SilentlyContinue }
			}
			$signed = $false
			$gpgv = Get-Command gpgv -ErrorAction SilentlyContinue
			$unsignedReason = if (-not $gpgv) { "no gpgv on PATH" } elseif (-not (Test-Path -LiteralPath "$sums.asc")) { "no SHASUMS256.txt.asc signature" } else { "" }
			if ($gpgv -and (Test-Path -LiteralPath "$sums.asc")) {
				$keyring = if ($env:CLIO_CODER_NODE_KEYRING) { $env:CLIO_CODER_NODE_KEYRING } else { Join-Path $work "pubring.kbx" }
				if (-not $env:CLIO_CODER_NODE_KEYRING) { try { Get-File $KeyringUrl $keyring } catch { $keyring = $null; $unsignedReason = "the Node.js release keys could not be fetched" } }
				if ($keyring) {
					$unsignedReason = "gpgv could not check the signature"
					$status = & $gpgv.Source --status-fd 1 --keyring $keyring --output "$sums.verified" "$sums.asc" 2>$null
					if ($status -match "BADSIG") { Fail "the OpenPGP signature on SHASUMS256.txt is BAD; refusing to install" }
					if ($status -match "VALIDSIG") { $sums = "$sums.verified"; $signed = $true; Ok "SHASUMS256.txt signature verified against the Node.js release keys" }
				}
			}
			if (-not $signed) {
				if ($env:CLIO_CODER_REQUIRE_SIGNATURE -eq "1") { Fail "CLIO_CODER_REQUIRE_SIGNATURE=1, but no verified signature covers SHASUMS256.txt" }
				Say "$unsignedReason; verifying the checksum from SHASUMS256.txt over HTTPS"
			}
			$expected = (Get-Content -LiteralPath $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+$([regex]::Escape($zipName))$" } | Select-Object -First 1) -replace "\s.*$", ""
			if (-not $expected) { Fail "$zipName is not listed in SHASUMS256.txt; refusing to install it" }
			$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
			if ($actual -ne $expected) { Fail "checksum mismatch for $zipName (expected $expected, got $actual); refusing to install it" }
			Ok "checksum verified for $zipName"

			$unpack = Join-Path $work "runtime"
			Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue
			New-Item -ItemType Directory -Force -Path $unpack | Out-Null
			# bsdtar ships with Windows 10 1803 and later and is far faster than Expand-Archive.
			$tar = Join-Path $env:SystemRoot "System32\tar.exe"
			if (Test-Path -LiteralPath $tar) { & $tar -xf $zip -C $unpack; if ($LASTEXITCODE -ne 0) { Fail "could not unpack $zipName" } }
			else { Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force }
			if (Test-Path -LiteralPath $runtimeDir) { $runtimeDir = "$runtimeDir-$PID"; $node = Join-Path $runtimeDir "node.exe" }
			Move-Item -LiteralPath (Join-Path $unpack "node-v$nodeVersion-$build") -Destination $runtimeDir
			Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue
		}
		$ran = & $node -e "process.stdout.write(process.versions.node)"
		if ($LASTEXITCODE -ne 0 -or -not $ran) { Fail "the managed Node at $node does not run" }
		Ok "Node v$ran runs ($build)"

		# Retain every runtime and package prefix while old sessions may still use them.
		$manifestPath = Join-Path $installRoot "install.json"
		$old = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
		$previous = if ($old -and $old.current -and (Test-Path -LiteralPath $old.current)) { $old.current } else { "" }
		$staging = Join-Path $installRoot "versions\.staging-$PID"
		New-Item -ItemType Directory -Force -Path (Join-Path $staging "lib") | Out-Null
		$npmCli = Join-Path $runtimeDir "node_modules\npm\bin\npm-cli.js"
		$npmArgs = @($npmCli, "install", "--prefix", (Join-Path $staging "lib"), "--no-save", "--loglevel=error")
		if (-not $Options.IncludeClaudeSdk) { $npmArgs += "--omit=optional" } else { $npmArgs += "--include=optional" }
		$npmArgs += $installSpec
		Say "installing $installSpec with the npm bundled in Node v$nodeVersion"
		$savedPath = $env:Path
		$env:Path = "$runtimeDir;$env:Path"
		$env:npm_config_update_notifier = "false"; $env:npm_config_fund = "false"; $env:npm_config_audit = "false"
		try { & $node @npmArgs } finally { $env:Path = $savedPath }
		if ($LASTEXITCODE -ne 0) { Fail "npm could not install $installSpec (network, proxy via HTTPS_PROXY, npm_config_registry, or disk space)" }
		$pkgJson = Join-Path $staging "lib\node_modules\@iowarp\clio-coder\package.json"
		$pkg = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
		if ($pkg.name -ne $PackageName) { Fail "npm finished, but $pkgJson is not $PackageName" }
		if ([version](($pkg.version -split '-')[0]) -lt [version]"0.6.0") { Fail "Native Windows managed lifecycle requires 0.6.0 or later; registry returned $($pkg.version). Previous install and launcher remain active. No package has been published by this installer." }
		# A refused candidate was never activated, so no session runs from it; a retry replaces it instead of stacking copies.
		Get-ChildItem -LiteralPath (Join-Path $installRoot "versions") -Directory -ErrorAction SilentlyContinue |
			Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName ".clio-coder-refused-candidate") } |
			ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
		$final = Join-Path $installRoot "versions\$($pkg.version)"
		if (Test-Path -LiteralPath $final) { $final = "$final-$(Get-Date -Format yyyyMMddHHmmss)" }
		Move-Item -LiteralPath $staging -Destination $final
		$entry = Join-Path $final "lib\node_modules\@iowarp\clio-coder\dist\cli\index.js"
		Ok "installed $PackageName $($pkg.version)"

		$helper = Join-Path $final "lib\node_modules\@iowarp\clio-coder\scripts\native-install.cjs"
		if (-not (Test-Path -LiteralPath $helper)) { Fail "candidate lacks lifecycle helper; previous install remains active. Run: clio-coder doctor --fix" }
		$pin = if ($Options.Package -or $Options.Version -match "^v?\d+\.\d+\.\d+") { [string]$pkg.version } else { "-" }
		$auto = if ($Options.NoAutoUpdate -or $env:CLIO_CODER_AUTO_UPDATE -eq "0") { "0" } elseif ($env:CLIO_CODER_AUTO_UPDATE -eq "1") { "1" } else { "preserve" }
		if ($Options.AutoUpdate) { $auto = "1" }
		$post = if ($Options.NoPostInstall) { "0" } else { "1" }
		& $node $helper activate $installRoot $node $nodeVersion $build $final $launcher $Options.Channel $pin $auto $post
		# The clio-coder on PATH is still the previous version, and a version that predates a repair reports nothing to fix.
		if ($LASTEXITCODE -ne 0) { New-Item -ItemType File -Force -Path (Join-Path $final ".clio-coder-refused-candidate") | Out-Null }
		if ($LASTEXITCODE -ne 0) { Fail "candidate checks failed; previous install remains active. Repair with the new version itself, then rerun this installer: & `"$node`" `"$entry`" doctor --fix" }
		if (-not $Options.NoPostInstall) {
			& $node $entry upgrade --post-install
			if ($LASTEXITCODE -ne 0) { Fail "package installed, but local migrations/initialization need attention. Run clio-coder upgrade --post-install; the previous version remains available with: clio-coder upgrade --rollback" }
		}
		$reported = & $node $entry --version
		if ($LASTEXITCODE -ne 0) { Fail "active CLI failed version check" }
		Ok "$reported"

		# Read and write the raw registry value: [Environment]::SetEnvironmentVariable
		# would store it as REG_SZ and stop %USERPROFILE%-style entries expanding.
		$modifyPath = -not $Options.NoModifyPath -and ($Options.AddToPath -or $env:CLIO_CODER_MODIFY_PATH -eq "1")
		$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", [bool]$modifyPath)
		$rawPath = if ($envKey) { [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { "" }
		$onPath = @([Environment]::ExpandEnvironmentVariables($rawPath) -split ";" | ForEach-Object { $_.TrimEnd("\") }) -contains $binDir.TrimEnd("\")
		if ($onPath) {
			# No PATH hint is needed for an existing entry.
		} elseif ($modifyPath) {
			if (-not $envKey) { $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment") }
			$kind = if ($envKey.GetValueNames() -contains "Path") { $envKey.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
			$envKey.SetValue("Path", ((@($rawPath.TrimEnd(";"), $binDir) | Where-Object { $_ }) -join ";"), $kind)
			& $node $helper path-added $installRoot $binDir
			if ($LASTEXITCODE -ne 0) { Fail "PATH was added but ownership receipt could not be written; review $manifestPath" }
			# Setting any user variable broadcasts WM_SETTINGCHANGE so new terminals see the change.
			[Environment]::SetEnvironmentVariable("CLIO_CODER_PATH_REFRESH", $null, "User")
			if (($env:Path -split ";") -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }
			Ok "added $binDir to your user PATH and this session; open a new terminal to use it"
		} else {
			Warn "$binDir is not on your PATH. Rerun with -AddToPath (or set CLIO_CODER_MODIFY_PATH=1), or add it yourself."
		}
		if ($envKey) { $envKey.Dispose() }
		Write-Host "Run: clio-coder"
		# Native Windows has no background service yet; `clio-coder gui` starts a private server and prints its link.
		Write-Host "Desktop app: clio-coder gui"
	} finally {
		Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
		if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
		Remove-Item -LiteralPath (Join-Path $installRoot "versions\.staging-$PID") -Recurse -Force -ErrorAction SilentlyContinue
	}
}

# Set only when PowerShell runs this file with -File; `irm | iex` and a script block leave it empty.
$InvokedAsFile = [bool]$MyInvocation.MyCommand.Path
try {
	Install-ClioCoder -Options ([pscustomobject]@{
		Version = $Version; Channel = $Channel; Package = $Package; NodeVersion = $NodeVersion; NodeZip = $NodeZip
		InstallDir = $InstallDir; BinDir = $BinDir; IncludeClaudeSdk = [bool]$IncludeClaudeSdk; AddToPath = [bool]$AddToPath
		NoModifyPath = [bool]$NoModifyPath; NoAutoUpdate = [bool]$NoAutoUpdate; AutoUpdate = [bool]$AutoUpdate; Rollback = [bool]$Rollback
		NoPostInstall = [bool]$NoPostInstall; RefreshRuntime = [bool]$RefreshRuntime; Force = [bool]$Force; DryRun = [bool]$DryRun
	})
} catch {
	# An installer refusal is one line with its fix, as on Linux; anything else keeps its position for a bug report.
	$message = $_.Exception.Message
	if (-not $message.StartsWith("[install] error:")) { $message = "[install] error: $message`n$($_.InvocationInfo.PositionMessage)" }
	[Console]::Error.WriteLine($message)
	# A file run reports failure through its exit code; under `irm | iex`, exit would close the caller's shell.
	if ($InvokedAsFile) { exit 1 }
}
