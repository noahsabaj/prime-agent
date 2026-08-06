# Windows source runner. Mirrors prime-agent.sh so a checkout runs natively
# without Git Bash. Requires Node.js 22.8.0 or newer and `npm install` at the
# repo root.
#Requires -Version 5.1
[CmdletBinding()]
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$Args
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PRIME_AGENT_LAUNCHER_PATH = Join-Path $scriptDir 'prime-agent.ps1'

$buildId = & git -C $scriptDir describe --tags --always --dirty 2>$null
if ($LASTEXITCODE -eq 0 -and $buildId) {
	$env:PRIME_AGENT_BUILD_ID = $buildId.Trim()
}

# Keys unset by --no-env (see packages/ai/src/env-api-keys.ts).
$apiKeyVars = @(
	'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'PRIME_API_KEY', 'GEMINI_API_KEY',
	'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY',
	'MISTRAL_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENCODE_API_KEY',
	'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN',
	'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
	'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION',
	'AWS_DEFAULT_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
	'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE',
	'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'
)

$noEnv = $false
$useDist = $false
$forwarded = @()
foreach ($arg in $Args) {
	if ($arg -eq '--no-env') { $noEnv = $true }
	elseif ($arg -eq '--dist') { $useDist = $true }
	else { $forwarded += $arg }
}

if ($noEnv) {
	foreach ($name in $apiKeyVars) {
		Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
	}
	Write-Host 'Running Prime Agent without API keys...'
}

# --dist runs the bundled build (what users get; ~3x faster startup than tsx).
if ($useDist) {
	$bundle = Join-Path $scriptDir 'packages\coding-agent\dist\bundle\cli.js'
	if (-not (Test-Path -LiteralPath $bundle)) {
		Write-Error "Bundle not found at $bundle. Run npm run build first."
		exit 1
	}
	& node $bundle @forwarded
	exit $LASTEXITCODE
}

$tsxBin = Join-Path $scriptDir 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path -LiteralPath $tsxBin)) {
	Write-Error "tsx not found at $tsxBin. Run npm install from the repo root first."
	exit 1
}

& $tsxBin (Join-Path $scriptDir 'packages\coding-agent\src\cli.ts') @forwarded
exit $LASTEXITCODE
