import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const DAEMON_SOCKET_MODE = 0o600;
const DAEMON_SOCKET_DIR_MODE = 0o700;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;
const DAEMON_SOCKET_LOCK_STALE_MS = 5000;
const DAEMON_SOCKET_LOCK_UPDATE_MS = 1000;

export class DaemonSocketPathLease {
	private released = false;

	constructor(
		readonly socketPath: string,
		private readonly releaseLock: () => Promise<void>,
	) {}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		await this.releaseLock();
	}
}

export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

/** Windows named-pipe namespace. Every pipe lives directly under this prefix. */
export const WINDOWS_PIPE_DIR = "\\\\.\\pipe\\";
/**
 * The same namespace, spelled for `readdirSync`. libuv normalizes the
 * backslash form down to a relative path (`\\.\pipe\` becomes `<cwd-drive>:\.pipe\`)
 * and the listing fails with ENOENT; the forward-slash form survives.
 */
const WINDOWS_PIPE_DIR_FOR_READDIR = "//./pipe/";

let cachedWindowsPipePrefix: string | undefined;

/**
 * Pipe-name prefix scoping every prime-agent pipe to one user.
 *
 * The Windows pipe namespace is machine-global, so a fixed name collides between
 * concurrent users and lets one user's client reach another user's daemon. The
 * home directory is hashed in because usernames are not unique across domains
 * and are not all pipe-name-safe.
 */
export function windowsPipePrefix(): string {
	if (cachedWindowsPipePrefix) {
		return cachedWindowsPipePrefix;
	}
	let username = "user";
	try {
		username = userInfo().username || username;
	} catch {
		// userInfo throws when the account has no passwd entry; the hash still scopes the name.
	}
	const safeUsername =
		username
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "user";
	const identity = createHash("sha256").update(`${username}\0${homedir()}`).digest("hex").slice(0, 8);
	cachedWindowsPipePrefix = `prime-agent-${safeUsername}-${identity}-`;
	return cachedWindowsPipePrefix;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return `${WINDOWS_PIPE_DIR}${windowsPipePrefix()}daemon`;
	}
	return join(defaultDaemonSocketDir(), "daemon.sock");
}

/**
 * A user-supplied `--daemon-socket` value the platform can actually serve.
 *
 * Windows serves daemons on named pipes, so a filesystem path — which is what
 * the docs, unix habit, and every script written against them produce — cannot
 * be listened on and fails with EACCES. Map such a value to a stable pipe name
 * derived from it, so the same path always reaches the same daemon. Values
 * already in the pipe namespace pass through untouched.
 */
export function normalizeDaemonSocketPath(socketPath: string): string {
	if (process.platform !== "win32") {
		return socketPath;
	}
	const normalized = socketPath.split("/").join("\\").toLowerCase();
	if (normalized.startsWith("\\\\.\\pipe\\") || normalized.startsWith("\\\\?\\pipe\\")) {
		return socketPath;
	}
	const key = createHash("sha256").update(resolve(socketPath).toLowerCase()).digest("hex").slice(0, 16);
	return `${WINDOWS_PIPE_DIR}${windowsPipePrefix()}custom-${key}`;
}

/**
 * A real directory to keep a socket's sidecar files (locks, markers) in.
 *
 * On unix the socket is a file, so its own directory is the natural home. A
 * Windows pipe name is not a filesystem path at all — `dirname` on it yields
 * something like `D:\pipe`, and every sidecar write fails with ENOENT — so
 * those files go to the per-user socket directory instead.
 */
export function daemonSocketSidecarDir(socketPath: string): string {
	if (process.platform !== "win32") {
		return dirname(socketPath);
	}
	const dir = defaultDaemonSocketDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Every prime-agent pipe currently being served for this user.
 *
 * A named pipe exists only while its server holds it open, so unlike the unix
 * socket dir this never reports orphans — each entry is a live listener.
 */
export function listWindowsDaemonPipes(): string[] {
	if (process.platform !== "win32") {
		return [];
	}
	const prefix = windowsPipePrefix();
	try {
		return readdirSync(WINDOWS_PIPE_DIR_FOR_READDIR)
			.filter((name) => name.toLowerCase().startsWith(prefix))
			.map((name) => `${WINDOWS_PIPE_DIR}${name}`);
	} catch {
		// The pipe namespace is unreadable on some locked-down configurations.
		return [];
	}
}

export async function acquireDaemonSocketPathLease(socketPath: string): Promise<DaemonSocketPathLease | undefined> {
	ensureDefaultDaemonSocketDir(socketPath);
	if (process.platform === "win32") {
		return undefined;
	}
	const releaseLock = await lockfile.lock(socketPath, {
		realpath: false,
		stale: DAEMON_SOCKET_LOCK_STALE_MS,
		update: DAEMON_SOCKET_LOCK_UPDATE_MS,
		retries: {
			retries: 600,
			factor: 1,
			minTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
			maxTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
		},
	});
	return new DaemonSocketPathLease(socketPath, releaseLock);
}

export async function prepareDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	ensureDefaultDaemonSocketDir(socketPath);

	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		await prepareUnixDaemonSocketPath(socketPath);
		return;
	}
	if (!existsSync(socketPath)) {
		return;
	}
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const ownedLease = await acquireDaemonSocketPathLease(socketPath);
	try {
		await prepareUnixDaemonSocketPath(socketPath);
	} finally {
		await ownedLease?.release();
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	const staleIdentity: DaemonSocketIdentity = { dev: stat.dev, ino: stat.ino };
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const deadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	while (Date.now() < deadline) {
		await delay(DAEMON_SOCKET_RELEASE_POLL_MS);
		if (!existsSync(socketPath)) {
			return;
		}
		let currentIdentity: DaemonSocketIdentity | undefined;
		try {
			currentIdentity = getDaemonSocketIdentity(socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (!currentIdentity || currentIdentity.dev !== staleIdentity.dev || currentIdentity.ino !== staleIdentity.ino) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) {
			throw new Error(`Daemon socket already in use: ${socketPath}`);
		}
	}

	unlinkSync(socketPath);
}

export function restrictDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	chmodSync(socketPath, DAEMON_SOCKET_MODE);
}

export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") {
		return undefined;
	}
	const stat = lstatSync(socketPath);
	return { dev: stat.dev, ino: stat.ino };
}

export function cleanupDaemonSocketPath(
	socketPath: string,
	expectedIdentity?: DaemonSocketIdentity,
	lease?: DaemonSocketPathLease,
): void {
	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		try {
			cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
		} catch {
			// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
		}
		return;
	}
	let releaseLock: (() => void) | undefined;
	try {
		releaseLock = lockfile.lockSync(socketPath, {
			realpath: false,
			stale: DAEMON_SOCKET_LOCK_STALE_MS,
			update: DAEMON_SOCKET_LOCK_UPDATE_MS,
			retries: 0,
		});
	} catch {
		return;
	}
	try {
		cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
	} catch {
		// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
	} finally {
		try {
			releaseLock();
		} catch {
			// Best effort cleanup; a failed release is recoverable as a stale lock.
		}
	}
}

function cleanupUnixDaemonSocketPath(socketPath: string, expectedIdentity?: DaemonSocketIdentity): void {
	if (!existsSync(socketPath)) {
		return;
	}
	if (expectedIdentity) {
		const currentIdentity = getDaemonSocketIdentity(socketPath);
		if (
			!currentIdentity ||
			currentIdentity.dev !== expectedIdentity.dev ||
			currentIdentity.ino !== expectedIdentity.ino
		) {
			return;
		}
	}
	unlinkSync(socketPath);
}

function assertSocketLease(socketPath: string, lease: DaemonSocketPathLease): void {
	if (lease.socketPath !== socketPath) {
		throw new Error(`Daemon socket lease does not match ${socketPath}`);
	}
}

export function defaultDaemonSocketDir(): string {
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `prime-agent-${suffix}`);
}

function ensureDefaultDaemonSocketDir(socketPath: string): void {
	if (process.platform === "win32" || dirname(socketPath) !== defaultDaemonSocketDir()) {
		return;
	}

	if (!existsSync(defaultDaemonSocketDir())) {
		mkdirSync(defaultDaemonSocketDir(), { recursive: true, mode: DAEMON_SOCKET_DIR_MODE });
	}

	const stat = lstatSync(defaultDaemonSocketDir());
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory exists and is not a directory: ${defaultDaemonSocketDir()}`);
	}

	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${defaultDaemonSocketDir()}`);
	}

	chmodSync(defaultDaemonSocketDir(), DAEMON_SOCKET_DIR_MODE);
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
