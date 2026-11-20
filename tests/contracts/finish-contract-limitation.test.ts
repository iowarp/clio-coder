import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { FINISH_CONTRACT_EVIDENCE_TAGS } from "../../src/domains/evidence/finish-contract-map.js";
import { composeTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { classifyCall, settleCheckCall } from "../../src/domains/safety/check-classifier.js";
import type { CompletionEvaluationInput } from "../../src/domains/safety/decision-events.js";
import {
	assessFinishContract,
	declaredVerifierCommands,
	FINISH_CONTRACT_ADVISORY_MESSAGE,
	FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE,
	FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE,
} from "../../src/domains/safety/finish-contract.js";
import { createFinishContractRegistration } from "../../src/domains/safety/finish-contract-registration.js";
import { runCheckFacts } from "../../src/domains/safety/observed-checks.js";
import { checkOutputReader, createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { builtin } from "../../src/tools/builtin-tool-catalog.js";
import {
	bareFinishVerdict,
	completionOfToolResult,
	finishRoundDue,
	finishSiblingRefusal,
	finishTool,
	sealCompletion,
	withoutReplyLimitation,
} from "../../src/tools/finish.js";
import { limitationTool } from "../../src/tools/limitation.js";
import { validateBuiltinToolPolicy } from "../../src/tools/policy.js";
import { verifyTool } from "../../src/tools/verify/index.js";

const SOURCE = { source: "builtin" } as never;

function userMessage(turnId: string): unknown {
	return { kind: "message", role: "user", turnId, payload: { text: "change the file" } };
}

function assistantMessage(turnId: string, text: string): unknown {
	return { kind: "message", role: "assistant", turnId, payload: { text, stopReason: "stop" } };
}

function toolCall(toolCallId: string, name: string, args: Record<string, unknown>): unknown {
	return { kind: "message", role: "tool_call", turnId: toolCallId, payload: { name, toolCallId, args } };
}

function toolResult(toolCallId: string, toolName: string, isError: boolean): unknown {
	return {
		kind: "message",
		role: "tool_result",
		turnId: toolCallId,
		payload: { toolName, toolCallId, isError, result: isError ? { kind: "error" } : { kind: "ok" } },
	};
}

/** The high-rigor gate's turn_end effects for a session window and a final reply. */
function highRigorGate(entries: unknown[], text: string) {
	return createFinishContractRegistration({ readSessionEntries: () => entries, resolveRigor: () => "high" }).evaluate({
		hook: "turn_end",
		text,
	});
}

/** Whether the gate withheld the completion and re-prompted the model. */
function reprompted(effects: ReadonlyArray<{ kind: string }>): boolean {
	return effects.some((effect) => effect.kind === "request_continuation");
}

/** The mutation window followed by one bash check call and its result. */
function checkedWindow(command: string, isError = false): unknown[] {
	return [
		...mutationWindow(),
		toolCall("bash-1", ToolNames.Bash, { command }),
		toolResult("bash-1", ToolNames.Bash, isError),
	];
}

/** A window that mutated one file and recorded no validation evidence. */
function mutationWindow(): unknown[] {
	return [
		userMessage("user-1"),
		toolCall("write-1", ToolNames.Write, { path: "src/thing.ts", content: "x" }),
		toolResult("write-1", ToolNames.Write, false),
	];
}

describe("finish contract: the limitation receipt replaces the prose regex", () => {
	it("does not demand code checks for Clio settings and fleet definitions", () => {
		for (const path of [
			".clio-coder/settings.yaml",
			".clio-coder/settings.local.yaml",
			".clio-coder/playbooks/review-sol.md",
		]) {
			const entries = [
				userMessage("user-1"),
				toolCall("write-1", ToolNames.Write, { path, content: "x" }),
				toolResult("write-1", ToolNames.Write, false),
			];
			strictEqual(assessFinishContract({ sessionEntries: entries }).kind, "ok");
			strictEqual(assessFinishContract({ sessionEntries: [...entries, ...mutationWindow().slice(1)] }).kind, "engage");
		}
		for (const path of [".clio-coder/scripts/check.ts", ".clio-coder/playbooks/../../src/thing.ts"]) {
			strictEqual(
				assessFinishContract({
					sessionEntries: [
						userMessage("user-1"),
						toolCall("write-1", ToolNames.Write, { path, content: "x" }),
						toolResult("write-1", ToolNames.Write, false),
					],
				}).kind,
				"engage",
			);
		}
	});

	it("settles ok/explicit_limitation on a mutation plus a successful limitation receipt", () => {
		const entries = [
			...mutationWindow(),
			toolCall("lim-1", ToolNames.Limitation, {
				scope: "tests could not run",
				reason: "no-runner",
				paths: ["src/thing.ts"],
			}),
			toolResult("lim-1", ToolNames.Limitation, false),
			assistantMessage("assistant-1", "Edited src/thing.ts."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "explicit_limitation");
		deepStrictEqual(assessment.mutatedPaths, ["src/thing.ts"]);
		strictEqual(assessment.evidence.length, 1);
		const [evidence] = assessment.evidence;
		strictEqual(evidence?.kind, "limitation");
		strictEqual(evidence?.turnId, "lim-1");
		ok(evidence?.summary.includes("tests could not run"), evidence?.summary);
		ok(evidence?.summary.includes("reason=no-runner"), evidence?.summary);
	});

	it("still engages when the limitation call errored, so a rejected call leaves no receipt", () => {
		const entries = [
			...mutationWindow(),
			toolCall("lim-1", ToolNames.Limitation, { scope: "tests could not run", reason: "nope" }),
			toolResult("lim-1", ToolNames.Limitation, true),
			assistantMessage("assistant-1", "Edited src/thing.ts; tests not verified."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "engage");
		strictEqual(assessment.reason, "unvalidated_mutation");
		deepStrictEqual(assessment.evidence, []);
	});

	it("settles ok/no_checks_declared when verify finds no check in the workspace, without a limitation", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "clio-no-checks-"));
		const cwd = process.cwd();
		t.after(() => {
			process.chdir(cwd);
			rmSync(root, { recursive: true, force: true });
		});
		process.chdir(root);
		for (const args of [{}, { check: "test" }]) {
			// The list is an answer; a named check that resolved to nothing stays an error, so it credits no pass.
			const result = await verifyTool.run(args);
			strictEqual(result.kind, "check" in args ? "error" : "ok", JSON.stringify(result));
			strictEqual(result.details?.noChecksDeclared, true);
			match(result.kind === "ok" ? result.output : result.message, /fact about this workspace, not a limitation/u);
			const entries = [
				...mutationWindow(),
				toolCall("verify-1", ToolNames.Verify, args),
				{
					kind: "message",
					role: "tool_result",
					turnId: "verify-1",
					payload: { toolName: ToolNames.Verify, toolCallId: "verify-1", isError: result.kind === "error", result },
				},
				assistantMessage("assistant-1", "Saved the summary table."),
			];
			const assessment = assessFinishContract({
				sessionEntries: entries,
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
				rigor: "high",
			});
			strictEqual(assessment.kind, "ok", JSON.stringify(args));
			strictEqual(assessment.reason, "no_checks_declared");
			strictEqual(assessment.advisory, undefined);
		}
	});

	it("engages on prose such as 'not verified' when no limitation receipt exists", () => {
		const entries = [
			...mutationWindow(),
			assistantMessage(
				"assistant-1",
				"Edited src/thing.ts. Tests: not run. This change is not verified and could not be tested.",
			),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "engage");
		strictEqual(assessment.reason, "unvalidated_mutation");
	});

	it("ignores a limitation receipt that landed before the last user message", () => {
		const entries = [
			toolCall("lim-0", ToolNames.Limitation, { scope: "earlier turn", reason: "blocked" }),
			toolResult("lim-0", ToolNames.Limitation, false),
			...mutationWindow(),
			assistantMessage("assistant-1", "Edited src/thing.ts."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "engage");
	});

	it("retains package identity behind a literal workspace cd prefix", () => {
		const root = process.cwd();
		for (const command of [`cd '${root}' && npm test`, `cd . && npm test`]) {
			const assessment = assessFinishContract({
				sessionEntries: [
					...mutationWindow(),
					toolCall("bash-1", ToolNames.Bash, { command }),
					toolResult("bash-1", ToolNames.Bash, false),
					assistantMessage("assistant-1", "Done."),
				],
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
				rigor: "high",
				activeAcceptance: { expectedOutputs: [], verification: [{ check: "test", timeoutMs: 1000 }] },
			});
			strictEqual(assessment.kind, "ok");
			strictEqual(assessment.reason, "validation_evidence");
			strictEqual(assessment.evidence[0]?.cwd, root);
		}
		for (const command of ["cd .. && npm test", "cd . || npm test", "cd '$DEST' && npm test"]) {
			const assessment = assessFinishContract({
				sessionEntries: [
					...mutationWindow(),
					toolCall("bash-1", ToolNames.Bash, { command }),
					toolResult("bash-1", ToolNames.Bash, false),
					assistantMessage("assistant-1", "Done."),
				],
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
			});
			strictEqual(assessment.kind, "engage");
		}
	});

	it("keeps validation evidence ahead of a limitation receipt in the decision order", () => {
		const entries = [
			...mutationWindow(),
			toolCall("bash-1", ToolNames.Bash, { command: "npm test" }),
			toolResult("bash-1", ToolNames.Bash, false),
			toolCall("lim-1", ToolNames.Limitation, { scope: "lint skipped", reason: "out-of-scope" }),
			toolResult("lim-1", ToolNames.Limitation, false),
			assistantMessage("assistant-1", "Done."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "validation_evidence");
		deepStrictEqual(
			assessment.evidence.map((item) => item.kind),
			["validation_command", "limitation"],
		);
		strictEqual(
			assessment.verificationScope?.limitations[0]?.summary,
			"limitation recorded: lint skipped (reason=out-of-scope)",
		);
	});

	it("reports unknown behavior coverage for unrelated or partial passing checks, irrespective of final prose", (t) => {
		for (const command of ["npm run lint", "node --test unrelated.test.mjs", "node --test thing.test.mjs"]) {
			const assessment = assessFinishContract({
				sessionEntries: [
					...mutationWindow(),
					toolCall("bash-1", ToolNames.Bash, { command }),
					toolResult("bash-1", ToolNames.Bash, false),
					assistantMessage("assistant-1", "All changed behavior in src/thing.ts is covered by imports and tests. Done."),
				],
				assistantTurnId: "assistant-1",
			});
			strictEqual(assessment.kind, "ok");
			strictEqual(assessment.reason, "validation_evidence");
			strictEqual(assessment.verificationScope?.behaviorCoverage, "unknown");
			strictEqual(assessment.verificationScope?.passedChecks.length, 1);
			ok(assessment.kind === "ok");
			strictEqual(assessment.advisory, FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE);
		}
		// A red the receipt seals after the last change never reads as "checks passed"; a later pass replaces it (bt-44).
		const root = mkdtempSync(join(tmpdir(), "finish-red-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const tsc = (id: string, exitCode: number) => [
			toolCall(id, ToolNames.Bash, { command: "npx tsc --noEmit" }),
			{
				kind: "message",
				role: "tool_result",
				turnId: id,
				payload: { toolName: ToolNames.Bash, toolCallId: id, isError: exitCode !== 0, result: { details: { exitCode } } },
			},
		];
		const advisory = (...checks: unknown[][]) => {
			const assessment = assessFinishContract({
				sessionEntries: [
					...mutationWindow(),
					toolCall("bash-1", ToolNames.Bash, { command: "npm run lint" }),
					toolResult("bash-1", ToolNames.Bash, false),
					...checks.flat(),
					assistantMessage("assistant-1", "Done."),
				],
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
			});
			return assessment.kind === "ok" ? assessment.advisory : undefined;
		};
		strictEqual(advisory(tsc("tsc-1", 2)), FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE);
		strictEqual(advisory(tsc("tsc-1", 2), tsc("tsc-2", 0)), FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE);
	});

	it("retains explicitly requested check scope and limitations without turning unknown coverage into a gate", async () => {
		const entries = [
			...mutationWindow(),
			toolCall("bash-1", ToolNames.Bash, { command: "npm test" }),
			toolResult("bash-1", ToolNames.Bash, false),
		];
		const activeAcceptance = {
			expectedOutputs: ["src/thing.ts"],
			verification: [
				{ check: "test", timeoutMs: 1000 },
				{ check: "lint", timeoutMs: 1000 },
			],
		};
		const audits: CompletionEvaluationInput[] = [];
		const normal = createFinishContractRegistration({
			readSessionEntries: () => entries,
			readActiveAcceptance: () => activeAcceptance,
			getTurnConstraints: () => ({ mode: "proposal", allowedTools: ["read", "edit"] }),
			recordDecision: (input) => audits.push(input),
		});
		const effects = await normal.evaluate({
			hook: "turn_end",
			text: "Done.",
			sessionId: "finish-session",
			turnId: "finish-turn",
		});
		deepStrictEqual(effects, [
			{ kind: "inject_reminder", severity: "warn", message: FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE },
		]);
		strictEqual(audits[0]?.sessionId, "finish-session");
		strictEqual(audits[0]?.turnId, "finish-turn");
		strictEqual(audits[0]?.decision, "ok");
		deepStrictEqual(audits[0]?.verificationScope?.acceptance, [
			{ check: "test", state: "passed" },
			{ check: "lint", state: "unverified" },
		]);
		entries.push(
			toolCall("lim-1", ToolNames.Limitation, { scope: "lint not authorized", reason: "out-of-scope", paths: ["lint"] }),
			toolResult("lim-1", ToolNames.Limitation, false),
		);
		const high = createFinishContractRegistration({
			readSessionEntries: () => entries,
			readActiveAcceptance: () => activeAcceptance,
			resolveRigor: () => "high",
			recordDecision: (input) => audits.push(input),
		});
		deepStrictEqual(await high.evaluate({ hook: "turn_end", text: "Done." }), effects);
		strictEqual(audits[1]?.reason, "explicit_limitation");
		deepStrictEqual(audits[1]?.verificationScope?.passedChecks, ["test"]);
		deepStrictEqual(audits[1]?.verificationScope?.acceptance, [
			{ check: "test", state: "passed" },
			{ check: "lint", state: "limited" },
		]);
		deepStrictEqual(audits[1]?.verificationScope?.limitations[0]?.paths, ["lint"]);
		activeAcceptance.verification.pop();
		deepStrictEqual(await high.evaluate({ hook: "turn_end", text: "Done." }), effects);
		strictEqual(audits[2]?.reason, "validation_evidence");
		deepStrictEqual(audits[2]?.verificationScope?.acceptance, [{ check: "test", state: "passed" }]);
	});

	it("credits a passing check spelled with output flags, corepack or a runner in front (CLI-P24)", async () => {
		for (const command of [
			"pnpm -s run typecheck",
			"corepack pnpm run -s typecheck",
			"corepack pnpm -s exec biome check src",
			"npx tsc --noEmit",
		]) {
			strictEqual(reprompted(await highRigorGate(checkedWindow(command), "Done.")), false, command);
		}
	});

	it("still fires when the check did not run, failed, ran before the edit, or was only named (CLI-P24)", async () => {
		const before = [
			userMessage("user-1"),
			toolCall("bash-0", ToolNames.Bash, { command: "corepack pnpm -s run typecheck" }),
			toolResult("bash-0", ToolNames.Bash, false),
			toolCall("write-1", ToolNames.Write, { path: "src/thing.ts", content: "x" }),
			toolResult("write-1", ToolNames.Write, false),
		];
		for (const [name, entries] of [
			["no check", mutationWindow()],
			["failed check", checkedWindow("corepack pnpm -s run typecheck", true)],
			["check before the edit", before],
			["echoed check", checkedWindow("echo corepack pnpm -s run typecheck")],
			["corepack's own command", checkedWindow("corepack enable")],
		] as const) {
			strictEqual(reprompted(await highRigorGate([...entries], "Done.")), true, name);
		}
	});

	it("waits on a step turn a step continuation follows and assesses the whole pipeline at its end (bt-12 #4)", async () => {
		const entries = [
			userMessage("user-1"),
			toolCall("write-1", ToolNames.Write, { path: "src/clean.py", content: "x" }),
			toolResult("write-1", ToolNames.Write, false),
			assistantMessage("assistant-1", "Stage 2/3 clean done."),
		];
		const audits: CompletionEvaluationInput[] = [];
		const registration = createFinishContractRegistration({
			readSessionEntries: () => entries,
			recordDecision: (input) => audits.push(input),
		});
		const step = await registration.evaluate({
			hook: "turn_end",
			text: "Stage 2/3 clean done.",
			turnId: "assistant-1",
			metadata: { stepContinues: true },
		});
		deepStrictEqual(step, []);
		strictEqual(audits.length, 0);
		// The last step turn changed nothing itself; the window from the pipeline's start still holds the first step's change.
		entries.push(userMessage("user-2"), assistantMessage("assistant-2", "Pipeline complete."));
		const end = await registration.evaluate({
			hook: "turn_end",
			text: "Pipeline complete.",
			turnId: "assistant-2",
			metadata: { stepPipelineStartTurnId: "user-1" },
		});
		strictEqual(end.length, 1);
		const [advisory] = end;
		ok(advisory?.kind === "inject_reminder" && advisory.message.startsWith(FINISH_CONTRACT_ADVISORY_MESSAGE));
		deepStrictEqual(audits[0]?.mutatedPaths, ["src/clean.py"]);
	});

	it("accepts a successful native Node test receipt after an edit but not a failed test", () => {
		for (const isError of [false, true]) {
			const entries = [
				...mutationWindow(),
				toolCall("node-test", ToolNames.Bash, { command: "node --test sum.test.mjs" }),
				toolResult("node-test", ToolNames.Bash, isError),
				assistantMessage("assistant-1", "Test run completed."),
			];
			const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
			strictEqual(assessment.reason, isError ? "unvalidated_mutation" : "validation_evidence");
		}
	});

	it("reads a here-document written ahead of its suite run as the change and the check, passed or failed (SF-5, SF-6)", () => {
		// The second is a recorded live call: the check names the file the here-document wrote, after earlier steps.
		for (const [command, file] of [
			[
				"cat > tests/x.test.mjs <<'EOF' && npm test\nimport test from 'node:test';\ntest('x', () => {});\nEOF",
				"tests/x.test.mjs",
			],
			[
				"npm -v > $TMPDIR/v.log; echo y > out/x.js; cat > t.test.mjs <<'EOF' && node --test t.test.mjs\nimport test from 'node:test'; test('a',()=>{});\nEOF",
				"t.test.mjs",
			],
		] as const)
			for (const exitCode of [0, 1]) {
				const result = {
					kind: "message",
					role: "tool_result",
					turnId: "suite",
					payload: {
						toolName: ToolNames.Bash,
						toolCallId: "suite",
						isError: exitCode !== 0,
						result: { kind: exitCode === 0 ? "ok" : "error", details: { outcome: "nonzero", exitCode } },
					},
				};
				const assessment = assessFinishContract({
					sessionEntries: [
						userMessage("user-1"),
						toolCall("suite", ToolNames.Bash, { command }),
						result,
						assistantMessage("assistant-1", "Suite run."),
					],
					assistantTurnId: "assistant-1",
				});
				strictEqual(assessment.reason, exitCode === 0 ? "validation_evidence" : "unvalidated_mutation", command);
				ok(assessment.mutatedPaths.includes(file), command);
			}
	});

	it("counts no scratch, unexpanded, outside or git-ignored shell redirect as a changed file (FX-1)", (t) => {
		const root = mkdtempSync(join(tmpdir(), "finish-scratch-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		execFileSync("git", ["init", "-q"], { cwd: root, env });
		writeFileSync(join(root, ".gitignore"), "dist/\n");
		const command = [
			"npm run lint > $TMPDIR/lint.log",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: an unexpanded shell variable in the command text.
			"git diff > ${OUT}/src.patch",
			"echo x > /dev/null",
			`echo x > ${join(tmpdir(), "outside.txt")}`,
			"echo x > dist/bundle.js",
			"echo x > src/a.ts",
		].join("; ");
		const assessment = assessFinishContract({
			sessionEntries: [
				userMessage("user-1"),
				toolCall("shell", ToolNames.Bash, { command }),
				toolResult("shell", ToolNames.Bash, false),
				assistantMessage("assistant-1", "Done."),
			],
			assistantTurnId: "assistant-1",
			workspaceRoot: root,
		});
		deepStrictEqual(assessment.mutatedPaths, ["src/a.ts"]);
	});

	it("credits no bash, verify, operator or declared pass a later edit retired, nor the high-rigor gate (x8-1)", (t) => {
		const root = mkdtempSync(join(tmpdir(), "finish-retired-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const edit = (id: string) => [
			toolCall(id, ToolNames.Write, { path: "src/thing.ts", content: id }),
			toolResult(id, ToolNames.Write, false),
		];
		const ran = (name: string, args: Record<string, unknown>) => [
			toolCall("check", name, args),
			toolResult("check", name, false),
		];
		const checks: Array<[string, unknown[]]> = [
			["npm test", ran(ToolNames.Bash, { command: "npm test" })],
			["verify", ran(ToolNames.Verify, { check: "test" })],
			["operator !", [{ kind: "bashExecution", turnId: "bang", command: "npm test", exitCode: 0 }]],
			["declared make check", ran(ToolNames.Bash, { command: "make check" })],
			// Checks the shared classifier settles that the finish vocabulary does not name.
			["cargo clippy", ran(ToolNames.Bash, { command: "cargo clippy" })],
			["operator ! mypy", [{ kind: "bashExecution", turnId: "bang", command: "mypy .", exitCode: 0 }]],
		];
		for (const [label, check] of checks)
			for (const stale of [false, true]) {
				const assess = (rigor: "normal" | "high") =>
					assessFinishContract({
						sessionEntries: [
							userMessage("user-1"),
							...edit("edit-1"),
							...check,
							...(stale ? edit("edit-2") : []),
							assistantMessage("assistant-1", "Done."),
						],
						assistantTurnId: "assistant-1",
						workspaceRoot: root,
						sessionVerifiers: [{ id: "make-check", command: "make check" }],
						rigor,
						activeAcceptance: { expectedOutputs: [], verification: [{ check: "test", timeoutMs: 60_000 }] },
					});
				const normal = assess("normal");
				strictEqual(normal.reason, stale ? "unvalidated_mutation" : "validation_evidence", `${label} stale=${stale}`);
				strictEqual(normal.verificationScope?.passedChecks.length === 0, stale, label);
				if (label === "npm test" || label === "operator !")
					strictEqual(assess("high").verificationScope?.acceptance[0]?.state, stale ? "unverified" : "passed", label);
			}
	});

	it("names a changed file a later command ran, without counting the run as a check (bt-12)", () => {
		const assess = (before: unknown[], after: unknown[]) =>
			assessFinishContract({
				sessionEntries: [
					userMessage("user-1"),
					...before,
					toolCall("write-1", ToolNames.Write, { path: "src/clean.py", content: "x" }),
					toolResult("write-1", ToolNames.Write, false),
					...after,
					assistantMessage("assistant-1", "Cleaned the data."),
				],
				assistantTurnId: "assistant-1",
			});
		const run = (id: string, command: string) => [
			toolCall(id, ToolNames.Bash, { command }),
			toolResult(id, ToolNames.Bash, false),
		];
		const ran = assess([], run("run-1", "python3 -B src/clean.py data/raw.csv > out/clean.csv; cat out/clean.csv"));
		strictEqual(ran.reason, "unvalidated_mutation");
		strictEqual(ran.kind === "engage" && ran.message.endsWith(" Ran after the edit: src/clean.py."), true);
		// A run before the edit, or a call that both writes and runs the file, did not run the change.
		for (const unrun of [
			assess(run("run-0", "python3 src/clean.py"), []),
			assess([], run("run-2", "echo x > src/clean.py && python3 src/clean.py")),
		])
			strictEqual(unrun.kind === "engage" && unrun.message, FINISH_CONTRACT_ADVISORY_MESSAGE);
	});

	it("names a changed file a project runner executed: uv run, make and npm run (SC-3)", () => {
		const ranAfter = (path: string, command: string) => {
			const verdict = assessFinishContract({
				sessionEntries: [
					userMessage("user-1"),
					toolCall("write-1", ToolNames.Write, { path, content: "x" }),
					toolResult("write-1", ToolNames.Write, false),
					toolCall("run-1", ToolNames.Bash, { command }),
					toolResult("run-1", ToolNames.Bash, false),
					assistantMessage("assistant-1", "Done."),
				],
				assistantTurnId: "assistant-1",
			});
			return verdict.kind === "engage" && verdict.message.endsWith(` Ran after the edit: ${path}.`);
		};
		strictEqual(ranAfter("src/clean.py", "uv run src/clean.py data/raw.csv"), true);
		strictEqual(ranAfter("src/clean.py", "uv run --with pandas python -B src/clean.py"), true);
		strictEqual(ranAfter("Makefile", "make all"), true);
		strictEqual(ranAfter("sim/Makefile", "make -C sim run"), true);
		strictEqual(ranAfter("build.mk", "make -f build.mk"), true);
		strictEqual(ranAfter("package.json", "npm run clean"), true);
		strictEqual(ranAfter("web/package.json", "cd web && pnpm run clean"), true);
		// A runner never credits a file it does not read.
		strictEqual(ranAfter("src/clean.py", "make all"), false);
		strictEqual(ranAfter("package.json", "npm install"), false);
	});

	it("credits a declared check the model ran whole through the shell after its last edit, and nothing looser", (t) => {
		const root = mkdtempSync(join(tmpdir(), "finish-declared-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, ".clio-coder"));
		writeFileSync(
			join(root, ".clio-coder", "verifiers.yaml"),
			"version: 2\nchecks:\n  - id: calc\n    description: calc adds\n    command: [python3, -c, 'import calc; assert calc.add(2, 3) == 5']\n    cwd: .\n    timeoutMs: 60000\n    tags: []\n",
		);
		const sessionVerifiers = [{ id: "run-acceptance", command: "./acceptance.sh --strict && echo done" }];
		const assess = (command: string, isError = false, beforeEdit = false) => {
			const run = [toolCall("sh-1", ToolNames.Bash, { command }), toolResult("sh-1", ToolNames.Bash, isError)];
			const edit = mutationWindow().slice(1);
			const entries = [
				userMessage("user-1"),
				...(beforeEdit ? [...run, ...edit] : [...edit, ...run]),
				assistantMessage("assistant-1", "Fixed."),
			];
			return assessFinishContract({
				sessionEntries: entries,
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
				sessionVerifiers,
			});
		};
		const passed = assess(`python3 -c 'import calc; assert calc.add(2, 3) == 5' && echo OK`);
		strictEqual(passed.reason, "validation_evidence");
		deepStrictEqual(passed.verificationScope?.passedChecks, ["calc"]);
		strictEqual(assess("cd . && ./acceptance.sh  --strict && echo done && ls").reason, "validation_evidence");
		// The recorder reads a declared run through the same classifier, so the receipt files what the gate credits (x7-5).
		const filed = (command: string, verifiers = sessionVerifiers) => {
			const recorder = createRunEffectsRecorder(root, { sessionVerifiers: verifiers });
			recorder.start("sh-1", ToolNames.Bash, { command });
			recorder.checkOutcome("sh-1", "ok");
			recorder.finish("sh-1", false);
			return [...recorder.snapshot().validationOutcomes.keys()];
		};
		deepStrictEqual(filed("./acceptance.sh --strict && echo done"), ["./acceptance.sh --strict && echo done"]);
		deepStrictEqual(filed("./acceptance.sh --strict && echo done", []), []);
		deepStrictEqual(filed(`python3 -c 'import calc; assert calc.add(2, 3) == 5' && echo OK`, []).length, 1);
		// A declared pass after the last edit is the receipt's typed fact under its declared id, as board and gate read it (S1).
		const sealed = (command: string, verifiers = sessionVerifiers) => {
			const recorder = createRunEffectsRecorder(root, { sessionVerifiers: verifiers });
			for (const [id, tool, args] of [
				["e-1", ToolNames.Edit, { path: "calc.py" }],
				["sh-1", ToolNames.Bash, { command }],
			] as const) {
				recorder.start(id, tool, args);
				recorder.checkOutcome(id, "ok");
				recorder.finish(id, false);
			}
			return [...recorder.snapshot().validationCommands];
		};
		deepStrictEqual(sealed("./acceptance.sh --strict && echo done"), ["run-acceptance"]);
		deepStrictEqual(sealed(`python3 -c 'import calc; assert calc.add(2, 3) == 5' && echo OK`), ["calc"]);
		deepStrictEqual(sealed("git diff --check", [{ id: "diff-check", command: "git diff --check" }]), ["diff-check"]);
		for (const unproven of [
			assess(`python3 -c 'import calc; assert calc.add(2, 3) == 5'`, true),
			assess(`python3 -c 'import calc; assert calc.add(2, 3) == 5'`, false, true),
			assess(`python3 -c 'import calc; assert calc.add(2, 3) == 5' | tee log`),
			assess(`python3 -c 'import calc; assert calc.add(2, 3) == 5' || true`),
			assess(`python3 -c 'import calc; assert calc.add(2, 3)'`),
			assess("./acceptance.sh --strict"),
			assess("./acceptance.sh --strict && echo $DONE"),
		]) {
			strictEqual(unproven.reason, "unvalidated_mutation");
			strictEqual(
				unproven.kind === "engage" ? unproven.message : "",
				`${FINISH_CONTRACT_ADVISORY_MESSAGE} Declared checks: calc. Run checks: run-acceptance.`,
			);
		}
	});

	it("credits every declared check a chain runs, unless an earlier segment can skip or move it or a later one edits", (t) => {
		const root = mkdtempSync(join(tmpdir(), "finish-declared-chain-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const sessionVerifiers = [
			{ id: "run-acceptance", command: "./acceptance.sh" },
			{ id: "run-second", command: "./second.sh" },
			{ id: "run-false", command: "false" },
			{ id: "run-pwd", command: "pwd" },
		];
		const assess = (command: string) =>
			assessFinishContract({
				sessionEntries: [
					userMessage("user-1"),
					...mutationWindow().slice(1),
					toolCall("sh-1", ToolNames.Bash, { command }),
					toolResult("sh-1", ToolNames.Bash, false),
					assistantMessage("assistant-1", "Fixed."),
				],
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
				sessionVerifiers,
			});
		const passedChecks = (command: string) => [...(assess(command).verificationScope?.passedChecks ?? [])].sort();
		deepStrictEqual(passedChecks("./acceptance.sh && ./second.sh"), ["run-acceptance", "run-second"]);
		deepStrictEqual(passedChecks("true && pwd"), ["run-pwd"]);
		deepStrictEqual(passedChecks("cp before.ts src/thing.ts && ./acceptance.sh"), ["run-acceptance"]);
		// A check before the call's own change makes it mixed, so the shared classifier settles neither (x7-5).
		deepStrictEqual(passedChecks("./acceptance.sh && cp before.ts src/thing.ts && ./second.sh"), []);
		for (const command of [
			"exit 0 && false",
			"exec true && false",
			"true && cd / && pwd",
			"pushd / && pwd",
			"PATH=/nowhere && pwd",
			"time exit 0 && false",
			"time cd / && pwd",
			"env exec true && false",
			"nohup true && command cd / && pwd",
			"/usr/bin/time exit 0 && false",
			"./acceptance.sh && cp before.ts src/thing.ts",
			"./acceptance.sh && rm src/thing.ts",
		]) {
			strictEqual(assess(command).reason, "unvalidated_mutation", command);
		}
	});

	it("reads a declared check through wrappers, pipes and logs as a check of the same spelling (x10-1)", (t) => {
		const root = mkdtempSync(join(tmpdir(), "finish-declared-steps-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, ".clio-coder"));
		const check = (id: string, command: string) =>
			`  - id: ${id}\n    description: ${id}\n    command: [${command}]\n    cwd: .\n    timeoutMs: 600000\n    tags: []\n`;
		writeFileSync(
			join(root, ".clio-coder", "verifiers.yaml"),
			`version: 2\nchecks:\n${check("ci", "make, ci")}${check("e2e", "./scripts/e2e.sh")}`,
		);
		const declaredChecks = declaredVerifierCommands(root, []);
		const read = (command: string) => {
			const call = classifyCall(
				ToolNames.Bash,
				{ command },
				{ cwd: root, declaredChecks, outputTarget: checkOutputReader(root) },
			);
			const assessment = assessFinishContract({
				sessionEntries: [
					userMessage("user-1"),
					...mutationWindow().slice(1),
					toolCall("sh-1", ToolNames.Bash, { command }),
					toolResult("sh-1", ToolNames.Bash, false),
					assistantMessage("assistant-1", "Fixed."),
				],
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
				activeAcceptance: { expectedOutputs: [], verification: [{ check: "ci", timeoutMs: 600000 }] },
			});
			return {
				verdict: call.verdict,
				declared: call.declared,
				green: settleCheckCall(call, false, "ok", true).settled,
				gate: assessment.kind,
				ci: assessment.verificationScope?.acceptance[0]?.state,
			};
		};
		for (const [command, id] of [
			["make ci", "ci"],
			["make ci 2>&1 | tail -50", "ci"],
			["make ci | tee ci.log", "ci"],
			["make ci > ci.log 2>&1", "ci"],
			["timeout 600 make ci", "ci"],
			["time ./scripts/e2e.sh", "e2e"],
		] as const)
			deepStrictEqual(
				read(command),
				{ verdict: "check", declared: [id], green: true, gate: "ok", ci: id === "ci" ? "passed" : "unverified" },
				command,
			);
		// `| head` can fail a green run, so a red behind it stays unattributed, as for a vocabulary check.
		const piped = classifyCall(ToolNames.Bash, { command: "make ci | head" }, { cwd: root, declaredChecks });
		strictEqual(settleCheckCall(piped, true, "error", true).settled, false);
		for (const command of ["make ci FOO=1", "make ci && touch x"]) {
			const { green, gate, ci } = read(command);
			deepStrictEqual({ green, gate, ci }, { green: false, gate: "engage", ci: "unverified" }, command);
		}
	});

	it("requires verified and validated canonical dispatch evidence, not just a zero exit code", (t) => {
		const trusted = composeTrustStatus({
			artifactIntegrity: {
				state: "verified",
				source: { kind: "run_seal", id: "run-1" },
				authority: { kind: "clio", id: "receipt-integrity" },
				artifacts: [],
			},
			validationGrounding: {
				state: "validated",
				source: { kind: "run_record", id: "run-1" },
				authority: { kind: "validator", id: "result-quality" },
				artifacts: [],
			},
		});
		const run = { runId: "run-1", agentId: "verifier", exitCode: 0, trustStatus: trusted };
		const failed = {
			...run,
			trustStatus: { ...trusted, validationGrounding: { ...trusted.validationGrounding, state: "failed" } },
		};
		const candidates: Array<{ details: Record<string, unknown>; passed: boolean }> = [
			{ details: run, passed: true },
			{ details: { runs: [run], failedCount: 0 }, passed: true },
			{ details: failed, passed: false },
			{ details: { runs: [run, failed], failedCount: 0 }, passed: false },
			{ details: { ...run, trustStatus: null }, passed: false },
			{ details: { ...run, trustStatus: composeTrustStatus() }, passed: false },
			{
				details: {
					...run,
					trustStatus: { ...trusted, validationGrounding: { ...trusted.validationGrounding, state: "ungrounded" } },
				},
				passed: false,
			},
			{
				details: {
					...run,
					trustStatus: { ...trusted, artifactIntegrity: { ...trusted.artifactIntegrity, state: "failed" } },
				},
				passed: false,
			},
			// Preserve compatibility for historical ledgers without canonical trust fields.
			{ details: { runId: "old", agentId: "verifier", exitCode: 0 }, passed: true },
		];
		for (const { details, passed } of candidates) {
			const entries = [
				...mutationWindow(),
				toolCall("dispatch-1", ToolNames.Dispatch, { agent_id: "verifier", task: "Verify the edit" }),
				{
					kind: "message",
					role: "tool_result",
					payload: { toolName: "dispatch", toolCallId: "dispatch-1", result: { details } },
				},
				assistantMessage("assistant-1", "Review finished."),
			];
			const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
			strictEqual(assessment.reason, passed ? "validation_evidence" : "unvalidated_mutation", JSON.stringify(details));
		}
		// The run record stands in the shared fold only until a later change retires it, like any check (x9-1).
		const root = mkdtempSync(join(tmpdir(), "finish-dispatch-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const edit = mutationWindow().slice(1);
		const dispatched = [
			toolCall("dispatch-1", ToolNames.Dispatch, { agent_id: "verifier", task: "Verify the edit" }),
			{
				kind: "message",
				role: "tool_result",
				payload: { toolName: "dispatch", toolCallId: "dispatch-1", result: { details: run } },
			},
		];
		const bashCheck = [
			toolCall("sh-1", ToolNames.Bash, { command: "npm test" }),
			toolResult("sh-1", ToolNames.Bash, false),
		];
		const assess = (steps: unknown[], rigor: "normal" | "high" = "normal") =>
			assessFinishContract({
				sessionEntries: [userMessage("user-1"), ...steps, assistantMessage("assistant-1", "Done.")],
				assistantTurnId: "assistant-1",
				workspaceRoot: root,
				rigor,
				activeAcceptance: { expectedOutputs: [], verification: [{ check: "test", timeoutMs: 60_000 }] },
			});
		strictEqual(assess([...dispatched, ...edit]).reason, "unvalidated_mutation");
		deepStrictEqual(
			assess([...edit, ...dispatched]).evidence.map((item) => item.kind),
			["dispatch_run_record"],
		);
		deepStrictEqual(
			assess([...dispatched, ...edit, ...bashCheck]).evidence.map((item) => item.kind),
			["validation_command"],
		);
		// A standing run record is no declared or acceptance check: it seals no outcome and passes no required check.
		const facts = runCheckFacts([...edit, ...dispatched], root, []);
		deepStrictEqual(
			[...facts.passCalls].map(([id, item]) => [id, item.check]),
			[["dispatch-1", undefined]],
		);
		deepStrictEqual(facts.failing, []);
		strictEqual(assess([...edit, ...dispatched], "high").reason, "unvalidated_mutation");
	});

	it("projects the limitation kind onto the completion-evidence tag", () => {
		deepStrictEqual(FINISH_CONTRACT_EVIDENCE_TAGS.limitation, ["completion-evidence"]);
	});
});

describe("finish contract: only a change that ran in the workspace needs validation", () => {
	it("settles ok/no_mutation when the only write was blocked, even though isError is false", () => {
		const blocked = {
			kind: "message",
			role: "tool_result",
			turnId: "write-1",
			payload: {
				toolName: ToolNames.Write,
				toolCallId: "write-1",
				isError: false,
				outcome: "blocked",
				blockReason: "write-path-outside-cwd",
				result: { kind: "ok" },
			},
		};
		const entries = [
			userMessage("user-1"),
			toolCall("write-1", ToolNames.Write, { path: "src/thing.ts", content: "x" }),
			blocked,
			assistantMessage("assistant-1", "The write was denied."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "no_mutation");
		strictEqual(assessment.advisory, undefined);
		strictEqual(assessment.verificationScope, undefined);
	});

	it("settles ok/no_net_mutation for a write outside the workspace", () => {
		const entries = [
			userMessage("user-1"),
			toolCall("write-1", ToolNames.Write, { path: "/tmp/clio-note.txt", content: "hello" }),
			toolResult("write-1", ToolNames.Write, false),
			assistantMessage("assistant-1", "Wrote the note."),
		];
		const assessment = assessFinishContract({
			sessionEntries: entries,
			assistantTurnId: "assistant-1",
			workspaceRoot: "/workspace/project",
		});
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "no_net_mutation");
		deepStrictEqual(assessment.mutatedPaths, []);
		strictEqual(assessment.advisory, undefined);
	});

	it("settles ok/deletion_only when the turn only removed tests, and engages for removed source or a write", () => {
		const removal = [
			userMessage("user-1"),
			toolCall("rm-1", ToolNames.Bash, { command: "rm -r test" }),
			toolResult("rm-1", ToolNames.Bash, false),
		];
		const deleted = assessFinishContract({
			sessionEntries: [...removal, assistantMessage("assistant-1", "Removed test/.")],
			assistantTurnId: "assistant-1",
		});
		strictEqual(deleted.kind, "ok");
		strictEqual(deleted.reason, "deletion_only");
		const source = assessFinishContract({
			sessionEntries: [
				userMessage("user-1"),
				toolCall("rm-2", ToolNames.Bash, { command: "rm src/util.js" }),
				toolResult("rm-2", ToolNames.Bash, false),
				assistantMessage("assistant-1", "Removed src/util.js."),
			],
			assistantTurnId: "assistant-1",
		});
		strictEqual(source.kind, "engage");
		const requested = assessFinishContract({
			sessionEntries: [
				{ kind: "message", role: "user", turnId: "user-2", payload: { text: "Delete the src folder, then commit." } },
				toolCall("rm-3", ToolNames.Bash, { command: "rm -rf src" }),
				toolResult("rm-3", ToolNames.Bash, false),
				assistantMessage("assistant-2", "Removed src/."),
			],
			assistantTurnId: "assistant-2",
		});
		strictEqual(requested.reason, "deletion_only");
		const edited = assessFinishContract({
			sessionEntries: [
				...removal,
				toolCall("write-1", ToolNames.Write, { path: "src/a.js", content: "x" }),
				toolResult("write-1", ToolNames.Write, false),
				assistantMessage("assistant-1", "Removed test/ and edited src/a.js."),
			],
			assistantTurnId: "assistant-1",
		});
		strictEqual(edited.kind, "engage");
	});
});

describe("the limitation tool", () => {
	it("rejects a reason outside the enum", async () => {
		const result = await limitationTool.run({ scope: "tests could not run", reason: "because" });
		strictEqual(result.kind, "error");
		ok(result.kind === "error" && result.message.includes("reason must be one of"), JSON.stringify(result));
	});

	it("rejects an empty scope", async () => {
		const result = await limitationTool.run({ scope: "  ", reason: "blocked" });
		strictEqual(result.kind, "error");
	});

	it("records scope, reason, and paths in the result details", async () => {
		const result = await limitationTool.run({
			scope: "integration tests need a database",
			reason: "environment",
			paths: ["src/db.ts", "src/db.ts", " tests/db.test.ts "],
		});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		deepStrictEqual(result.details?.limitation, {
			scope: "integration tests need a database",
			reason: "environment",
			paths: ["src/db.ts", "tests/db.test.ts"],
		});
		ok(result.output.startsWith("limitation recorded: "), result.output);
	});

	it("is read class, parallel, and agrees with the classifier and plane table", () => {
		strictEqual(limitationTool.baseActionClass, "read");
		strictEqual(limitationTool.executionMode, "parallel");
		const errors = validateBuiltinToolPolicy([builtin(limitationTool, SOURCE)]).filter((error: string) =>
			error.includes(ToolNames.Limitation),
		);
		deepStrictEqual(errors, []);
	});
});

describe("the finish declaration (fleet design 4.3)", () => {
	it("ends the turn with a typed declaration, runs alone, skips the gate when unfinished, and is pinned only unattended", async () => {
		const declared = await finishTool.run({ state: "partly_done", remaining: ["docs"], limitations: [] });
		strictEqual(declared.kind, "ok");
		ok(declared.kind === "ok" && declared.terminate === true);
		deepStrictEqual(declared.kind === "ok" ? declared.details?.completion : null, {
			state: "partly_done",
			limitations: [],
			unverified: [],
			remaining: ["docs"],
		});
		strictEqual((await finishTool.run({ state: "finished" })).kind, "error");
		const call = { name: ToolNames.Finish, arguments: { state: "done" } };
		strictEqual(finishSiblingRefusal(call, { content: [{ type: "text" }, { type: "toolCall" }] }), undefined);
		ok(finishSiblingRefusal(call, { content: [{ type: "toolCall" }, { type: "toolCall" }] })?.block);
		// XR-8: a declared unfinished state is a progress note the gate skips; on a done the host seals the gate's fact.
		const gate = (completionState?: string) =>
			createFinishContractRegistration({
				readSessionEntries: () => mutationWindow(),
				resolveRigor: () => "high",
			}).evaluate({
				hook: "turn_end",
				text: "Partly done: the edit is in, checks are not run.",
				...(completionState ? { metadata: { completionState } } : {}),
			});
		ok(reprompted(gate()));
		ok(reprompted(gate("done")));
		deepStrictEqual(gate("partly_done"), []);
		deepStrictEqual(gate("not_done"), []);
		const turn = {
			headless: true,
			origin: "operator",
			declared: false,
			calledWork: true,
			spent: false,
			toolsLocked: false,
			endedOnTerminalTool: false,
			finishAttached: true,
		};
		strictEqual(finishRoundDue(turn), true);
		strictEqual(finishRoundDue({ ...turn, headless: false }), false);
		strictEqual(finishRoundDue({ ...turn, headless: false, origin: "job" }), true);
		strictEqual(finishRoundDue({ ...turn, headless: false, origin: "continuation" }), true);
		for (const change of [{ declared: true }, { calledWork: false }, { spent: true }, { toolsLocked: true }])
			strictEqual(finishRoundDue({ ...turn, ...change }), false, JSON.stringify(change));
	});

	it("refuses an attended finish whose response carries no reply text once per user turn (FX-40)", () => {
		const finish = { name: ToolNames.Finish, arguments: { state: "done" } };
		const attended = { headless: false, origin: "operator", refusedThisTurn: false };
		const bare = {
			content: [{ type: "thinking", thinking: "done" }, { type: "text", text: " \n" }, { type: "toolCall" }],
		};
		strictEqual(bareFinishVerdict(finish, bare, attended), "refuse");
		// The turn's one refusal is spent: the next bare finish runs, and its declaration records the missing reply.
		strictEqual(bareFinishVerdict(finish, bare, { ...attended, refusedThisTurn: true }), "admit");
		deepStrictEqual(withoutReplyLimitation({ state: "done", limitations: [], unverified: [] }).limitations, [
			{ what: "the response that declared completion carried no reply text for the operator", why: "other" },
		]);
		// A refused call carries no declaration in its result, so it seals nothing.
		strictEqual(completionOfToolResult(ToolNames.Finish, { details: {} }), null);
		const replied = { content: [{ type: "text", text: "pineapple" }, { type: "toolCall" }] };
		strictEqual(bareFinishVerdict(finish, replied, attended), null);
		strictEqual(bareFinishVerdict({ name: ToolNames.Read, arguments: {} }, bare, attended), null);
		for (const unattended of [
			{ headless: true, origin: "operator" },
			...["job", "continuation"].map((origin) => ({ headless: false, origin })),
		])
			strictEqual(
				bareFinishVerdict(finish, bare, { ...unattended, refusedThisTurn: false }),
				null,
				JSON.stringify(unattended),
			);
	});

	it("assesses a textless declared done over an unvalidated edit as partly_done (fleet design 4.3)", () => {
		const facts = (rigor: "high" | "normal", completionState?: string) =>
			createFinishContractRegistration({ readSessionEntries: () => mutationWindow(), resolveRigor: () => rigor })
				.evaluate({ hook: "turn_end", text: "", ...(completionState ? { metadata: { completionState } } : {}) })
				.flatMap((effect) => ("fact" in effect && effect.fact !== undefined ? [effect.fact] : []));
		// An undeclared empty reply claims nothing; a declared done is assessed from the ledger whatever the prose.
		deepStrictEqual(facts("high"), []);
		ok(facts("high", "done").includes("unvalidated_mutation"));
		deepStrictEqual(facts("normal", "done"), ["unvalidated_mutation"]);
		const done = { state: "done" as const, limitations: [], unverified: ["the edit"] };
		deepStrictEqual(sealCompletion(done, facts("normal", "done")), {
			declared: true,
			claimed: "done",
			assessed: "partly_done",
			facts: ["unvalidated_mutation"],
			limitations: [],
			unverified: ["the edit"],
		});
		strictEqual(sealCompletion(done, []).assessed, "done");
		strictEqual(sealCompletion({ ...done, state: "not_done" }, ["open_task"]).assessed, "not_done");
		deepStrictEqual(sealCompletion(null, ["open_task"]), {
			declared: false,
			claimed: null,
			assessed: "unknown",
			facts: ["open_task"],
			limitations: [],
			unverified: [],
		});
	});
});
