import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryDeliveryMode } from "../../src/core/defaults.js";
import { commandEvidenceRef, commandSegment, sourceEvidenceRef } from "../../src/domains/memory/command-evidence.js";
import { recordMemoryObservations } from "../../src/domains/memory/guardian-gate.js";
import { createMemoryInterventionRegistration } from "../../src/domains/memory/intervention.js";
import { MemoryDeliveryGate, projectKeptLesson } from "../../src/domains/memory/lesson-projection.js";
import { canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/operations.js";
import { claimCommand, memoryRevision } from "../../src/domains/memory/promotion.js";
import { createMemoryPromptReader } from "../../src/domains/memory/prompt-cache.js";
import { memorySectionDelta, renderMemoryPromptSection } from "../../src/domains/memory/prompt-section.js";
import { insertMemoryRecordIfAbsent, loadMemoryRecordsSync } from "../../src/domains/memory/store.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { runTaskMemoryPolicy, type TaskMemoryPolicyInput } from "../../src/domains/memory/task-memory-policy.js";
import type { MemoryClaimCommand, MemoryRecord } from "../../src/domains/memory/types.js";

/** These cases test later gates, so every fact predates the last context loss. */
const contextLostAt = "9999-01-01T00:00:00.000Z";

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
			purpose: "memory.bank",
			task: "Check handoff",
			trajectory: [],
			deterministicTrigger: false,
			maxTokens: 2000,
			workspaceRoot,
			contextLostAt,
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
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 0, "counted when the host submits it, not here");
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
			purpose: "memory.bank",
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
			contextLostAt,
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
			purpose: "memory.bank",
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
			contextLostAt,
		},
	);
	strictEqual(repeated.reason, "intervened");
	strictEqual(bank.snapshot().procedural[0]?.injectionCount, 0, "counted when the host submits it, not here");
});

for (const probe of [false, true]) {
	test(
		probe
			? "guessed missing-file reads do not earn a memory card even when repeated"
			: "one failing check does not earn a memory card",
		async () => {
			const bank = new TaskMemoryBank();
			const trajectory = Array.from({ length: probe ? 2 : 1 }, (_, index) => ({
				step: index + 1,
				toolName: probe ? "read" : "bash",
				operationFingerprint: probe ? "guess" : "test",
				callDescription: probe ? "read test/index.ts" : "npm test",
				outcome: "error" as const,
				resultDigest: probe ? "ENOENT: no such file" : "pre-existing test failure",
				resultDigestProvenance: observedProvenance,
			}));
			const result = await runTaskMemoryPolicy(
				bank,
				{
					complete: async () => ({
						text:
							'<operations>[{"op":"save_knowledge","content":"The latest attempt failed."}]</operations><context_for_action>[tm-k-1] Avoid repeating this failure.</context_for_action>',
					}),
				},
				{ purpose: "memory.correct", task: "Inspect the project", trajectory, deterministicTrigger: true, maxTokens: 2000 },
			);
			strictEqual(result.reason, "no_repeated_failure");
			strictEqual(result.reminder, null);
			strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 0);
		},
	);
}

test("card D delivery: a changed quote withholds its lessons, an operator approval survives, and each mode opens only its channels", async () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-delivery-")));
	const root = join(base, "repo");
	const dataDir = join(base, "data");
	const at = "2026-11-20T00:00:00.000Z";
	const quote = "The release marker is COBALT.";
	const check = "node scripts/check.mjs --mode native";
	try {
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "guide.txt"), `${quote}\n`);
		writeFileSync(join(root, "scripts", "check.mjs"), "process.exit(0);\n");
		const repository = canonicalMemoryRepositoryIdentity(root);
		ok(repository);
		/** A repository lesson an operator approved, or one the gate kept on two non-author demonstrations. */
		const lesson = (n: number, text: string, refs: string[], by: "operator" | "guardian"): MemoryRecord => {
			const record: MemoryRecord = {
				id: `mem-00000000000000a${n}`,
				scope: "repo",
				key: `lesson-${n}`,
				lesson: text,
				evidenceRefs: ["session:author", ...refs],
				appliesWhen: [],
				avoidWhen: [],
				confidence: 0.9,
				createdAt: at,
				approved: true,
				approval: { by, at },
				repository,
				provenance: {
					sourceKind: "task-bank-entry",
					sourceEntryKind: "knowledge",
					sourceSessionId: "author",
					sourceEntryId: `tm-k-${n}`,
					evidenceId: "session:author",
					redaction: { appliedBeforePersistence: true, replacementCount: 0, sourceFields: ["content"] },
				},
			};
			const revision = memoryRevision(record);
			if (by === "guardian")
				record.observations = ["h1", "h2"].map((sessionId) => ({ at, sessionId, kind: "held" as const, revision }));
			return record;
		};
		const operatorQuote = lesson(
			1,
			`The release marker lives in guide.txt: ${quote}`,
			[sourceEvidenceRef("guide.txt", quote)],
			"operator",
		);
		const marker = lesson(
			2,
			`Find the release marker with \`cat guide.txt\`: ${quote}`,
			[commandEvidenceRef("cat guide.txt"), sourceEvidenceRef("guide.txt", quote)],
			"guardian",
		);
		const unrelated = lesson(3, `Validate with \`${check}\`.`, [commandEvidenceRef(check)], "guardian");
		const unsettled = lesson(
			4,
			"Build with `node scripts/check.mjs --mode build`.",
			[commandEvidenceRef("node scripts/check.mjs --mode build")],
			"guardian",
		);
		for (const record of [operatorQuote, marker, unrelated, unsettled]) await insertMemoryRecordIfAbsent(dataDir, record);
		// Three earlier sessions were reminded of it and none gave a verdict.
		await recordMemoryObservations(
			dataDir,
			["d1", "d2", "d3"].map((sessionId) => ({ memoryId: unsettled.id, sessionId, kind: "delivered" as const })),
		);
		let session = "s1";
		let mode: MemoryDeliveryMode = "decision";
		const notices: string[] = [];
		const withheld: Array<Record<string, unknown>> = [];
		const gate = new MemoryDeliveryGate({
			dataDir: () => dataDir,
			sessionId: () => session,
			mode: () => mode,
			notice: (line) => notices.push(line),
			diagnostic: (line) => notices.push(line),
			event: (name, facts) => {
				if (name === "lesson-withheld") withheld.push(facts);
			},
		});
		const reader = createMemoryPromptReader({ getDataDir: () => dataDir, delivery: gate });
		const section = () =>
			reader({
				turnId: `turn-${session}`,
				sessionAuthority: session,
				cwd: root,
				targetId: "t",
				runtimeId: "r",
				modelId: "m",
				taskText: "",
				activePaths: [],
			});
		const first = section();
		for (const record of [operatorQuote, marker, unrelated]) ok(first.includes(`[${record.id}]`), record.id);
		strictEqual(first.includes(unsettled.id), false, "three sessions in a row without a verdict stop delivery");

		// The quote changes to AMBER: the next session withholds every lesson pinned to it.
		writeFileSync(join(root, "guide.txt"), "The release marker is AMBER.\n");
		session = "s2";
		const second = section();
		ok(second.includes(`[${unrelated.id}]`), "an unrelated valid lesson is still delivered");
		strictEqual(second.includes(marker.id), false);
		strictEqual(second.includes(operatorQuote.id), false);
		strictEqual(gate.admit(operatorQuote, root), false, "refused on every path for the rest of the session");
		await gate.whenSettled();
		const stored = new Map(loadMemoryRecordsSync(dataDir).map((record) => [record.id, record]));
		strictEqual(stored.get(marker.id)?.approved, false, "demoted");
		strictEqual(stored.get(marker.id)?.regressions?.length, 1);
		strictEqual(stored.get(unsettled.id)?.approved, false);
		deepStrictEqual(stored.get(operatorQuote.id), operatorQuote, "withholding never rewrites an operator approval");
		strictEqual(stored.get(unrelated.id)?.approved, true);
		deepStrictEqual(
			withheld.filter((facts) => facts.id === operatorQuote.id),
			[{ id: operatorQuote.id, reason: "delivery-check", by: "operator" }],
		);
		const named = notices.filter((line) => line.includes(operatorQuote.id));
		strictEqual(named.length, 1, "named once");
		match(named[0] ?? "", /approval stands.*clio-coder memory list/u);

		// `off` delivers no section; a peer's automatic approval waits for the next session.
		mode = "off";
		session = "s3";
		strictEqual(section(), "");
		const live = renderMemoryPromptSection([unrelated]);
		strictEqual(memorySectionDelta("", live, [], new Map([[unrelated.id, "automatic"]])), "");
		match(memorySectionDelta("", live, [], new Map([[unrelated.id, "eligible"]])), /^# Memory update/u);

		// Reminders: a fix claim reaches only its own failed pattern, a quote nobody reviewed reaches no channel,
		// and the first-change broadcast exists only under the documented opt-in.
		const pattern = (command: string): MemoryClaimCommand => {
			const segment = commandSegment(command, root);
			const claimed = segment === null ? null : claimCommand(segment);
			if (claimed === null) throw new Error(command);
			return claimed;
		};
		const fix = projectKeptLesson({
			...lesson(
				5,
				`\`node scripts/check.mjs\` fails without a mode; run \`${check}\`.`,
				[commandEvidenceRef(check)],
				"guardian",
			),
			claim: { kind: "fix", failed: pattern("node scripts/check.mjs"), fixed: pattern(check) },
		});
		const quoteOnly = projectKeptLesson(
			lesson(6, `guide.txt says: ${quote}`, [sourceEvidenceRef("guide.txt", quote)], "guardian"),
		);
		const outcomes = { delivered: [] as string[], held: [] as string[] };
		const intervention = (delivery: MemoryDeliveryMode, lessons = [fix, quoteOnly]) =>
			createMemoryInterventionRegistration({
				bank: new TaskMemoryBank(),
				workspaceRoot: () => root,
				getDelivery: () => delivery,
				getKeptLessons: () => lessons,
				onDurableLessonOutcomes: (outcome) => {
					outcomes.delivered.push(...outcome.delivered);
					outcomes.held.push(...outcome.held);
				},
			});
		const memory = intervention("decision");
		let call = 0;
		const after = (
			target: ReturnType<typeof intervention>,
			toolName: string,
			toolArgs: Record<string, unknown>,
			succeeded = true,
			details: Readonly<Record<string, unknown>> | undefined = undefined,
		) =>
			target.evaluate({
				hook: "after_tool",
				sessionId: "s4",
				toolName,
				toolCallId: String(++call),
				toolArgs,
				metadata: {
					resultKind: succeeded ? "ok" : "error",
					actionClass: toolName === "bash" ? "execute" : toolName === "edit" ? "write" : "read",
				},
				...(details === undefined ? {} : { toolResultDetails: details }),
			});
		const reminded = (effects: ReturnType<typeof after>) =>
			effects[0]?.kind === "annotate_tool_result" ? effects[0].message : "";
		try {
			memory.evaluate({ hook: "turn_start", sessionId: "s4", text: "Find the release marker." });
			strictEqual(
				reminded(after(memory, "read", { path: join(root, "guide.txt") })),
				"",
				"no _subject for an unreviewed quote",
			);
			const gap = reminded(
				after(memory, "verify", {}, true, { sources: [{ kind: "package.json", checks: [] }], derived: [] }),
			);
			match(gap, new RegExp(`\\[${fix.id}\\]`, "u"), "a verification gap brings the command lesson");
			strictEqual(gap.includes(quoteOnly.id), false, "no _verify for an unreviewed quote");
			strictEqual(
				reminded(after(memory, "edit", { path: join(root, "scripts", "new.mjs") })),
				"",
				"no broadcast by default",
			);
		} finally {
			memory.dispose();
		}
		const failing = intervention("decision");
		try {
			failing.evaluate({ hook: "turn_start", sessionId: "s5", text: "Run the check." });
			strictEqual(reminded(after(failing, "bash", { command: "node scripts/check.mjs --mode other" }, false)), "");
			const variant = reminded(after(failing, "bash", { command: "node scripts/check.mjs" }, false));
			match(variant, new RegExp(`\\[${fix.id}\\]`, "u"));
			strictEqual(variant.includes(quoteOnly.id), false, "no _variant for an unreviewed quote");
			failing.acknowledgeSubmission([`[middleware:info] ${variant}`]);
			after(failing, "bash", { command: check }, true, { outcome: "success", exitCode: 0 });
			deepStrictEqual(outcomes, { delivered: [fix.id], held: [fix.id] });
		} finally {
			failing.dispose();
		}
		const broadcast = intervention("broadcast", [projectKeptLesson(unrelated)]);
		try {
			broadcast.evaluate({ hook: "turn_start", sessionId: "s4", text: "Add a helper." });
			match(reminded(after(broadcast, "edit", { path: join(root, "scripts", "new.mjs") })), new RegExp(unrelated.id, "u"));
		} finally {
			broadcast.dispose();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
