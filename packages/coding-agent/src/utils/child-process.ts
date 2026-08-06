import { type ChildProcess, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";

const EXIT_STDIO_GRACE_MS = 100;

// Package managers Windows commonly installs as a `.cmd` shim rather than an
// executable; spawning those by bare name only resolves through a shell.
const WINDOWS_SHELL_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn", "yarnpkg", "corepack", "bun"]);

export function shouldUseWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	const commandName = basename(command).toLowerCase();
	return commandName.endsWith(".cmd") || commandName.endsWith(".bat") || WINDOWS_SHELL_COMMANDS.has(commandName);
}

/**
 * Terminate a process and everything it spawned.
 *
 * Unix signals the process group, which reaches descendants in one call. Windows
 * has no process groups to signal — `process.kill` there terminates exactly one
 * process — so a daemon's workers, its catalog child, and their Python kernels
 * all survive their parent and accumulate. `taskkill /T` walks the real process
 * tree instead. It runs synchronously so teardown paths can rely on it having
 * happened, and it is fast enough (tens of milliseconds) to sit in a shutdown.
 */
export function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		killWindowsProcessTree(pid);
		return;
	}
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Fall back when process groups are unavailable or the group already exited.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// The process may already be fully reaped.
	}
}

function killWindowsProcessTree(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) {
		return;
	}
	try {
		// `windowsHide` matters here: a daemon owns no console, having been spawned
		// detached, and a console child of a console-less parent gets a new console
		// *with a visible window* that outlives it. A teardown killing many
		// processes would leave a desktop full of black windows to close by hand.
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
	} catch {
		// taskkill is unavailable or the tree is already gone; fall back to the
		// single process so at least the root does not linger.
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already reaped.
		}
	}
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
function signalExitCode(signal: NodeJS.Signals | null): number | null {
	if (!signal) return null;
	const signalNumber = constants.signals[signal];
	return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function normalizedExitCode(code: number | null, signal: NodeJS.Signals | null): number | null {
	return code ?? signalExitCode(signal);
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(normalizedExitCode(exitCode, exitSignal));
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(normalizedExitCode(code, signal)), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
			finalize(normalizedExitCode(code, signal));
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode, child.signalCode);
		}
	});
}
