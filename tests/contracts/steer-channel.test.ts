import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { setupSteerChannel } from "../../src/cli/steer-channel.js";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await delay(20);
	}
	throw new Error(message);
}

function fdTargetsUnder(root: string): string[] {
	if (!existsSync("/proc/self/fd")) return [];
	const targets: string[] = [];
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			const target = readlinkSync(join("/proc/self/fd", fd));
			if (target.startsWith(root)) targets.push(target);
		} catch {
			// Ignore fds that close while the directory is being inspected.
		}
	}
	return targets.sort();
}

describe("contracts/steer-channel regular files", () => {
	it("delivers complete trimmed lines, buffers split appends, drops blanks, and stops after cleanup", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-steer-channel-"));
		const path = join(root, "steer.txt");
		writeFileSync(path, "clean\n\n  \n", "utf8");
		const delivered: string[] = [];
		let cleanup: (() => void) | undefined;
		try {
			cleanup = setupSteerChannel(path, (line) => delivered.push(line));
			deepStrictEqual(delivered, ["clean"]);

			appendFileSync(path, "fix", "utf8");
			await delay(150);
			deepStrictEqual(delivered, ["clean"]);

			appendFileSync(path, " it\n\n  \n", "utf8");
			await waitFor(() => delivered.includes("fix it"), "split steer line was not delivered");
			deepStrictEqual(delivered, ["clean", "fix it"]);

			cleanup();
			cleanup = undefined;
			appendFileSync(path, "after cleanup\n", "utf8");
			await delay(150);
			deepStrictEqual(delivered, ["clean", "fix it"]);
		} finally {
			if (cleanup) cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("closes the fd when a regular-file read fails", async () => {
		if (!existsSync("/proc/self/fd")) return;
		const root = mkdtempSync(join(tmpdir(), "clio-steer-channel-fd-"));
		const path = join(root, "directory-target");
		let cleanup: (() => void) | undefined;
		try {
			mkdirSync(path);

			const before = fdTargetsUnder(path);
			cleanup = setupSteerChannel(path, () => {});
			cleanup();
			cleanup = undefined;
			await delay(50);
			const after = fdTargetsUnder(path);
			strictEqual(after.length, before.length);
		} finally {
			if (cleanup) cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
