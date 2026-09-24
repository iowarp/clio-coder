import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { runTaskMemoryPolicy, type TaskMemoryPolicyInput } from "../../src/domains/memory/task-memory-policy.js";

const observedProvenance = {
	producer: "code",
	source: "canonical-result-disposition",
	algorithm: "redacted-context-digest-v1",
} as const;

test("memory delivery validates workspace file references after applying bank operations", async () => {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "memory-freshness-"));
	try {
		mkdirSync(join(workspaceRoot, ".clio-coder", "handoffs"), { recursive: true });
		writeFileSync(join(workspaceRoot, ".clio-coder", "handoffs", "current.md"), "");
		const bank = new TaskMemoryBank();
		const input: TaskMemoryPolicyInput = {
			task: "Check handoff",
			trajectory: [],
			deterministicTrigger: false,
			maxTokens: 2000,
			workspaceRoot,
		};
		const complete = (path: string) => ({
			complete: async () => ({
				text: `<operations>[{"op":"save_knowledge","content":"A handoff was discussed."}]</operations><context_for_action>[tm-k-1] Read \`${path}\` before continuing.</context_for_action>`,
			}),
		});
		const missing = await runTaskMemoryPolicy(bank, complete(".clio-coder/handoffs/missing.md"), input);
		strictEqual(missing.reason, "invalid_path");
		strictEqual(missing.reminder, null);
		strictEqual(bank.snapshot().knowledge.length, 1);
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 0);
		const present = await runTaskMemoryPolicy(bank, complete(".clio-coder/handoffs/current.md"), input);
		strictEqual(present.reason, "intervened");
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 1);
		const source = await runTaskMemoryPolicy(bank, complete("src/features.py"), input);
		strictEqual(source.reason, "invalid_path");
	} finally {
		rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test("a cited failed attempt stays silent after the same operation succeeds", async () => {
	const bank = new TaskMemoryBank();
	bank.saveProcedural("npm run build failed twice with TS2345.");
	const entry = bank.snapshot().procedural[0];
	const result = await runTaskMemoryPolicy(
		bank,
		{
			complete: async () => ({
				text: `<operations>[]</operations><context_for_action>[${entry?.id}] The build failed twice.</context_for_action>`,
			}),
		},
		{
			task: "Build",
			trajectory: [
				{
					step: 1,
					toolName: "bash",
					operationFingerprint: "build",
					callDescription: "npm run build",
					outcome: "ok",
					resultDigest: "passed",
					resultDigestProvenance: observedProvenance,
				},
			],
			deterministicTrigger: false,
			maxTokens: 2000,
		},
	);
	strictEqual(result.reason, "resolved_failure");
	strictEqual(result.reminder, null);
	strictEqual(bank.snapshot().procedural[0]?.injectionCount, 0);
	const repeated = await runTaskMemoryPolicy(
		bank,
		{
			complete: async () => ({
				text: `<operations>[]</operations><context_for_action>[${entry?.id}] This build failure is recurring.</context_for_action>`,
			}),
		},
		{
			task: "Build",
			trajectory: [
				{
					step: 1,
					toolName: "bash",
					operationFingerprint: "build",
					callDescription: "npm run build",
					outcome: "ok",
					resultDigest: "passed",
					resultDigestProvenance: observedProvenance,
				},
				{
					step: 2,
					toolName: "bash",
					operationFingerprint: "build",
					callDescription: "npm run build",
					outcome: "error",
					resultDigest: "failed",
					resultDigestProvenance: observedProvenance,
				},
			],
			deterministicTrigger: false,
			maxTokens: 2000,
		},
	);
	strictEqual(repeated.reason, "intervened");
	strictEqual(bank.snapshot().procedural[0]?.injectionCount, 1);
});
