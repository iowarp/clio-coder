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
param(
	[string]$Version = $env:CLIO_CODER_VERSION,
	[string]$Channel = $(if ($env:CLIO_CODER_CHANNEL) { $env:CLIO_CODER_CHANNEL } else { "latest" }),
	[string]$Package = $env:CLIO_CODER_PACKAGE,
	[string]$NodeVersion = $(if ($env:CLIO_CODER_NODE_VERSION) { $env:CLIO_CODER_NODE_VERSION } else { "24" }),
	[string]$NodeZip = $env:CLIO_CODER_NODE_TARBALL,
	[string]$InstallDir = $env:CLIO_CODER_INSTALL_DIR,
	[string]$BinDir = $env:CLIO_CODER_BIN_DIR,
	[switch]$OmitOptional,
	[switch]$AddToPath,
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
		Say "would install Node $($Options.NodeVersion) ($build) and run its npm: npm install --prefix $installRoot\versions\<version>\lib $installSpec"
		Ok "dry run complete; nothing was downloaded or changed"
		return
	}

	New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "runtime"), (Join-Path $installRoot "versions"), $binDir | Out-Null
	$work = Join-Path $installRoot (".work." + [guid]::NewGuid().ToString("N").Substring(0, 8))
	New-Item -ItemType Directory -Force -Path $work | Out-Null
	try {
		# Resolve the Node version: an exact x.y.z passes through, a major picks
		# the newest release that ships this build's zip.
		$nodeVersion = $Options.NodeVersion -replace "^v", ""
		$zipName = $null
		if ($Options.NodeZip) {
			$zipName = Split-Path -Leaf $Options.NodeZip
			if ($zipName -notmatch "^node-v(\d+\.\d+\.\d+)-(win-[a-z0-9]+)\.zip$") { Fail "-NodeZip must keep its release file name, such as node-v24.11.1-win-x64.zip" }
			$nodeVersion = $Matches[1]
			$build = $Matches[2]
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
			if ($gpgv -and (Test-Path -LiteralPath "$sums.asc")) {
				$keyring = if ($env:CLIO_CODER_NODE_KEYRING) { $env:CLIO_CODER_NODE_KEYRING } else { Join-Path $work "pubring.kbx" }
				if (-not $env:CLIO_CODER_NODE_KEYRING) { try { Get-File $KeyringUrl $keyring } catch { $keyring = $null } }
				if ($keyring) {
					$status = & $gpgv.Source --status-fd 1 --keyring $keyring --output "$sums.verified" "$sums.asc" 2>$null
					if ($status -match "BADSIG") { Fail "the OpenPGP signature on SHASUMS256.txt is BAD; refusing to install" }
					if ($status -match "VALIDSIG") { $sums = "$sums.verified"; $signed = $true; Ok "SHASUMS256.txt signature verified against the Node.js release keys" }
				}
			}
			if (-not $signed) {
				if ($env:CLIO_CODER_REQUIRE_SIGNATURE -eq "1") { Fail "CLIO_CODER_REQUIRE_SIGNATURE=1, but no verified signature covers SHASUMS256.txt" }
				Say "no gpgv on PATH; verifying the checksum from SHASUMS256.txt over HTTPS"
			}
			$expected = (Get-Content -LiteralPath $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+$([regex]::Escape($zipName))$" } | Select-Object -First 1) -replace "\s.*$", ""
			if (-not $expected) { Fail "$zipName is not listed in SHASUMS256.txt; refusing to install it" }
			$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
			if ($actual -ne $expected) { Fail "checksum mismatch for $zipName (expected $expected, got $actual); refusing to install it" }
			Ok "checksum verified for $zipName"

			$unpack = Join-Path $installRoot "runtime\.staging"
			Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue
			New-Item -ItemType Directory -Force -Path $unpack | Out-Null
			# bsdtar ships with Windows 10 1803 and later and is far faster than Expand-Archive.
			$tar = Join-Path $env:SystemRoot "System32\tar.exe"
			if (Test-Path -LiteralPath $tar) { & $tar -xf $zip -C $unpack; if ($LASTEXITCODE -ne 0) { Fail "could not unpack $zipName" } }
			else { Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force }
			if (Test-Path -LiteralPath $runtimeDir) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force }
			Move-Item -LiteralPath (Join-Path $unpack "node-v$nodeVersion-$build") -Destination $runtimeDir
			Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue
		}
		$ran = & $node -e "process.stdout.write(process.versions.node)"
		if ($LASTEXITCODE -ne 0 -or -not $ran) { Fail "the managed Node at $node does not run" }
		Ok "Node v$ran runs ($build)"

		# The version running now becomes the rollback target; older ones go first.
		$manifestPath = Join-Path $installRoot "install.json"
		$old = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
		$previous = if ($old -and $old.current -and (Test-Path -LiteralPath $old.current)) { $old.current } else { "" }
		$previousRuntime = if ($previous) { Split-Path -Parent $old.node } else { "" }
		$keep = @($previous, $runtimeDir, $previousRuntime) | Where-Object { $_ }
		Get-ChildItem -LiteralPath (Join-Path $installRoot "versions"), (Join-Path $installRoot "runtime") -Force |
			Where-Object { $keep -notcontains $_.FullName } |
			ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

		$staging = Join-Path $installRoot "versions\.staging"
		New-Item -ItemType Directory -Force -Path (Join-Path $staging "lib") | Out-Null
		$npmCli = Join-Path $runtimeDir "node_modules\npm\bin\npm-cli.js"
		$npmArgs = @($npmCli, "install", "--prefix", (Join-Path $staging "lib"), "--no-save", "--loglevel=error")
		if ($Options.OmitOptional) { $npmArgs += "--omit=optional" }
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
		$final = Join-Path $installRoot "versions\$($pkg.version)"
		if (Test-Path -LiteralPath $final) { $final = "$final-$(Get-Date -Format yyyyMMddHHmmss)" }
		Move-Item -LiteralPath $staging -Destination $final
		$entry = Join-Path $final "lib\node_modules\@iowarp\clio-coder\dist\cli\index.js"
		Ok "installed $PackageName $($pkg.version)"

		# Stage, then replace, so a concurrent clio-coder never reads half a file.
		$tmp = "$launcher.$PID.tmp"
		$body = "@echo off`r`nrem $LauncherMark`r`nrem Written by Clio Coder's install.ps1; remove it with: clio-coder uninstall --remove-binary`r`n`"$node`" `"$entry`" %*`r`n"
		[IO.File]::WriteAllText($tmp, $body, (New-Object Text.ASCIIEncoding))
		Move-Item -LiteralPath $tmp -Destination $launcher -Force

		$manifest = [ordered]@{
			schema = 1; kind = "clio-coder-installer"; node = $node; nodeVersion = $nodeVersion; nodeBuild = $build
			current = $final; previous = $previous; launcher = $launcher; channel = $Options.Channel
			installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
		}
		[IO.File]::WriteAllText("$manifestPath.tmp", ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
		Move-Item -LiteralPath "$manifestPath.tmp" -Destination $manifestPath -Force

		$reported = & $launcher --version
		Ok "$reported"

		# Read and write the raw registry value: [Environment]::SetEnvironmentVariable
		# would store it as REG_SZ and stop %USERPROFILE%-style entries expanding.
		$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
		$rawPath = [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
		$onPath = ([Environment]::ExpandEnvironmentVariables($rawPath) -split ";") -contains $binDir
		if ($onPath) {
			Ok "$binDir is on your user PATH"
		} elseif ($Options.AddToPath -or $env:CLIO_CODER_MODIFY_PATH -eq "1") {
			$kind = if ($envKey.GetValueNames() -contains "Path") { $envKey.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
			$envKey.SetValue("Path", ((@($rawPath.TrimEnd(";"), $binDir) | Where-Object { $_ }) -join ";"), $kind)
			# Setting any user variable broadcasts WM_SETTINGCHANGE so new terminals see the change.
			[Environment]::SetEnvironmentVariable("CLIO_CODER_PATH_REFRESH", $null, "User")
			Ok "added $binDir to your user PATH; open a new terminal to use it"
		} else {
			Warn "$binDir is not on your PATH. Rerun with -AddToPath (or set CLIO_CODER_MODIFY_PATH=1), or add it yourself."
		}
		if (-not $Options.NoPostInstall) {
			Say "running: $launcher upgrade --post-install"
			& $launcher upgrade --post-install
			if ($LASTEXITCODE -ne 0) { Fail "post-install checks did not finish; the package is installed. Run: $launcher upgrade --post-install" }
		}
		Write-Host ""
		Write-Host "Installed: $launcher"
		Write-Host "Runtime:   Node v$nodeVersion ($build), $runtimeDir"
		Write-Host "Package:   $final"
		Write-Host ""
		Write-Host "Verify, then configure a model target:"
		Write-Host "  & `"$launcher`" --version"
		Write-Host "  & `"$launcher`" doctor"
		Write-Host "  & `"$launcher`" configure"
		Write-Host ""
		Write-Host "Native Windows is best effort; WSL is the recommended way to run Clio Coder on Windows."
	} finally {
		Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath (Join-Path $installRoot "versions\.staging") -Recurse -Force -ErrorAction SilentlyContinue
	}
}

Install-ClioCoder -Options ([pscustomobject]@{
	Version = $Version; Channel = $Channel; Package = $Package; NodeVersion = $NodeVersion; NodeZip = $NodeZip
	InstallDir = $InstallDir; BinDir = $BinDir; OmitOptional = [bool]$OmitOptional; AddToPath = [bool]$AddToPath
	NoPostInstall = [bool]$NoPostInstall; RefreshRuntime = [bool]$RefreshRuntime; Force = [bool]$Force; DryRun = [bool]$DryRun
})
