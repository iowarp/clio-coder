import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../core/process-identity.js";
import { withStateFileLock } from "../core/state-file-lock.js";
import { resolveClioDirs } from "../core/xdg.js";

/** A listener's credentials do not prove which process holds an independently recorded PID. */
export function legacyDocsBirthVerified(pid: number, birth: unknown, sourceAvailable = BIRTH_TOKEN_SOURCE_AVAILABLE) {
	return sourceAvailable && typeof birth === "string" && processBirthToken(pid) === birth;
}

/** Migration-only cleanup. No documentation listener can be launched by this build. */
export async function stopLegacyDocsBeforeRemoval(): Promise<void> {
	const path = join(resolveClioDirs().state, "gui", "docs-server.json");
	if (!existsSync(path)) return;
	await withStateFileLock(path, async () => {
		let record: { v?: unknown; pid?: unknown; birth?: unknown };
		try {
			record = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Error("The legacy documentation process record cannot be checked. Clio state was preserved.");
		}
		if (record.v !== 1 || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0)
			throw new Error("The legacy documentation process record is invalid. Clio state was preserved.");
		const pid = record.pid;
		if (!processAlive(pid)) {
			rmSync(path, { force: true });
			return;
		}
		if (!legacyDocsBirthVerified(pid, record.birth))
			throw new Error(
				"The legacy documentation process ownership cannot be verified. Clio state was preserved; close it and retry.",
			);
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		const deadline = Date.now() + 5000;
		while (processAlive(pid) && Date.now() < deadline) await sleep(50);
		if (processAlive(pid))
			throw new Error("The legacy documentation process did not stop. Clio state was preserved; close it and retry.");
		rmSync(path, { force: true });
	});
}
