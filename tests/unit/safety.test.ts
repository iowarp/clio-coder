import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { assessFinishContract, FINISH_CONTRACT_ADVISORY_MESSAGE } from "../../src/domains/safety/finish-contract.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import {
	classifyDestructiveCommand,
	detectValidationCommand,
	isProtectedPath,
	type ProtectedArtifact,
	type ProtectedArtifactState,
	protectArtifact,
	unprotectArtifact,
} from "../../src/domains/safety/protected-artifacts.js";
import { DEFAULT_SCOPE, isSubset, READONLY_SCOPE, SUPER_SCOPE } from "../../src/domains/safety/scope.js";

describe("safety/action-classifier", () => {
	it("read tools classify as read", () => {
		strictEqual(classify({ tool: "read", args: { path: "/x" } }).actionClass, "read");
		strictEqual(classify({ tool: "grep", args: {} }).actionClass, "read");
		strictEqual(classify({ tool: "glob", args: {} }).actionClass, "read");
	});

	it("write tools classify as write when under cwd", () => {
		const cwdPath = `${process.cwd()}/scratch.txt`;
		strictEqual(classify({ tool: "write", args: { path: cwdPath } }).actionClass, "write");
		strictEqual(classify({ tool: "edit", args: { path: cwdPath } }).actionClass, "write");
	});

	it("write outside cwd escalates to system_modify", () => {
		strictEqual(classify({ tool: "write", args: { path: "/etc/nope" } }).actionClass, "system_modify");
	});

	it("bash with benign command classifies as execute", () => {
		strictEqual(classify({ tool: "bash", args: { command: "ls -la" } }).actionClass, "execute");
	});

	it("git destructive patterns escalate to git_destructive", () => {
		strictEqual(classify({ tool: "bash", args: { command: "git push --force" } }).actionClass, "git_destructive");
		strictEqual(classify({ tool: "bash", args: { command: "git reset --hard HEAD" } }).actionClass, "git_destructive");
		strictEqual(classify({ tool: "bash", args: { command: "git branch -D feature" } }).actionClass, "git_destructive");
	});

	it("system modify patterns escalate to system_modify", () => {
		strictEqual(classify({ tool: "bash", args: { command: "sudo rm /foo" } }).actionClass, "system_modify");
		strictEqual(classify({ tool: "bash", args: { command: "apt-get install vim" } }).actionClass, "system_modify");
		strictEqual(classify({ tool: "bash", args: { command: "rm -rf /etc/passwd" } }).actionClass, "system_modify");
	});

	it("rm -rf under /tmp is not system_modify", () => {
		strictEqual(classify({ tool: "bash", args: { command: "rm -rf /tmp/foo" } }).actionClass, "execute");
	});

	it("unknown tool returns unknown", () => {
		strictEqual(classify({ tool: "mystery" }).actionClass, "unknown");
	});
});

describe("safety/scope", () => {
	it("READONLY is subset of DEFAULT and SUPER", () => {
		strictEqual(isSubset(READONLY_SCOPE, DEFAULT_SCOPE), true);
		strictEqual(isSubset(READONLY_SCOPE, SUPER_SCOPE), true);
	});

	it("SUPER is not subset of DEFAULT (system_modify missing)", () => {
		strictEqual(isSubset(SUPER_SCOPE, DEFAULT_SCOPE), false);
	});

	it("DEFAULT is subset of SUPER", () => {
		strictEqual(isSubset(DEFAULT_SCOPE, SUPER_SCOPE), true);
	});

	it("worker with extra write root outside orchestrator fails", () => {
		const worker = { ...DEFAULT_SCOPE, allowedWriteRoots: ["/etc"] };
		strictEqual(isSubset(worker, DEFAULT_SCOPE), false);
	});

	it("worker with dispatch when orchestrator has none fails", () => {
		strictEqual(isSubset(DEFAULT_SCOPE, READONLY_SCOPE), false);
	});
});

describe("safety/loop-detector", () => {
	it("fresh state does not loop", () => {
		const state = createLoopState({ maxRepeats: 3, windowMs: 1000 });
		const [, verdict] = observe(state, "k", 0);
		strictEqual(verdict.looping, false);
		strictEqual(verdict.count, 1);
	});

	it("detects loop when threshold hit", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 1000 });
		state = observe(state, "k", 0)[0];
		state = observe(state, "k", 10)[0];
		const [, verdict] = observe(state, "k", 20);
		strictEqual(verdict.looping, true);
		strictEqual(verdict.count, 3);
	});

	it("trims events outside window", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 100 });
		state = observe(state, "k", 0)[0];
		state = observe(state, "k", 50)[0];
		const [, verdict] = observe(state, "k", 200);
		// first two events aged out, only current remains
		strictEqual(verdict.count, 1);
		strictEqual(verdict.looping, false);
	});

	it("different keys do not collide", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 1000 });
		state = observe(state, "a", 0)[0];
		state = observe(state, "b", 10)[0];
		const [, verdict] = observe(state, "a", 20);
		deepStrictEqual(verdict.count, 2);
		strictEqual(verdict.looping, false);
	});
});

describe("safety/protected-artifacts", () => {
	it("protects and unprotects without mutating input state and with deterministic ordering", () => {
		const initial: ProtectedArtifactState = {
			artifacts: [artifact("zeta/report.json"), artifact("alpha/report.json")],
		};

		const protectedState = protectArtifact(initial, artifact("middle/report.json"));

		notStrictEqual(protectedState, initial);
		notStrictEqual(protectedState.artifacts, initial.artifacts);
		deepStrictEqual(
			initial.artifacts.map((entry) => entry.path),
			["zeta/report.json", "alpha/report.json"],
		);
		deepStrictEqual(
			protectedState.artifacts.map((entry) => entry.path),
			["alpha/report.json", "middle/report.json", "zeta/report.json"],
		);

		const replaced = protectArtifact(
			protectedState,
			artifact("middle/report.json", { reason: "new validation", validationCommand: "npm test" }),
		);
		deepStrictEqual(
			replaced.artifacts.map((entry) => entry.path),
			["alpha/report.json", "middle/report.json", "zeta/report.json"],
		);
		strictEqual(replaced.artifacts[1]?.reason, "new validation");
		strictEqual(replaced.artifacts[1]?.validationCommand, "npm test");

		const unprotected = unprotectArtifact(replaced, "middle/report.json");
		deepStrictEqual(
			unprotected.artifacts.map((entry) => entry.path),
			["alpha/report.json", "zeta/report.json"],
		);
		deepStrictEqual(
			replaced.artifacts.map((entry) => entry.path),
			["alpha/report.json", "middle/report.json", "zeta/report.json"],
		);
	});

	it("protects exact paths and descendants only", () => {
		const state = protectArtifact({ artifacts: [] }, artifact("docs/release"));

		strictEqual(isProtectedPath(state, "docs/release"), true);
		strictEqual(isProtectedPath(state, "docs/release/notes.md"), true);
		strictEqual(isProtectedPath(state, "docs/releases"), false);
		strictEqual(isProtectedPath(state, "docs"), false);
	});

	it("detects common validation commands", () => {
		const commands = [
			["npm test", "npm test"],
			["npm run test -- --runInBand", "npm run test"],
			["pytest tests/unit", "pytest"],
			["python -m pytest tests", "python -m pytest"],
			["python3.12 -m pytest", "python -m pytest"],
			["cargo test", "cargo test"],
			["go test ./...", "go test"],
			["ctest --output-on-failure", "ctest"],
			["make test", "make test"],
			["ninja test", "ninja test"],
			["mvn test", "mvn test"],
			["gradle test", "gradle test"],
			["./gradlew test", "gradle test"],
		] as const;

		for (const [command, matched] of commands) {
			deepStrictEqual(detectValidationCommand(command), { kind: "validation", matched });
		}
		deepStrictEqual(detectValidationCommand("echo npm test"), { kind: "none" });
	});

	it("classifies destructive commands that affect protected artifacts", () => {
		const artifacts = [artifact("src/generated/report.json"), artifact("dist"), artifact("docs/release-notes.md")];
		const cases = [
			["rm -f src/generated/report.json", "rm"],
			["rm -rf src/generated", "rm"],
			["mv tmp/report.json src/generated/report.json", "mv"],
			["truncate -s 0 dist/output.txt", "truncate"],
			[": > src/generated/report.json", "redirect"],
			["> dist/output.txt", "redirect"],
			["cp tmp/report.json src/generated/report.json", "cp"],
			["git checkout -- src/generated/report.json", "git_checkout"],
			["git restore dist", "git_restore"],
			["git reset --hard HEAD", "git_reset_hard"],
			["find src/generated -name '*.json' -delete", "find_delete"],
		] as const;

		for (const [command, operation] of cases) {
			const classification = classifyDestructiveCommand(command, artifacts);
			strictEqual(classification.kind, "destructive", command);
			if (classification.kind === "destructive") {
				strictEqual(classification.operation, operation);
				strictEqual(classification.matches.length > 0, true);
			}
		}
	});

	it("does not classify benign commands as protected-artifact destructive", () => {
		const artifacts = [artifact("src/generated/report.json"), artifact("dist")];
		const benign = [
			"rm src/generated-report.json",
			"cp src/generated/report.json tmp/report-copy.json",
			"cat src/generated/report.json > tmp/report-copy.json",
			"grep -R report src/generated",
			"npm test",
		];

		for (const command of benign) {
			deepStrictEqual(classifyDestructiveCommand(command, artifacts), { kind: "benign", matches: [] }, command);
		}
	});
});

describe("safety/finish-contract", () => {
	it("allows a completion claim with recent validation evidence", () => {
		const assessment = assessFinishContract({
			assistantText: "Implemented the fix and the task is complete.",
			assistantTurnId: "assistant-1",
			sessionEntries: [
				messageEntry("user-1", "user", { text: "fix it" }),
				messageEntry("tool-call-1", "tool_call", {
					toolCallId: "call-1",
					name: "bash",
					args: { command: "npm test" },
				}),
				messageEntry("tool-result-1", "tool_result", {
					toolCallId: "call-1",
					toolName: "bash",
					result: { content: [{ type: "text", text: "passed" }], details: { kind: "ok" } },
					isError: false,
				}),
				messageEntry("assistant-1", "assistant", { text: "Implemented the fix and the task is complete." }),
			],
		});

		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "validation_evidence");
		deepStrictEqual(assessment.evidence, [
			{
				kind: "validation_command",
				summary: "validation command passed: npm test",
				turnId: "tool-call-1",
			},
		]);
	});

	it("allows a completion claim with protected artifact evidence", () => {
		const assessment = assessFinishContract({
			assistantText: "Changed the report and it is finished.",
			assistantTurnId: "assistant-1",
			sessionEntries: [
				messageEntry("user-1", "user", { text: "build the report" }),
				protectedArtifactEntry("protected-1", "dist/report.json"),
				messageEntry("assistant-1", "assistant", { text: "Changed the report and it is finished." }),
			],
		});

		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "validation_evidence");
		deepStrictEqual(assessment.evidence, [
			{
				kind: "protected_artifact",
				summary: "protected artifact recorded: dist/report.json",
				turnId: "protected-1",
			},
		]);
	});

	it("allows a completion claim with an explicit limitation", () => {
		const assessment = assessFinishContract({
			assistantText: "Changed: updated the parser.\nTests: not run, blocked by missing credentials.",
			assistantTurnId: "assistant-1",
			sessionEntries: [
				messageEntry("user-1", "user", { text: "fix parser" }),
				messageEntry("assistant-1", "assistant", {
					text: "Changed: updated the parser.\nTests: not run, blocked by missing credentials.",
				}),
			],
		});

		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "explicit_limitation");
		deepStrictEqual(assessment.evidence, []);
	});

	it("advises on a completion claim without evidence or limitation", () => {
		const assessment = assessFinishContract({
			assistantText: "Done, the fix is complete.",
			assistantTurnId: "assistant-1",
			sessionEntries: [
				messageEntry("user-1", "user", { text: "fix it" }),
				messageEntry("assistant-1", "assistant", { text: "Done, the fix is complete." }),
			],
		});

		deepStrictEqual(assessment, {
			kind: "advisory",
			message: FINISH_CONTRACT_ADVISORY_MESSAGE,
			evidence: [],
		});
	});

	it("does not advise on non-completion assistant text", () => {
		const assessment = assessFinishContract({
			assistantText: "I will inspect the project and run tests next.",
			assistantTurnId: "assistant-1",
			sessionEntries: [
				messageEntry("user-1", "user", { text: "fix it" }),
				messageEntry("assistant-1", "assistant", { text: "I will inspect the project and run tests next." }),
			],
		});

		deepStrictEqual(assessment, {
			kind: "ok",
			reason: "no_completion_claim",
			evidence: [],
		});
	});

	it("keeps advisory wording and evidence ordering deterministic", () => {
		const entries = [
			messageEntry("user-1", "user", { text: "finish it" }),
			protectedArtifactEntry("protected-b", "b.txt"),
			messageEntry("tool-call-1", "tool_call", {
				toolCallId: "call-1",
				name: "bash",
				args: { command: "npm run test -- --runInBand" },
			}),
			messageEntry("tool-result-1", "tool_result", {
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "passed" }], details: { kind: "ok" } },
				isError: false,
			}),
			protectedArtifactEntry("protected-a", "a.txt"),
			messageEntry("assistant-1", "assistant", { text: "Changed: complete." }),
		];

		const first = assessFinishContract({
			assistantText: "Changed: complete.",
			assistantTurnId: "assistant-1",
			sessionEntries: entries,
		});
		const second = assessFinishContract({
			assistantText: "Changed: complete.",
			assistantTurnId: "assistant-1",
			sessionEntries: entries,
		});

		deepStrictEqual(second, first);
		deepStrictEqual(
			first.evidence.map((item) => item.summary),
			[
				"protected artifact recorded: b.txt",
				"validation command passed: npm run test",
				"protected artifact recorded: a.txt",
			],
		);
		strictEqual(FINISH_CONTRACT_ADVISORY_MESSAGE.startsWith("[Clio Coder] finish-contract advisory:"), true);
	});
});

function artifact(path: string, overrides: Partial<ProtectedArtifact> = {}): ProtectedArtifact {
	const entry: ProtectedArtifact = {
		path,
		protectedAt: "2026-04-29T00:00:00.000Z",
		reason: "validated artifact",
		source: "validation",
	};
	if (overrides.path !== undefined) entry.path = overrides.path;
	if (overrides.protectedAt !== undefined) entry.protectedAt = overrides.protectedAt;
	if (overrides.reason !== undefined) entry.reason = overrides.reason;
	if (overrides.validationCommand !== undefined) entry.validationCommand = overrides.validationCommand;
	if (overrides.validationExitCode !== undefined) entry.validationExitCode = overrides.validationExitCode;
	if (overrides.source !== undefined) entry.source = overrides.source;
	return entry;
}

function messageEntry(turnId: string, role: string, payload: unknown): unknown {
	return {
		kind: "message",
		turnId,
		parentTurnId: null,
		timestamp: "2026-04-29T00:00:00.000Z",
		role,
		payload,
	};
}

function protectedArtifactEntry(turnId: string, artifactPath: string): unknown {
	return {
		kind: "protectedArtifact",
		turnId,
		parentTurnId: null,
		timestamp: "2026-04-29T00:00:00.000Z",
		action: "protect",
		artifact: {
			path: artifactPath,
			protectedAt: "2026-04-29T00:00:00.000Z",
			reason: "validation passed",
			source: "middleware",
		},
	};
}
