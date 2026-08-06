<#
.SYNOPSIS
Installs Prime Agent on Windows.

.DESCRIPTION
The Windows counterpart to install.sh. It resolves a release version from the
requested channel, downloads the release tarball and its SHA256SUMS, verifies
the checksum, and installs the package globally with npm.

Release publishing rewrites the sentinels below, exactly as it does for
install.sh. An unpublished copy needs PRIME_AGENT_DOWNLOAD_BASE_URL set.

.PARAMETER Channel
`stable`, `beta`, or an explicit version such as `0.7.0`. Defaults to the
channel baked in at publish time.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
	[string]$Channel
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep these sentinels split so release publishing only rewrites the configured
# values below; local or unpublished copies still need unreplaced values to compare.
$unconfiguredBaseUrl = '__PRIME_AGENT_DOWNLOAD_BASE' + '_URL__'
$unconfiguredDefaultChannel = '__PRIME_AGENT_DEFAULT_RELEASE_' + 'CHANNEL__'
$baseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) { $env:PRIME_AGENT_DOWNLOAD_BASE_URL } else { '__PRIME_AGENT_DOWNLOAD_BASE_URL__' }
$baseUrl = $baseUrl.TrimEnd('/')
$defaultChannel = '__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__'
if ($defaultChannel -eq $unconfiguredDefaultChannel) { $defaultChannel = 'stable' }
$releaseChannel = if ($env:PRIME_AGENT_RELEASE_CHANNEL) { $env:PRIME_AGENT_RELEASE_CHANNEL } else { $defaultChannel }
$packageName = if ($env:PRIME_AGENT_PACKAGE) { $env:PRIME_AGENT_PACKAGE } else { 'prime-agent' }
$commandName = if ($env:PRIME_AGENT_CMD) { $env:PRIME_AGENT_CMD } else { 'prime-agent' }

function Fail([string]$message) {
	Write-Host "error: $message" -ForegroundColor Red
	exit 1
}

function Get-CommandPath([string]$name) {
	$command = Get-Command $name -ErrorAction SilentlyContinue
	if ($command) { return $command.Source }
	return $null
}

function Test-Preflight {
	$node = Get-CommandPath 'node'
	if (-not $node) {
		Fail 'Node.js 20.6.0 or newer is required to install Prime Agent. Install it from https://nodejs.org and run this installer again.'
	}
	$nodeVersion = (& node --version).Trim()
	& node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && (minor > 6 || (minor === 6 && patch >= 0))) ? 0 : 1)' | Out-Null
	if ($LASTEXITCODE -ne 0) {
		Fail "Prime Agent requires Node.js 20.6.0 or newer. Found $nodeVersion."
	}
	if (-not (Get-CommandPath 'npm')) {
		Fail 'npm is required to install Prime Agent.'
	}

	$existing = Get-CommandPath $commandName
	if ($existing) {
		Write-Host "Existing $commandName found at: $existing" -ForegroundColor Yellow
	}
}

function ConvertTo-NormalizedVersion([string]$candidate) {
	$version = $candidate -replace '^v', ''
	if (-not $version) { Fail 'empty Prime Agent version.' }
	if ($version -notmatch '^[0-9A-Za-z.-]+$') { Fail "invalid Prime Agent version: $candidate" }
	return $version
}

function Resolve-PrimeAgentVersion([string]$requested) {
	$channel = $releaseChannel
	if ($requested) {
		if ($requested -eq 'stable' -or $requested -eq 'beta') {
			$channel = $requested
		} else {
			return ConvertTo-NormalizedVersion $requested
		}
	}
	if ($env:PRIME_AGENT_VERSION) {
		return ConvertTo-NormalizedVersion $env:PRIME_AGENT_VERSION
	}
	if ($channel -ne 'stable' -and $channel -ne 'beta') {
		Fail "invalid Prime Agent release channel: $channel"
	}

	Write-Host "Resolving the latest $channel release..."
	try {
		$channelVersion = (Invoke-WebRequest -Uri "$baseUrl/$channel" -UseBasicParsing).Content
	} catch {
		Fail "could not resolve latest Prime Agent version from $baseUrl/$channel"
	}
	$channelVersion = ($channelVersion -replace '\s', '')
	if (-not $channelVersion) {
		Fail "could not resolve latest Prime Agent version from $baseUrl/$channel"
	}
	return ConvertTo-NormalizedVersion $channelVersion
}

function Get-VerifiedTarball([string]$version, [string]$downloadDir) {
	$tarballName = "$packageName-$version.tgz"
	$tarballPath = Join-Path $downloadDir $tarballName
	$checksumsPath = Join-Path $downloadDir 'SHA256SUMS'

	Write-Host "Downloading release checksums..."
	Invoke-WebRequest -Uri "$baseUrl/releases/v$version/SHA256SUMS" -OutFile $checksumsPath -UseBasicParsing

	Write-Host "Downloading Prime Agent v$version..."
	Invoke-WebRequest -Uri "$baseUrl/releases/v$version/$tarballName" -OutFile $tarballPath -UseBasicParsing

	$expected = $null
	foreach ($line in Get-Content -LiteralPath $checksumsPath) {
		$fields = $line.Trim() -split '\s+', 2
		if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq $tarballName) {
			$expected = $fields[0].ToLowerInvariant()
			break
		}
	}
	if (-not $expected) {
		Fail "checksum for $tarballName was not found in $checksumsPath"
	}

	Write-Host 'Verifying SHA-256...'
	$actual = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($actual -ne $expected) {
		Fail "checksum mismatch for $tarballName (expected $expected, got $actual)"
	}
	return $tarballPath
}

function Test-KernelRuntimeSetup {
	if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq '1') { return $true }
	if ($env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL -eq '0') { return $false }
	if (-not [Environment]::UserInteractive -or $Host.Name -eq 'Default Host') {
		Write-Host 'No terminal detected; preparing the IPython runtime during install.'
		return $true
	}
	Write-Host ''
	Write-Host 'Prepare IPython runtime now?'
	Write-Host 'Installs uv, Python 3.11, ipykernel, and Prime Agent runtime.'
	$answer = Read-Host 'Prepare? [Y/n]'
	if ($answer -match '^(n|no)$') {
		Write-Host 'IPython setup skipped. The runtime can be prepared on first ipython use.'
		return $false
	}
	return $true
}

Write-Host ''
Write-Host '  Installing Prime Agent' -ForegroundColor White
Write-Host '  npm global install' -ForegroundColor DarkGray
Write-Host ''

if ($baseUrl -eq $unconfiguredBaseUrl) {
	Write-Host 'error: installer download URL is not configured.' -ForegroundColor Red
	Write-Host 'Set PRIME_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow.' -ForegroundColor Red
	exit 1
}

Test-Preflight
$version = Resolve-PrimeAgentVersion $Channel
$bootstrapKernel = Test-KernelRuntimeSetup

$downloadDir = Join-Path ([System.IO.Path]::GetTempPath()) "prime-agent-install-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $downloadDir | Out-Null
try {
	$tarballPath = Get-VerifiedTarball $version $downloadDir

	Write-Host 'Installing Prime Agent...'
	$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = '1'
	if ($bootstrapKernel) {
		$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = '1'
		$env:PRIME_AGENT_INSTALL_UV = '1'
	}
	& npm install -g --no-fund --no-audit --loglevel=error --progress=false $tarballPath
	if ($LASTEXITCODE -ne 0) {
		Fail "npm install failed with exit code $LASTEXITCODE"
	}
} finally {
	Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Prime Agent was installed successfully.' -ForegroundColor Green
if (Get-CommandPath $commandName) {
	Write-Host ''
	Write-Host "Run it with: $commandName"
} else {
	Write-Host ''
	Write-Host @"
The $commandName command was installed, but it is not on your PATH yet.
Check npm's global bin directory with:

  npm prefix -g

Then add that directory to your PATH.
"@
}
