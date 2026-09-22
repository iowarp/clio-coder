/**
 * Shared plumbing for tests that drive the built `clio-coder run` binary as an
 * external orchestrator would: a scratch home whose state directory collects
 * the run's receipt, a spawn helper that reports the exit code and the wall
 * time, and a reader that returns the one sealed receipt with its ledger row.
 */
import { ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../../src/domains/dispatch/types.js";
import { readRunJournal } from "./run-journal.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");

export interface HeadlessScratch {
	root: string;
	configDir: string;
	stateDir: string;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

/** A throwaway home initialized by `doctor --fix`, ready for a seeded target. */
export function headlessScratch(prefix: string): HeadlessScratch {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: join(root, "config"),
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
	};
	execFileSync(process.execPath, [CLI, "doctor", "--fix"], { cwd: root, env, stdio: "pipe" });
	return {
		root,
		configDir: join(root, "config"),
		stateDir: join(root, "state"),
		env,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

/** Spawn the built CLI with stdin closed; SIGKILL and reject after `timeoutMs`. */
export function runCli(
	args: ReadonlyArray<string>,
	options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number },
): Promise<CliResult> {
	const startedAt = Date.now();
	const child = spawn(process.execPath, [CLI, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.on("data", (text: string) => {
		stderr += text;
	});
	child.stdin.end();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timeout: ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`));
		}, options.timeoutMs ?? 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
		});
	});
}

/** The run's single receipt and ledger row, after checking the integrity seal binds them. */
export function sealedReceipt(stateDir: string): { receipt: RunReceipt; envelope: RunEnvelope } {
	const journal = readRunJournal(stateDir);
	ok(journal, `no run journal under ${stateDir}`);
	strictEqual(journal.receipts.length, 1, `expected one receipt, found ${journal.receipts.length}`);
	const receipt = journal.receipts[0];
	ok(receipt);
	const envelope = journal.envelopes.get(receipt.runId);
	ok(envelope, `no ledger row for ${receipt.runId}`);
	const integrity = verifyReceiptIntegrity(receipt, envelope);
	ok(integrity.ok, integrity.ok ? "" : integrity.reason);
	return { receipt, envelope };
}
