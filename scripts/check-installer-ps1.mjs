// install.ps1 is rewritten at publish time by the same sentinel replacement the
// release workflow applies to install.sh. This check keeps the two installers in
// contract: the sentinels must be present and identical, and the script must
// parse when a PowerShell is available to parse it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const failures = [];
const shellInstaller = readFileSync("install.sh", "utf-8");
const psInstaller = readFileSync("install.ps1", "utf-8");

const SENTINELS = ["__PRIME_AGENT_DOWNLOAD_BASE_URL__", "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"];

for (const sentinel of SENTINELS) {
	const shellCount = countOccurrences(shellInstaller, sentinel);
	const psCount = countOccurrences(psInstaller, sentinel);
	check(shellCount > 0, `install.sh no longer contains ${sentinel}`);
	check(psCount > 0, `install.ps1 does not contain ${sentinel}; publishing would leave it unconfigured`);
}

// The split sentinels must stay split, or replacement rewrites the comparison
// value too and an unpublished copy can no longer detect that it is unconfigured.
check(
	psInstaller.includes("'__PRIME_AGENT_DOWNLOAD_BASE' + '_URL__'"),
	"install.ps1 must keep the unconfigured base URL sentinel split across a concatenation",
);
check(
	psInstaller.includes("'__PRIME_AGENT_DEFAULT_RELEASE_' + 'CHANNEL__'"),
	"install.ps1 must keep the unconfigured channel sentinel split across a concatenation",
);

const powershell = findPowerShell();
if (powershell) {
	const result = spawnSync(
		powershell,
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('install.ps1', [ref]$null, [ref]$errors) | Out-Null; if ($errors) { $errors | ForEach-Object { Write-Output $_.ToString() }; exit 1 }",
		],
		{ encoding: "utf-8" },
	);
	check(result.status === 0, `install.ps1 failed to parse:\n${result.stdout}${result.stderr}`);
} else {
	console.log("No PowerShell found; skipped the install.ps1 parse check.");
}

if (failures.length > 0) {
	console.error(["Windows installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Windows installer check passed.");

function findPowerShell() {
	for (const candidate of ["pwsh", "powershell"]) {
		const probe = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf-8" });
		if (!probe.error && probe.status === 0) {
			return candidate;
		}
	}
	return undefined;
}

function countOccurrences(text, needle) {
	return text.split(needle).length - 1;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}
