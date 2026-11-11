import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { noteRestartChain } from "./restart-request.js";
import { safeResourceWrite } from "./safe-resource-write.js";

export interface RestartIntent {
	sessionId: string;
	cwd: string;
	createdAt: string;
	pid: number;
}

export function restartIntentPath(stateDir: string): string {
	return join(stateDir, "restart-intent.json");
}

export function writeRestartIntent(stateDir: string, sessionId: string): void {
	const intent: RestartIntent = { sessionId, cwd: process.cwd(), createdAt: new Date().toISOString(), pid: process.pid };
	safeResourceWrite(restartIntentPath(stateDir), `${JSON.stringify(intent)}\n`, { mode: 0o600 });
}

/** Set by an exec restart: the new image keeps the writer's pid instead of being its child. */
export const RESTART_EXEC_ENV = "CLIO_CODER_RESTART_EXEC_PID";

/** The pid that wrote this boot's restart intent: this pid after an exec handoff, else the parent. */
export function restartWriterPid(env: NodeJS.ProcessEnv = process.env, pid = process.pid, ppid = process.ppid): number {
	return env[RESTART_EXEC_ENV] === String(pid) ? pid : ppid;
}

/** Called only after interactive boot has loaded the session domain, never by Stage 0. */
export function consumeRestartIntent(
	stateDir: string,
	cwd: string,
	now = Date.now(),
	expectedParentPid = restartWriterPid(),
): string | undefined {
	const file = restartIntentPath(stateDir);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let intent: Partial<RestartIntent> | null = null;
	try {
		intent = JSON.parse(raw);
	} catch {
		// A malformed file is consumed, too: it must not keep affecting later boots.
	}
	const valid =
		intent !== null &&
		typeof intent === "object" &&
		!Array.isArray(intent) &&
		typeof intent.sessionId === "string" &&
		/^[a-zA-Z0-9_-]{1,128}$/u.test(intent.sessionId) &&
		typeof intent.cwd === "string" &&
		typeof intent.createdAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(intent.createdAt) &&
		Number.isSafeInteger(intent.pid) &&
		(intent.pid ?? 0) > 0 &&
		Number.isFinite(Date.parse(intent.createdAt));
	if (valid && intent?.cwd !== cwd) return undefined;
	// Only the writer's direct child may consume the handoff; other boots must leave it intact (#420).
	if (valid && intent?.pid !== expectedParentPid) return undefined;
	// Delete before returning the id, so even a failed resume cannot loop.
	rmSync(file, { force: true });
	if (!valid || !intent?.createdAt) return undefined;
	const age = now - Date.parse(intent.createdAt);
	return age >= 0 && age < 60_000 ? intent.sessionId : undefined;
}

/**
 * The first message a restarted session submits. It names /restart and says the
 * text was carried over, so the resumed model does not read a bare
 * "Restarted on build X." prefix as injected text.
 */
export function restartContinuationMessage(text: string, buildId: string | null): string {
	const build = buildId ? `build ${buildId}` : "the source tree";
	return `This session resumed on ${build} after /restart, which carried this task over from before the restart: ${text}`;
}

/** Longest task text `/restart <text>` carries into the restarted session. */
export const RESTART_CONTINUATION_MAX = 2000;

function restartContinuationPath(stateDir: string): string {
	return join(stateDir, "restart-continuation.json");
}

/** Stores the text the restarted session submits as its first turn. */
export function writeRestartContinuation(stateDir: string, sessionId: string, text: string, chain = 0): void {
	const record = {
		sessionId,
		text: text.slice(0, RESTART_CONTINUATION_MAX),
		createdAt: new Date().toISOString(),
		...(chain > 0 ? { chain } : {}),
	};
	safeResourceWrite(restartContinuationPath(stateDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Returns and deletes the continuation for `sessionId` when it is under a minute old. */
export function consumeRestartContinuation(stateDir: string, sessionId: string, now = Date.now()): string | undefined {
	const file = restartContinuationPath(stateDir);
	let record: { sessionId?: unknown; text?: unknown; createdAt?: unknown; chain?: unknown } | null = null;
	try {
		record = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Absent or malformed: nothing to continue.
	}
	rmSync(file, { force: true });
	if (!record || record.sessionId !== sessionId || typeof record.text !== "string") return undefined;
	const age = now - (typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN);
	if (!(age >= 0 && age < 60_000)) return undefined;
	noteRestartChain(typeof record.chain === "number" ? record.chain : 0);
	const text = record.text.trim().slice(0, RESTART_CONTINUATION_MAX);
	return text.length > 0 ? text : undefined;
}
