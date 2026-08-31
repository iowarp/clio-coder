import { ok, strictEqual } from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import { scaleWatchdog } from "../harness/load.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHILD = join(REPO_ROOT, "tests", "fixtures", "codewiki-coordinator-child.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

/**
 * A watchdog on a spawned coordinator child reaching its ready marker. Nothing
 * here asserts the child was quick, and an early exit is still reported at once
 * from the loop below, so the budget widens with the shard load the run carries
 * and stays the 10s it always was when the file runs alone.
 */
async function waitForFile(path: string, children: ChildProcess[], budgetMs = 10_000): Promise<void> {
	const deadline = Date.now() + scaleWatchdog(budgetMs);
	while (!existsSync(path)) {
		for (const child of children) {
			if (child.exitCode !== null) throw new Error(`coordinator child exited early with ${child.exitCode}`);
		}
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
		await sleep(20);
	}
}

function waitForClose(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stderr }));
	});
}

describe("contracts/codewiki cross-process coordination", { concurrency: false }, () => {
	const work = mkdtempSync(join(tmpdir(), "clio-codewiki-process-"));
	const live = new Set<ChildProcess>();
	after(() => {
		for (const child of live) child.kill("SIGKILL");
		rmSync(work, { recursive: true, force: true });
	});

	it("holds a second Clio process outside selection until the first generation commits", {
		timeout: 30_000,
	}, async () => {
		const cwd = join(work, "project");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "first.ts"), "export const firstProcess = true;\n", "utf8");
		const ready = join(work, "ready");
		const release = join(work, "release");
		const waiting = join(work, "waiting");
		const selected = join(work, "selected");
		const args = [cwd, ready, release, waiting, selected];
		const first = spawn(process.execPath, ["--import", TSX, CHILD, "pause", ...args], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "ignore", "pipe"],
		});
		live.add(first);
		const firstClose = waitForClose(first);
		await waitForFile(ready, [first]);

		writeFileSync(join(cwd, "src", "second.ts"), "export const secondProcess = true;\n", "utf8");
		const second = spawn(process.execPath, ["--import", TSX, CHILD, "follow", ...args], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "ignore", "pipe"],
		});
		live.add(second);
		const secondClose = waitForClose(second);
		await waitForFile(waiting, [first, second]);
		strictEqual(existsSync(selected), false, "the follower selector must remain behind the cross-process lease");

		writeFileSync(release, "release\n", "utf8");
		const [firstResult, secondResult] = await Promise.all([firstClose, secondClose]);
		live.delete(first);
		live.delete(second);
		strictEqual(firstResult.code, 0, firstResult.stderr);
		strictEqual(secondResult.code, 0, secondResult.stderr);
		ok(existsSync(selected), "the follower must enter selection after the first process releases ownership");
		const final = readCodewiki(cwd);
		ok(final?.symbols.some((symbol) => symbol.name === "firstProcess"));
		ok(final?.symbols.some((symbol) => symbol.name === "secondProcess"));
	});
});
