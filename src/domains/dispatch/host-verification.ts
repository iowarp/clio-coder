import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { FLEET_COMMAND_BASE_ENV, type FleetCommand } from "../agents/fleet-commands.js";
import { runCodeStep } from "./code-step.js";
import type { DispatchRequest } from "./contract.js";
import type { RunHostVerification, RunHostVerificationCheck } from "./types.js";
import { captureWorkspaceSnapshot } from "./write-boundary.js";

const OUTPUT_TAIL_BYTES = 2_048;
const MEMO_VERSION = 1;

interface MemoEntry {
	key: string;
	runId: string;
	check: RunHostVerificationCheck;
}

interface MemoFile {
	version: 1;
	entries: MemoEntry[];
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function outputTail(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= OUTPUT_TAIL_BYTES) return value;
	let text = bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8");
	while (Buffer.byteLength(text, "utf8") > OUTPUT_TAIL_BYTES) text = text.slice(1);
	return text;
}

function repositoryRoot(cwd: string): string {
	return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

export function workspaceFingerprint(cwd: string): string | null {
	try {
		const snapshot = captureWorkspaceSnapshot(repositoryRoot(cwd));
		return sha256(
			JSON.stringify({
				head: snapshot.head,
				entries: [...snapshot.entries.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			}),
		);
	} catch {
		return null;
	}
}

function memoPath(stateDir: string): string {
	return join(stateDir, "dispatch-verification-memo.json");
}

function readMemo(stateDir: string): MemoFile {
	const target = memoPath(stateDir);
	if (!existsSync(target)) return { version: MEMO_VERSION, entries: [] };
	try {
		const parsed = JSON.parse(readFileSync(target, "utf8")) as MemoFile;
		if (parsed.version === MEMO_VERSION && Array.isArray(parsed.entries)) return parsed;
	} catch {
		// A damaged cache is a miss. Receipts remain the authoritative evidence.
	}
	return { version: MEMO_VERSION, entries: [] };
}

function writeMemo(stateDir: string, memo: MemoFile): void {
	const target = memoPath(stateDir);
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(memo, null, 2), "utf8");
	renameSync(temporary, target);
}

function storeMemoEntry(stateDir: string, entry: MemoEntry): void {
	const target = memoPath(stateDir);
	withStateFileLockSync(target, () => {
		const memo = readMemo(stateDir);
		memo.entries = [entry, ...memo.entries.filter((candidate) => candidate.key !== entry.key)].slice(0, 512);
		writeMemo(stateDir, memo);
	});
}

function memoKey(command: FleetCommand, fingerprint: string, env: NodeJS.ProcessEnv): string {
	const names = [...FLEET_COMMAND_BASE_ENV, ...command.env];
	const values = Object.fromEntries(names.map((name) => [name, env[name] ?? null]));
	return sha256(JSON.stringify({ fingerprint, argv: command.argv, cwd: command.cwd, env: values }));
}

export function hostVerificationRejection(
	verification: RunHostVerification | undefined,
): { outcomeCode: "host_verification_rejected"; detail: string } | null {
	if (verification?.status !== "rejected") return null;
	const failedCheck = verification.checks.find((check) => check.exitCode !== 0);
	return {
		outcomeCode: "host_verification_rejected",
		detail:
			failedCheck === undefined
				? "host verification rejected"
				: `host verification check '${failedCheck.check}' rejected with exit code ${failedCheck.exitCode}`,
	};
}

export async function runHostVerification(input: {
	runId: string;
	request: Pick<DispatchRequest, "resolvedVerification">;
	workerSuccessful: boolean;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	onDiagnostic?: (error: unknown) => void;
}): Promise<RunHostVerification | undefined> {
	const checks = input.request.resolvedVerification;
	if (checks === undefined || checks.length === 0) return undefined;
	if (!input.workerSuccessful) return { status: "skipped", reason: "worker_not_successful", checks: [] };
	const stateDir = input.stateDir ?? clioStateDir();
	const env = input.env ?? process.env;
	const results: RunHostVerificationCheck[] = [];
	for (const [index, resolvedCheck] of checks.entries()) {
		const command: FleetCommand = {
			id: resolvedCheck.check,
			argv: [...resolvedCheck.argv],
			cwd: "",
			timeoutMs: resolvedCheck.timeoutMs,
			env: [],
			description: `Host verification check ${resolvedCheck.check}.`,
		};
		const fingerprint = workspaceFingerprint(resolvedCheck.cwd);
		const key = fingerprint === null ? null : memoKey({ ...command, cwd: resolve(resolvedCheck.cwd) }, fingerprint, env);
		const hit =
			key === null
				? undefined
				: readMemo(stateDir).entries.find((entry) => entry.key === key && entry.check.exitCode === 0);
		if (hit !== undefined) {
			results.push({ ...hit.check, argv: [...hit.check.argv], memo: true, evidenceRunId: hit.runId });
			continue;
		}
		const outcome = await runCodeStep({
			stepId: `verification-${index + 1}-${resolvedCheck.check.replace(/[^a-z0-9._-]/giu, "_")}`,
			command,
			workspaceRoot: resolvedCheck.cwd,
			artifactDir: join(stateDir, "artifacts", input.runId, "verification"),
			env,
		});
		const artifactPath = outcome.record.artifactPaths[0];
		const check: RunHostVerificationCheck = {
			check: resolvedCheck.check,
			argv: [...outcome.record.argv],
			cwd: outcome.record.cwd,
			exitCode: outcome.record.exitCode,
			durationMs: outcome.record.durationMs,
			memo: false,
			outputTail: outputTail(outcome.report.outputExcerpt),
			...(artifactPath !== undefined ? { artifactPath } : {}),
		};
		results.push(check);
		if (check.exitCode === 0 && key !== null) {
			try {
				storeMemoEntry(stateDir, { key, runId: input.runId, check });
			} catch (error) {
				input.onDiagnostic?.(error);
			}
		}
	}
	return {
		status: results.every((check) => check.exitCode === 0) ? "verified" : "rejected",
		checks: results,
	};
}
