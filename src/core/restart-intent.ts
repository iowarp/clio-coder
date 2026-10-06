import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

/** Called only after interactive boot has loaded the session domain, never by Stage 0. */
export function consumeRestartIntent(stateDir: string, cwd: string, now = Date.now()): string | undefined {
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
	// Delete before returning the id, so even a failed resume cannot loop.
	rmSync(file, { force: true });
	if (!valid || !intent?.createdAt) return undefined;
	const age = now - Date.parse(intent.createdAt);
	return age >= 0 && age < 60_000 ? intent.sessionId : undefined;
}
