import { closeSync, readFileSync, rmSync } from "node:fs";
import type {
	AgentSessionMessageAgentSummary,
	AgentSessionMessageDeliveryMode,
	AgentSessionMessageSender,
} from "../../core/agent-messages.js";
import type { IdleEvictionMinutes } from "../../core/session-action-store.js";

export { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../core/session-lease.js";

import type { DaemonClientCapability, DaemonCommand, DaemonOutbound } from "./daemon-protocol.js";

export const DAEMON_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
export const DAEMON_WORKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
export const DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
export const DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
export const DAEMON_WORKER_STARTUP_GATE_FD_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD";
/**
 * Windows cannot inherit a pipe above fd 2, so the gate there is a file the
 * supervisor writes and the worker polls. Same contract, different transport.
 */
export const DAEMON_WORKER_STARTUP_GATE_PATH_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_PATH";
export const DAEMON_WORKER_STARTUP_GATE_COMMIT = "start\n";
export const DAEMON_WORKER_STARTUP_GATE_CANCEL = "cancel\n";
/** How long a worker waits for its supervisor to commit or cancel the gate. */
const STARTUP_GATE_PATH_TIMEOUT_MS = 120_000;
const STARTUP_GATE_PATH_POLL_MS = 20;
export type DaemonWorkerLifecycle = "starting" | "ready" | "recovering" | "failed";

export type DaemonWorkerFrameHeader =
	| {
			kind: "command";
			requestId: string;
			commandType: string;
	  }
	| {
			kind: "outbound";
			requestId?: string;
			outboundType: DaemonOutbound["type"];
			activeSessionId?: string;
			snapshotId?: string;
			sessionEventType?: string;
			payloadEncoding?: "jsonl" | "assistant-delta";
			snapshotPurpose?: "attach" | "replacement" | "catchup";
	  };

export type DaemonCreateCommand = Extract<DaemonCommand, { type: "create" }>;

export type DaemonWorkerCommand =
	| {
			id?: string;
			type: "worker_auth";
			token: string;
			supervisorGeneration: string;
			supervisorPid: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath: string;
	  }
	| {
			id?: string;
			type: "worker_subscribe";
			activeSessionId: string;
			capabilities?: readonly DaemonClientCapability[];
			supportsExtensionUi?: boolean;
	  }
	| { id?: string; type: "worker_unsubscribe"; activeSessionId: string }
	| { id?: string; type: "worker_sync_agent_peers"; peers: AgentSessionMessageAgentSummary[] }
	| { id?: string; type: "worker_archive_and_shutdown" }
	| {
			id?: string;
			type: "worker_passivate_idle_children";
			idleEvictionMinutes: IdleEvictionMinutes;
			now: number;
			limit: number;
	  }
	| {
			id?: string;
			type: "worker_deliver_message";
			targetActiveSessionId: string;
			message: string;
			sender: AgentSessionMessageSender;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "worker_prepare_update" }
	| { id?: string; type: "worker_commit_update" }
	| { id?: string; type: "worker_cancel_update" };

export type DaemonWorkerCommandBody = DaemonWorkerCommand extends infer TCommand
	? TCommand extends { id?: string }
		? Omit<TCommand, "id">
		: never
	: never;

export interface DaemonWorkerDescriptor {
	version: 1;
	workerId: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath?: string;
	supervisorSocketPath: string;
	authenticationToken: string;
	rootActiveSessionId: string;
	/** Stable protocol client that owns this worker. Omitted for resident sessions. */
	ownerClientId?: string;
	rootSessionId?: string;
	sessionFile?: string;
	createdAt: string;
	updatedAt: string;
	lifecycle: DaemonWorkerLifecycle;
	createCommand: DaemonCreateCommand;
	consecutiveFailures: number;
	/** Durable intent written before root termination so replacement supervisors never recover it. */
	stopRequestedAt?: string;
	/** Complete the root's archived lifecycle state after its process has stopped. */
	archiveOnStop?: boolean;
	lastFailureAt?: string;
	lastError?: string;
}

export function isDaemonWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_WORKER_ROLE_ENV] === "1";
}

/**
 * Block until the supervisor commits this worker's startup, or throw if it
 * cancels or never answers.
 *
 * The file transport polls synchronously: startup has not reached the event
 * loop yet, so there is nothing to await on. The parent's liveness bounds the
 * wait, since a supervisor that died mid-launch will never write either marker.
 */
function waitForDaemonWorkerStartupGatePath(gatePath: string): void {
	const deadline = Date.now() + STARTUP_GATE_PATH_TIMEOUT_MS;
	const supervisorPid = process.ppid;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		let marker: string | undefined;
		try {
			marker = readFileSync(gatePath, "utf8");
		} catch {
			// Not written yet.
		}
		if (marker !== undefined && marker.length > 0) {
			// The worker owns the marker once it has read it; the supervisor must not
			// race it away, so cleanup happens here for both outcomes.
			try {
				rmSync(gatePath, { force: true });
			} catch {
				// A leftover gate file is harmless; the name is unique per worker.
			}
			if (marker === DAEMON_WORKER_STARTUP_GATE_COMMIT) {
				return;
			}
			throw new Error("Daemon session worker startup was cancelled");
		}
		if (supervisorPid > 0 && !isProcessAlive(supervisorPid)) {
			throw new Error("Daemon session worker startup was cancelled");
		}
		Atomics.wait(sleeper, 0, 0, STARTUP_GATE_PATH_POLL_MS);
	}
	throw new Error("Timed out waiting for the daemon session worker startup gate");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but is not signalable by us.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function waitForDaemonWorkerStartupGate(environment: NodeJS.ProcessEnv = process.env): void {
	const gatePath = environment[DAEMON_WORKER_STARTUP_GATE_PATH_ENV];
	if (gatePath !== undefined) {
		delete environment[DAEMON_WORKER_STARTUP_GATE_PATH_ENV];
		waitForDaemonWorkerStartupGatePath(gatePath);
		return;
	}
	const rawFd = environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	if (rawFd === undefined) {
		return;
	}
	delete environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	const fd = Number(rawFd);
	if (!Number.isInteger(fd) || fd < 3) {
		throw new Error("Daemon session worker has an invalid startup gate");
	}
	let marker: string;
	try {
		marker = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	if (marker !== DAEMON_WORKER_STARTUP_GATE_COMMIT) {
		throw new Error("Daemon session worker startup was cancelled");
	}
}

export function requireDaemonWorkerAuthenticationToken(environment: NodeJS.ProcessEnv = process.env): string {
	const token = environment[DAEMON_WORKER_TOKEN_ENV];
	if (!token) {
		throw new Error("Daemon session worker is missing its authentication token");
	}
	return token;
}

export function isDaemonWorkerFrameHeader(value: unknown): value is DaemonWorkerFrameHeader {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "command") {
		return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
	}
	return (
		candidate.kind === "outbound" &&
		typeof candidate.outboundType === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string") &&
		(candidate.activeSessionId === undefined || typeof candidate.activeSessionId === "string") &&
		(candidate.snapshotId === undefined || typeof candidate.snapshotId === "string") &&
		(candidate.sessionEventType === undefined || typeof candidate.sessionEventType === "string") &&
		(candidate.snapshotPurpose === undefined ||
			candidate.snapshotPurpose === "attach" ||
			candidate.snapshotPurpose === "replacement" ||
			candidate.snapshotPurpose === "catchup") &&
		(candidate.payloadEncoding === undefined ||
			candidate.payloadEncoding === "jsonl" ||
			candidate.payloadEncoding === "assistant-delta")
	);
}
