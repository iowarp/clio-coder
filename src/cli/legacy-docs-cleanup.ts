import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../core/process-identity.js";
import { withStateFileLock } from "../core/state-file-lock.js";
import { resolveClioDirs } from "../core/xdg.js";

/** Migration-only cleanup. No documentation listener can be launched by this build. */
export async function stopLegacyDocsBeforeRemoval(): Promise<void> {
	const path = join(resolveClioDirs().state, "gui", "docs-server.json");
	if (!existsSync(path)) return;
	await withStateFileLock(path, async () => {
		let record: { v?: unknown; pid?: unknown; birth?: unknown; port?: unknown; token?: unknown };
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
		let owned =
			BIRTH_TOKEN_SOURCE_AVAILABLE && typeof record.birth === "string" && processBirthToken(pid) === record.birth;
		// On platforms without process birth times only an authenticated listener proves ownership.
		if (
			!BIRTH_TOKEN_SOURCE_AVAILABLE &&
			typeof record.port === "number" &&
			Number.isInteger(record.port) &&
			record.port >= 1 &&
			record.port <= 65535 &&
			typeof record.token === "string" &&
			/^[\w-]{32,256}$/u.test(record.token)
		) {
			try {
				const response = await fetch(`http://127.0.0.1:${record.port}/api/meta`, {
					headers: { Authorization: `Bearer ${record.token}` },
					redirect: "error",
					signal: AbortSignal.timeout(1500),
				});
				owned = response.status === 200 && ((await response.json()) as { apiVersion?: number }).apiVersion === 1;
			} catch {
				/* A silent or unrelated listener is never signalled. */
			}
		}
		if (!owned)
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
