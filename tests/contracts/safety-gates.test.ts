import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { describeCallTarget } from "../../src/domains/safety/call-target.js";
import type { SafetyContract, SafetyDecision } from "../../src/domains/safety/contract.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import {
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	tokenizeShellLike,
} from "../../src/domains/safety/protected-artifacts.js";
import { redactSecretString } from "../../src/domains/safety/redaction.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { emitClaudeToolPermissionDecision } from "../../src/engine/claude/tool-safety.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry, type PermissionRequiredMeta } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("safety gate boundary", () => {
	let originalCwd: string;
	let scratch: string;
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-skill-authority-");
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-coder-safety-contract-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
		isolated.restore();
	});

	function engine(): SafetyPolicyEngine {
		return createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
	}

	function executionDisposition(
		policy: SafetyPolicyEngine,
		tool: string,
		args: Record<string, unknown>,
		level: "default" | "yolo",
	): string {
		const decision = policy.evaluate({ tool, args });
		return decision.kind === "allow"
			? mapAutonomy(level, decision.actionClass, { executeRecognized: decision.execRecognition !== "unrecognized" })
			: decision.kind;
	}

	it("hard-blocks zero-access paths before confirmation or ordinary ask rails", () => {
		const policy = engine();
		for (const call of [
			{ tool: ToolNames.Read, args: { path: ".env" } },
			{ tool: ToolNames.Write, args: { path: "credentials.yaml", content: "secret" } },
			{ tool: ToolNames.Bash, args: { command: ": > .env" } },
			{ tool: ToolNames.Bash, args: { command: "bash -o pipefail -c 'cat .env'" } },
			{ tool: ToolNames.Bash, args: { command: "echo ok && bash --norc -c 'cat .env'" } },
			{ tool: ToolNames.Bash, args: { command: "dash +o errexit -c 'cat .env'" } },
			{ tool: ToolNames.Bash, args: { command: "zsh -x -ec 'cat .env'" } },
		]) {
			strictEqual(policy.evaluate(call).kind, "block");
			strictEqual(policy.evaluate(call, "confirmed").kind, "block");
		}
		const secretRead = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cat ~/.ssh/id_rsa" } });
		strictEqual(secretRead.kind, "block");
		strictEqual(secretRead.reasonCode, "secret_path_bash");
	});

	it("admits only standalone git diff whitespace checks in default mode", () => {
		const policy = engine();
		for (const command of ["git diff --check", "git diff --cached --check"]) {
			const args = { command };
			const decision = policy.evaluate({ tool: ToolNames.Bash, args });
			strictEqual(decision.kind, "allow", command);
			strictEqual(decision.ruleId, "builtin:git-diff-check", command);
			strictEqual(decision.execRecognition, "recognized", command);
			strictEqual(executionDisposition(policy, ToolNames.Bash, args, "default"), "allow", command);
			strictEqual(executionDisposition(policy, ToolNames.Bash, args, "yolo"), "allow", command);
		}
		for (const command of [
			"git diff --check --ext-diff",
			"git diff --output=report.txt --check",
			"git diff --check --cached",
			"git diff --check | cat",
			"git diff --check && git status",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			strictEqual(decision.execRecognition, "unrecognized", command);
			strictEqual(executionDisposition(policy, ToolNames.Bash, { command }, "default"), "ask", command);
		}
		for (const command of ["git diff --check $(cat args)", "git diff --check `cat args`"]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "ask", command);
		}
		for (const command of ["git diff --check > .env", "git diff --check && cat ~/.ssh/id_rsa"]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "block", command);
		}
		strictEqual(executionDisposition(policy, ToolNames.Bash, { command: "npm run build" }, "default"), "ask");
	});

	it("recognizes only safe complete command chains inside the workspace", () => {
		const policy = engine();
		const admitted = policy.evaluate({
			tool: ToolNames.Bash,
			args: { command: "cd pkg && npm run build && git status" },
		});
		strictEqual(admitted.kind, "allow");
		strictEqual(
			policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd pkg && npm run build && git status" } }, "confirmed")
				.kind,
			"allow",
		);
		strictEqual(admitted.execRecognition, "unrecognized");
		strictEqual(
			executionDisposition(policy, ToolNames.Bash, { command: "cd pkg && npm run build && git status" }, "default"),
			"ask",
		);
		strictEqual(
			executionDisposition(policy, ToolNames.Bash, { command: "cd pkg && npm run build && git status" }, "yolo"),
			"allow",
		);
		// A test runner is recognized without confirmation (#377), so the same chain runs.
		const testChain = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd pkg && npm test && git status" } });
		strictEqual(testChain.kind, "allow");
		strictEqual(testChain.execRecognition, "recognized");

		for (const command of [
			"cd pkg && npm test && curl http://example.com",
			"npm test | tee output.txt",
			"cd pkg && npm test $(cat args)",
			"npm test '&&' git status",
		]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).execRecognition, "unrecognized");
		}
		strictEqual(
			policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd /etc && ls" } }).actionClass,
			"system_modify",
		);
		for (const command of ["npm run build 2>&1 | tail -30", "npm run lint > output.txt"]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
			strictEqual(executionDisposition(policy, ToolNames.Bash, { command }, "default"), "ask", command);
			strictEqual(executionDisposition(policy, ToolNames.Bash, { command }, "yolo"), "allow", command);
		}
		// A recognized runner piped into read-only inspection stays recognized.
		strictEqual(
			policy.evaluate({ tool: ToolNames.Bash, args: { command: "npm test 2>&1 | tail -30" } }).execRecognition,
			"recognized",
		);
	});

	it("tracks chain directories for scoped command admission and approval previews", () => {
		mkdirSync(join(scratch, "other/nested"), { recursive: true });
		mkdirSync(join(scratch, "pkg/nested"));
		writeFileSync(
			join(scratch, ".clio-coder/safety.yaml"),
			"version: 1\ncommands:\n  - id: pkg-check\n    command: custom-check\n    cwd: pkg\n    actionClass: execute\n",
		);
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ scripts: { build: "root-build" } }));
		writeFileSync(join(scratch, "pkg/package.json"), JSON.stringify({ scripts: { build: "pkg-build" } }));
		const policy = engine();
		for (const [command, cwd, recognition] of [
			["cd pkg && custom-check", ".", "recognized"],
			["cd ../other && custom-check", "pkg", "unrecognized"],
			["cd other && cd nested && custom-check", ".", "unrecognized"],
			["cd pkg && cd nested && custom-check", ".", "recognized"],
		] as const) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command, cwd } });
			strictEqual(decision.execRecognition, recognition, command);
			strictEqual(
				mapAutonomy("default", decision.actionClass, { executeRecognized: recognition === "recognized" }),
				recognition === "recognized" ? "allow" : "ask",
			);
		}
		const preview = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd pkg && npm run build" } });
		strictEqual(preview.kind, "allow");
		strictEqual(
			preview.reasons.some((reason) => reason.includes("build: pkg-build")),
			true,
		);
		strictEqual(
			preview.reasons.some((reason) => reason.includes("build: root-build")),
			false,
		);
	});

	it("admits destructive command quotations in task prose while blocking bash execution", () => {
		const policy = engine();
		const command = "rm -rf /";
		const prose = `Explain why ${command} is dangerous.`;
		for (const args of [
			{ task: prose },
			{ task: "Review safety", briefing: prose, persona: prose, intent: { goal: prose } },
			{ mode: "parallel", tasks: [{ task: prose, briefing: prose }] },
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Dispatch, args });
			strictEqual(decision.kind, "allow");
			strictEqual(decision.actionClass, "dispatch");
		}
		for (const args of [
			{ action: "plan", title: prose, tasks: [prose] },
			{ action: "done", id: "t1", note: prose },
		]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Tasks, args }).kind, "allow");
		}
		const destructive = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
		strictEqual(destructive.kind, "block");
		strictEqual(destructive.reasonCode, "damage-control:rm-rf-root");
	});

	it("protects verifier authority and scans catalog argv before execution", () => {
		const catalogPath = join(scratch, ".clio-coder", "verifiers.yaml");
		const policyPath = join(scratch, ".clio-coder", "safety.yaml");
		for (const path of [catalogPath, policyPath]) {
			const decision = engine().evaluate({ tool: ToolNames.Write, args: { path, content: "version: 1\n" } });
			strictEqual(decision.kind, "block");
			strictEqual(decision.reasonCode, "path-policy:readOnlyPaths");
		}

		writeFileSync(
			catalogPath,
			"version: 1\nchecks:\n  - id: wipe\n    description: unsafe\n    command: [rm, -rf, /]\n    cwd: .\n    timeoutMs: 10000\n    tags: [test]\n",
		);
		const destructive = engine().evaluate({ tool: ToolNames.Verify, args: { check: "wipe" } });
		strictEqual(destructive.kind, "block");
		strictEqual(destructive.reasonCode.startsWith("damage-control:"), true);
	});

	it("admits typed package verification in yolo after the command safety scan", () => {
		const policy = engine();
		for (const check of ["typecheck", "lint", "build"]) {
			const args = { check };
			const decision = policy.evaluate({ tool: ToolNames.Verify, args });
			strictEqual(decision.kind, "allow", check);
			strictEqual(decision.execRecognition, "unrecognized", check);
			strictEqual(executionDisposition(policy, ToolNames.Verify, args, "default"), "ask", check);
			strictEqual(executionDisposition(policy, ToolNames.Verify, args, "yolo"), "allow", check);
		}
	});

	it("asks for a policy-recognized outward command on native, Claude SDK and ACP admission (F4)", async () => {
		const command = "git push origin main";
		// In-memory project policy; the named safety.yaml is never written.
		const policy = createSafetyPolicyEngine({
			cwd: scratch,
			projectPolicy: {
				trustVerdict: "trusted",
				path: join(scratch, ".clio-coder", "safety.yaml"),
				hash: null,
				valid: true,
				errors: [],
				commands: [
					{
						id: "push-main",
						command,
						actionClass: "execute",
						shellOperators: "deny",
						env: { mode: "none", allow: [] },
						requireConfirmation: false,
					},
				],
				pathPolicy: {},
				disableDefaultPathPolicy: false,
			},
		});
		const safety: SafetyContract = {
			...createWorkerSafety({ cwd: scratch }),
			evaluate(call, posture): SafetyDecision {
				const decision = policy.evaluate(call, posture);
				strictEqual(decision.kind, "allow", call.tool);
				return { kind: "allow", classification: decision.classification, policy: decision };
			},
		};
		const net = safety.evaluate({ tool: ToolNames.Bash, args: { command } });
		strictEqual(net.classification.exposure, "outward");
		strictEqual(net.policy?.execRecognition, "recognized");

		const registry = createRegistry({ safety, autonomy: () => "default" });
		registry.register(bashTool);
		let nativeAsked = false;
		registry.onPermissionRequired((_call, _decision, meta) => {
			nativeAsked = true;
			registry.cancelParkedCall(meta.requestId, "contract: denied");
		});
		await registry.invoke({ tool: ToolNames.Bash, args: { command } });
		strictEqual(nativeAsked, true);

		const sdk = emitClaudeToolPermissionDecision({
			toolName: "Bash",
			input: { command },
			safety,
			cwd: scratch,
			emit: () => {},
		});
		strictEqual(sdk.kind, "deny");
		strictEqual(sdk.kind === "deny" && sdk.permissionRequired, true);

		const mediator = new AcpToolMediator({ safety, cwd: scratch, toolGovernance: "clio-coder-policy" });
		await mediator.handle({
			toolCall: { kind: "execute", rawInput: { command } },
			options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
		});
		const [entry] = mediator.snapshot().toolCallLog;
		strictEqual(entry?.decision, "denied");
		strictEqual(entry?.reason?.startsWith("permission_required: autonomy default"), true, entry?.reason);
	});

	it("gives native, Claude SDK and ACP workers one disposition per call through the shared admission evaluator", async () => {
		const outside = mkdtempSync(join(tmpdir(), "clio-coder-parity-outside-"));
		try {
			writeFileSync(join(outside, "notes.txt"), "outside\n");
			const outsidePath = join(outside, "notes.txt");
			// In-memory project policy recognizing an outward push; nothing is written or run.
			const outwardPolicy = createSafetyPolicyEngine({
				cwd: scratch,
				projectPolicy: {
					trustVerdict: "trusted",
					path: join(scratch, ".clio-coder", "safety.yaml"),
					hash: null,
					valid: true,
					errors: [],
					commands: [
						{
							id: "push-main",
							command: "git push origin main",
							actionClass: "execute",
							shellOperators: "deny",
							env: { mode: "none", allow: [] },
							requireConfirmation: false,
						},
					],
					pathPolicy: {},
					disableDefaultPathPolicy: false,
				},
			});
			const outwardSafety: SafetyContract = {
				...createWorkerSafety({ cwd: scratch }),
				evaluate(call, posture): SafetyDecision {
					const decision = outwardPolicy.evaluate(call, posture);
					if (decision.kind === "allow") return { kind: "allow", classification: decision.classification, policy: decision };
					const rejection = decision.rejection ?? { short: decision.reasonCode, detail: decision.reasonCode, hints: [] };
					return { kind: decision.kind, classification: decision.classification, rejection, policy: decision };
				},
			};
			type Disposition = "allow" | "ask" | "deny";
			interface ParityCase {
				name: string;
				safety: SafetyContract;
				allowedTools?: ReadonlyArray<string>;
				native: { tool: string; args: Record<string, unknown> };
				sdk: { toolName: string; input: Record<string, unknown> };
				acp: { kind: string; rawInput: Record<string, unknown> };
				expected: Disposition;
			}
			const rooted = createWorkerSafety({ cwd: scratch, writeRoots: [join(scratch, "pkg/")] });
			const cases: ParityCase[] = [
				{
					name: "read outside the workspace",
					safety: createWorkerSafety({ cwd: scratch }),
					native: { tool: ToolNames.Read, args: { path: outsidePath } },
					sdk: { toolName: "Read", input: { file_path: outsidePath } },
					acp: { kind: "read", rawInput: { path: outsidePath } },
					expected: "ask",
				},
				{
					name: "policy-recognized outward command",
					safety: outwardSafety,
					native: { tool: ToolNames.Bash, args: { command: "git push origin main" } },
					sdk: { toolName: "Bash", input: { command: "git push origin main" } },
					acp: { kind: "execute", rawInput: { command: "git push origin main" } },
					expected: "ask",
				},
				{
					name: "write-root escape",
					safety: rooted,
					native: { tool: ToolNames.Write, args: { path: join(scratch, "escape.txt"), content: "x" } },
					sdk: { toolName: "Write", input: { file_path: join(scratch, "escape.txt"), content: "x" } },
					acp: { kind: "edit", rawInput: { path: join(scratch, "escape.txt"), content: "x" } },
					expected: "deny",
				},
				{
					name: "tool outside the admitted surface",
					safety: createWorkerSafety({ cwd: scratch }),
					allowedTools: [ToolNames.Read],
					native: { tool: ToolNames.Bash, args: { command: "ls" } },
					sdk: { toolName: "Bash", input: { command: "ls" } },
					acp: { kind: "execute", rawInput: { command: "ls" } },
					expected: "deny",
				},
				{
					name: "damage-control operator rail",
					safety: createWorkerSafety({ cwd: scratch }),
					native: { tool: ToolNames.Bash, args: { command: "gcloud iam policies list" } },
					sdk: { toolName: "Bash", input: { command: "gcloud iam policies list" } },
					acp: { kind: "execute", rawInput: { command: "gcloud iam policies list" } },
					expected: "ask",
				},
			];
			for (const entry of cases) {
				const registry = createRegistry({ safety: entry.safety, principal: "worker", autonomy: () => "default" });
				for (const spec of [readTool, writeTool, bashTool]) {
					registry.register({ ...spec, run: async () => ({ kind: "ok", output: "stub" }) });
				}
				let parked = false;
				registry.onPermissionRequired((_call, _decision, meta) => {
					parked = true;
					registry.cancelParkedCall(meta.requestId, "contract: denied");
				});
				const verdict = await registry.invoke(
					entry.native,
					entry.allowedTools !== undefined ? { allowedTools: entry.allowedTools as never } : undefined,
				);
				const native: Disposition = parked ? "ask" : verdict.kind === "ok" ? "allow" : "deny";

				const sdkDecision = emitClaudeToolPermissionDecision({
					...entry.sdk,
					safety: entry.safety,
					cwd: scratch,
					emit: () => {},
					...(entry.allowedTools !== undefined ? { allowedTools: new Set(entry.allowedTools) } : {}),
				});
				const sdk: Disposition = sdkDecision.kind === "allow" ? "allow" : sdkDecision.permissionRequired ? "ask" : "deny";

				const mediator = new AcpToolMediator({
					safety: entry.safety,
					cwd: scratch,
					toolGovernance: "clio-coder-policy",
					...(entry.allowedTools !== undefined ? { allowedTools: entry.allowedTools } : {}),
				});
				await mediator.handle({
					toolCall: entry.acp,
					options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
				});
				const [logged] = mediator.snapshot().toolCallLog;
				const acp: Disposition =
					logged?.decision === "approved"
						? "allow"
						: logged?.reason?.startsWith("permission_required:") === true
							? "ask"
							: "deny";
				deepStrictEqual(
					{ native, sdk, acp },
					{ native: entry.expected, sdk: entry.expected, acp: entry.expected },
					entry.name,
				);
			}
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps a safety-net confirmation rail operator-only so a main-issued grant cannot clear it", async () => {
		const safety = createWorkerSafety({ cwd: scratch });
		const registry = createRegistry({ safety, principal: "worker", autonomy: () => "default" });
		let executed = 0;
		registry.register({
			...bashTool,
			run: async () => {
				executed += 1;
				return { kind: "ok", output: "stub" };
			},
		});
		const parks: Array<{ decision: SafetyDecision; meta: PermissionRequiredMeta }> = [];
		registry.onPermissionRequired((_call, decision, meta) => {
			parks.push({ decision, meta });
		});
		// Evaluated as data by a stub body; the command never runs.
		const rail = { tool: ToolNames.Bash, args: { command: "gcloud iam policies list" } };
		const pending = registry.invoke(rail);
		const [park] = parks;
		strictEqual(park?.meta.approvalAuthority, "operator");
		const actionClass = park.decision.classification.actionClass;
		await registry.resumeParkedCalls({
			actionClass,
			requestId: park.meta.requestId,
			requestedBy: "grant:main:contract",
			issuer: "main",
		});
		strictEqual(registry.parkedCount(), 1);
		strictEqual(executed, 0);
		const underMainGrant = evaluateAdmission({
			principal: "worker",
			effects: [rail],
			safety,
			authorization: { issuer: "main", actionClass },
		});
		strictEqual(underMainGrant.kind, "ask");
		strictEqual(underMainGrant.kind === "ask" && underMainGrant.approvalAuthority, "operator");

		// An ordinary worker autonomy ask is the only one a main grant discharges.
		const ordinary = { tool: ToolNames.Bash, args: { command: "frobnicate --all" } };
		const workerAsk = evaluateAdmission({ principal: "worker", effects: [ordinary], safety });
		strictEqual(workerAsk.kind === "ask" && `${workerAsk.source}:${workerAsk.approvalAuthority}`, "autonomy:main");
		const granted = evaluateAdmission({
			principal: "worker",
			effects: [ordinary],
			safety,
			authorization: { issuer: "main", actionClass: "execute" },
		});
		strictEqual(granted.kind, "allow");
		const mainAsk = evaluateAdmission({ principal: "main", effects: [ordinary], safety });
		strictEqual(mainAsk.kind === "ask" && mainAsk.approvalAuthority, "operator");

		await registry.resumeParkedCalls({ actionClass, requestId: park.meta.requestId, requestedBy: "tool:one_shot" });
		strictEqual((await pending).kind, "ok");
		strictEqual(executed, 1);
	});

	it("yolo clears ordinary confirmation rails while damage control still decides", () => {
		writeFileSync(
			join(scratch, ".clio-coder", "safety.yaml"),
			"version: 1\ncommands:\n  - id: approved-build\n    command: npm run build\n    actionClass: execute\n    requireConfirmation: true\n",
		);
		const policy = engine();
		const confirmed = policy.evaluate({ tool: ToolNames.Bash, args: { command: "npm run build" } });
		strictEqual(confirmed.kind, "ask");
		strictEqual(confirmed.reasonCode, "project-policy:approved-build");
		strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command: "npm run build" } }, "confirmed").kind, "allow");
		strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command: "npm run build" } }, "yolo").kind, "allow");
		for (const [command, kind] of [
			["npm run build $(cat args)", "allow"],
			["npm run build && sudo apt update", "allow"],
			["npm run build && rm -rf /", "block"],
			[`rm -rf a${"--token".repeat(3000)}`, "block"],
			["bash -o pipefail -c 'rm -rf /'", "block"],
			["bash -o pipefail -c 'echo x > /etc/passwd'", "block"],
			["bash --norc -c 'echo x > /etc/passwd'", "block"],
			["sh -e -c 'rm -rf /'", "block"],
			["bash --norc -c 'rm -rf /'", "block"],
			["bash --unknown -c 'echo ok'", "ask"],
			["bash -o", "ask"],
			["bash -c", "ask"],
			["npm run build && cat ~/.ssh/id_rsa", "block"],
			["npm run build && clio-coder library install skill:example --yes", "allow"],
			["gcloud iam policies", "ask"],
		] as const) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }, "yolo").kind, kind, command);
			if (command.length > 20_000) {
				strictEqual(redactSecretString(command), command);
				strictEqual(describeCallTarget(ToolNames.Bash, { command }), `${command.slice(0, 119)}…`);
			}
		}
	});

	it("yolo admits temporary Python analysis without parking while preserving safety rails (#407)", async () => {
		// A sibling of the workspace models /tmp analysis, including under the
		// isolated test harness. Stub execution: this contract tests admission,
		// not Python availability or a live model's ability to finish the task.
		const script = join(tmpdir(), "analysis.py");
		const calls = [
			{ tool: ToolNames.Write, args: { path: script, content: "print(1)\n" } },
			{ tool: ToolNames.Bash, args: { command: `python3 '${script}'`, cwd: scratch } },
			{ tool: ToolNames.Bash, args: { command: "python3 - <<'PY'\nprint(1)\nPY", cwd: scratch } },
			{ tool: ToolNames.Bash, args: { command: `cat > '${script}' <<'PY'\nprint(1)\nPY`, cwd: scratch } },
		];
		for (const level of ["default", "yolo"] as const) {
			const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch }), autonomy: () => level });
			let executed = 0;
			let approvals = 0;
			for (const spec of [writeTool, bashTool]) {
				registry.register({
					...spec,
					async run() {
						executed++;
						return { kind: "ok", output: "admitted" };
					},
				});
			}
			registry.onPermissionRequired((_call, _decision, meta) => {
				approvals++;
				registry.cancelParkedCall(meta.requestId, "No operator approval in this contract");
			});
			for (const call of calls) {
				strictEqual((await registry.invoke(call)).kind, level === "yolo" ? "ok" : "blocked", JSON.stringify(call));
			}
			strictEqual(executed, level === "yolo" ? calls.length : 0);
			strictEqual(approvals, level === "yolo" ? 0 : calls.length);

			const confirmation = await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "git restore .", cwd: scratch },
			});
			strictEqual(confirmation.kind, "blocked");
			strictEqual(approvals, level === "yolo" ? 1 : calls.length + 1);
			const blocked = await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "git reset --hard", cwd: scratch },
			});
			strictEqual(blocked.kind, "blocked");
			strictEqual(executed, level === "yolo" ? calls.length : 0);
			strictEqual(approvals, level === "yolo" ? 1 : calls.length + 1, "a hard block cannot become an approval");
			strictEqual(registry.hasParkedCalls(), false);
		}
	});

	it("blocks project and user skill writes and redirects in worker and orchestrator admissions", () => {
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		for (const skill of [".clio-coder/skills/x/SKILL.md", join(clioConfigDir(), "skills", "x", "SKILL.md")]) {
			for (const policy of [main, worker]) {
				for (const call of [
					{ tool: ToolNames.Write, args: { path: skill, content: "Model instructions." } },
					{ tool: ToolNames.Bash, args: { command: `echo instructions > '${skill}'` } },
				]) {
					strictEqual(policy.evaluate(call).kind, "block", JSON.stringify(call));
					strictEqual(policy.evaluate(call, "confirmed").kind, "block", JSON.stringify(call));
				}
			}
		}
	});

	it("protects active project and resolved user skills in main and worker admissions even without path defaults", () => {
		writeFileSync(join(scratch, ".clio-coder", "safety.yaml"), "version: 1\ndisableDefaultPathPolicy: true\n");
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		for (const root of [join(scratch, ".clio-coder", "skills"), join(clioConfigDir(), "skills")]) {
			const skill = join(root, "example", "SKILL.md");
			for (const policy of [main, worker]) {
				for (const call of [
					{ tool: ToolNames.Write, args: { path: skill, content: "changed" } },
					{ tool: ToolNames.Edit, args: { path: skill, oldText: "old", newText: "new" } },
					{ tool: ToolNames.Artifact, args: { path: skill, content: "changed", kind: "markdown" } },
					{ tool: ToolNames.Bash, args: { command: `rm -r '${root}'` } },
					{ tool: ToolNames.Bash, args: { command: `mv '${root}' draft` } },
					{ tool: ToolNames.Bash, args: { command: `cp draft '${skill}'` } },
				]) {
					strictEqual(policy.evaluate(call).kind, "block", JSON.stringify(call));
					strictEqual(policy.evaluate(call, "confirmed").kind, "block", JSON.stringify(call));
				}
				strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: skill } }).kind, "allow");
				strictEqual(
					policy.evaluate({ tool: ToolNames.Write, args: { path: "draft-skills/example/SKILL.md" } }).kind,
					"allow",
				);
			}
		}
	});

	it("refuses a yolo registry write without touching active bytes while allowing a draft", async () => {
		const target = join(scratch, ".clio-coder", "skills", "example", "SKILL.md");
		mkdirSync(join(scratch, ".clio-coder", "skills", "example"), { recursive: true });
		writeFileSync(target, "Operator instructions.\n");
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch }), autonomy: () => "yolo" });
		registry.register(writeTool);
		const denied = await registry.invoke({
			tool: ToolNames.Write,
			args: { path: target, content: "Model replacement." },
		});
		strictEqual(denied.kind, "blocked");
		strictEqual(readFileSync(target, "utf8"), "Operator instructions.\n");
		const draft = join(scratch, "draft-skills", "example", "SKILL.md");
		strictEqual(existsSync(draft), false);
		const written = await registry.invoke({
			tool: ToolNames.Write,
			args: { path: draft, content: "Proposed instructions.\n" },
		});
		strictEqual(written.kind, "ok");
		strictEqual(readFileSync(draft, "utf8"), "Proposed instructions.\n");
	});

	it("protects aliases, missing descendants, late symlinks, parent deletion and shell cwd changes", () => {
		const skills = join(scratch, ".clio-coder", "skills");
		const outside = join(scratch, "outside");
		mkdirSync(outside);
		const policy = engine();
		// The active root becomes a symlink after the policy was constructed.
		symlinkSync(outside, skills);
		symlinkSync(skills, join(scratch, "alias"));
		for (const target of [
			"alias/new/SKILL.md",
			"outside/new/SKILL.md",
			".clio-coder/skills/new/SKILL.md",
			".clio-coder/skills/..draft/SKILL.md",
		]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Write, args: { path: target } }).kind, "block", target);
		}
		for (const command of [
			"rm -r .clio-coder",
			"mv .clio-coder saved",
			"cd .clio-coder && rm -r skills",
			"sh -c 'cd .clio-coder && printf changed > skills/new/SKILL.md'",
			"bash -o pipefail -c 'echo x > .clio-coder/skills/new/SKILL.md'",
			"bash --norc -c 'echo x > .clio-coder/skills/new/SKILL.md'",
		])
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "block", command);
	});

	it("blocks model shell skill installation and updates while preserving inventory and draft validation", () => {
		const policy = engine();
		for (const command of [
			"clio-coder skills install ./draft-skills/example",
			"clio-coder --no-skills skills install example",
			"env CLIO_CODER_CONFIG_DIR=/tmp/elsewhere clio-coder skills update --all --force",
			"command clio-coder library install skill:example --yes",
			"sh -lc 'clio-coder skills install example --user'",
			"node /opt/clio-coder/dist/cli/index.js skills install example",
			"npx @iowarp/clio-coder skills install example",
			"npm exec -- clio-coder skills update example",
			"clio-coder plugins install ./draft-plugin --project",
			"clio-coder plugins update materio --force",
			"clio-coder plugins enable example",
			"clio-coder plugins pin example",
			"clio-coder extensions install ./draft-extension --user",
			"clio-coder library update plugin:example",
			"clio-coder library remove plugin:example",
			"clio-coder library pin plugin:example",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			strictEqual(decision.kind, command.includes(" library ") ? "ask" : "block", command);
			strictEqual(decision.reasonCode, command.includes(" library ") ? "library-confirm" : "skill-authority", command);
			if (command.includes(" library "))
				strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }, "confirmed").kind, "allow");
		}
		for (const command of [
			"clio-coder skills list",
			"clio-coder skills install --help",
			"clio-coder skills inspect example",
			"clio-coder skills validate draft-skills/example/SKILL.md",
			"clio-coder library list",
			"clio-coder plugins list --json",
			"clio-coder plugins inspect ./draft-plugin",
			"clio-coder plugins drift example",
			"clio-coder plugins install --help",
			"printf 'clio-coder skills install example'",
			"node script.js skills install example",
		])
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
	});

	it("guards canonical library mutations and approved interop adoption through wrappers", () => {
		for (const policy of [engine(), createWorkerSafety({ cwd: scratch })]) {
			for (const wrapper of [
				"clio-coder",
				"env X=1 clio-coder",
				"command clio-coder",
				"node /opt/clio-coder/dist/cli/index.js",
				"npx --yes @iowarp/clio-coder",
				"npm exec -- clio-coder",
			]) {
				for (const args of [
					"library install plugin:example",
					"library --kind skill install example --force",
					"library enable example",
					"library disable example --dry-run",
					"library update example",
					"library register ./package",
					"interop adopt claude-code --yes",
					"interop adopt claude-code --kind prompt --yes",
				]) {
					strictEqual(
						policy.evaluate({ tool: ToolNames.Bash, args: { command: `${wrapper} ${args}` } }).kind,
						args.startsWith("library ") ? "ask" : "block",
						`${wrapper} ${args}`,
					);
				}
				for (const args of [
					"library install example --dry-run",
					"library update example --dry-run",
					"library inspect example",
					"library drift example",
					"library install --help",
					"interop inspect claude-code",
					"interop adopt claude-code",
					"interop adopt claude-code --yes --dry-run",
				]) {
					strictEqual(
						policy.evaluate({ tool: ToolNames.Bash, args: { command: `${wrapper} ${args}` } }).kind,
						"allow",
						`${wrapper} ${args}`,
					);
				}
			}
		}
	});

	it("protects installed plugin and harness-extension content in main and worker tools", () => {
		for (const policy of [engine(), createWorkerSafety({ cwd: scratch })]) {
			for (const kind of ["plugins", "extensions"]) {
				for (const root of [join(scratch, ".clio-coder", kind), join(clioConfigDir(), kind)]) {
					strictEqual(
						policy.evaluate({ tool: ToolNames.Write, args: { path: join(root, "example", "tool.py"), content: "changed" } })
							.kind,
						"block",
					);
					strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command: `rm -rf '${root}'` } }).kind, "block");
				}
			}
		}
	});

	it("blocks every installed-skill update spelling with subcommand flags in main and worker admissions", () => {
		for (const policy of [engine(), createWorkerSafety({ cwd: scratch })]) {
			for (const command of [
				"clio-coder skills sync --force",
				"clio-coder skills --force sync",
				"clio-coder skills --user --name renamed install ./draft-skills/example",
				"clio-coder skills --all update --force",
				"clio-coder --all --help skills sync --force",
				"env CLIO_CODER_CONFIG_DIR=/tmp/elsewhere clio-coder skills sync --force",
				"command clio-coder skills sync",
				"sh -lc 'clio-coder skills sync --force'",
				"node /opt/clio-coder/dist/cli/index.js skills sync --force",
				"tsx /opt/clio-coder/src/cli/index.ts skills sync --force",
				"npx --yes @iowarp/clio-coder skills sync --force",
				"npm exec -- clio-coder skills sync --force",
			]) {
				const call = { tool: ToolNames.Bash, args: { command } };
				const decision = policy.evaluate(call);
				strictEqual(decision.kind, command.includes(" library ") ? "ask" : "block", command);
				strictEqual(
					"reasonCode" in decision ? decision.reasonCode : decision.policy?.reasonCode,
					command.includes(" library ") ? "library-confirm" : "skill-authority",
					command,
				);
				strictEqual(policy.evaluate(call, "confirmed").kind, command.includes(" library ") ? "allow" : "block", command);
			}
		}
	});

	it("requires approval for library installs and their dependencies, then accepts confirmation", () => {
		for (const policy of [engine(), createWorkerSafety({ cwd: scratch })]) {
			for (const command of [
				"clio-coder library install skill:example --yes",
				"clio-coder library --yes install skill:example",
				"clio-coder library --from ./catalog.json --yes install example",
				"clio-coder library install agent:example --with-requirements --yes",
				"clio-coder library --with-requirements install fleet:example --yes",
				"clio-coder library install prompt:example --yes --with-requirements",
				"clio-coder library install skill:example --from --help --yes",
				"env CLIO_CODER_CONFIG_DIR=/tmp/elsewhere clio-coder library install skill:example --yes",
				"command clio-coder library install skill:example --yes",
				"sh -lc 'clio-coder library install skill:example --yes'",
				"node /opt/clio-coder/dist/cli/index.js library install skill:example --yes",
				"npx --yes @iowarp/clio-coder library install skill:example --yes",
				"npm exec -- clio-coder library install skill:example --yes",
			]) {
				const call = { tool: ToolNames.Bash, args: { command } };
				const decision = policy.evaluate(call);
				strictEqual(decision.kind, command.includes(" library ") ? "ask" : "block", command);
				strictEqual(
					"reasonCode" in decision ? decision.reasonCode : decision.policy?.reasonCode,
					command.includes(" library ") ? "library-confirm" : "skill-authority",
					command,
				);
				strictEqual(policy.evaluate(call, "confirmed").kind, command.includes(" library ") ? "allow" : "block", command);
			}
		}
	});

	it("never lets a library command bypass direct instruction or credential protections", () => {
		const policy = engine();
		for (const command of [
			"clio-coder library install skill:example && rm -r .clio-coder/skills",
			"clio-coder library install skill:example && cat ~/.ssh/id_rsa",
			"clio-coder library install skill:example && clio-coder skills sync --force",
		]) {
			const call = { tool: ToolNames.Bash, args: { command } };
			strictEqual(policy.evaluate(call).kind, "block");
			strictEqual(policy.evaluate(call, "confirmed").kind, "block");
		}
	});

	it("preserves library discovery and dry-run plans through the same CLI wrappers", () => {
		const policy = engine();
		for (const command of [
			"clio-coder --help skills sync --force",
			"clio-coder --no-skills --help skills sync --force",
			"clio-coder skills sync -v",
			"clio-coder skills sync --help",
			"clio-coder skills --json inventory",
			"clio-coder library search example --kind skill --json",
			"clio-coder library use skill example",
			"clio-coder library install --dry-run skill:example --json",
			"clio-coder library --from ./catalog.json install --dry-run skill:example --with-requirements",
			"clio-coder library install --dry-run agent:example --with-requirements",
			"clio-coder library install --dry-run skill:example --from --yes",
			"clio-coder library install --dry-run skill:example --yes --help",
			"env CLIO_CODER_CONFIG_DIR=/tmp/elsewhere clio-coder library list",
			"command clio-coder library install --dry-run skill:example",
			"sh -lc 'clio-coder library install --dry-run skill:example --with-requirements'",
			"node /opt/clio-coder/dist/cli/index.js library install --dry-run skill:example --json",
			"npx --yes @iowarp/clio-coder library install --dry-run skill:example",
			"npm exec -- clio-coder library search example",
		])
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
	});

	function shellArgv(command: string, program: "clio-coder" | "rm" | "cp" | "sed" | "grep" = "clio-coder"): string[] {
		// Capture literal Bash argv on a separate descriptor even when the tested
		// command redirects stdout. This function never runs the actual CLI.
		const result = spawnSync(
			"bash",
			["--noprofile", "--norc", "-c", `${program}() { printf '%s\\0' "$@" >&3; }\n${command}`],
			{
				cwd: scratch,
				env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
				stdio: ["ignore", "pipe", "pipe", "pipe"],
			},
		);
		strictEqual(result.status, 0, result.stderr?.toString());
		return result.output[3]?.toString().split("\0").slice(0, -1) ?? [];
	}

	it("ignores commented help and version text without losing later literal skill mutations", () => {
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		for (const [command, argv] of [
			["clio-coder skills sync --force # --help", ["skills", "sync", "--force"]],
			["clio-coder skills sync --force # -v", ["skills", "sync", "--force"]],
			["clio-coder library install skill:example --yes # --help", ["library", "install", "skill:example", "--yes"]],
			["clio-coder library install skill:example --yes # --version", ["library", "install", "skill:example", "--yes"]],
			["# --help\nclio-coder skills sync --force # -v", ["skills", "sync", "--force"]],
			["clio-coder skills --help # comment\nclio-coder skills sync", ["skills", "--help", "skills", "sync"]],
			[
				"clio-coder library install 'skill:example#suffix' --yes # --help",
				["library", "install", "skill:example#suffix", "--yes"],
			],
		] as const) {
			deepStrictEqual(shellArgv(command), argv, command);
			for (const policy of [main, worker]) {
				const call = { tool: ToolNames.Bash, args: { command } };
				const decision = policy.evaluate(call);
				strictEqual(decision.kind, command.includes(" library ") ? "ask" : "block", command);
				strictEqual(
					"reasonCode" in decision ? decision.reasonCode : decision.policy?.reasonCode,
					command.includes(" library ") ? "library-confirm" : "skill-authority",
					command,
				);
				strictEqual(policy.evaluate(call, "confirmed").kind, command.includes(" library ") ? "allow" : "block", command);
			}
		}
	});

	it("reads help from CLI words rather than redirections or another shell command", () => {
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		for (const [command, argv] of [
			["clio-coder skills sync --force > --help", ["skills", "sync", "--force"]],
			["clio-coder library > --version install skill:example --yes", ["library", "install", "skill:example", "--yes"]],
			["2> --help clio-coder skills sync --force", ["skills", "sync", "--force"]],
			["clio-coder skills sy\\\nnc --force", ["skills", "sync", "--force"]],
			["clio-coder skills sync & clio-coder --help; wait", null],
		] as const) {
			const actual = shellArgv(command);
			if (argv !== null) deepStrictEqual(actual, argv, command);
			else strictEqual(actual.includes("sync"), true, command);
			for (const policy of [main, worker]) {
				const call = { tool: ToolNames.Bash, args: { command } };
				const decision = policy.evaluate(call);
				strictEqual(decision.kind, command.includes(" library ") ? "ask" : "block", command);
				strictEqual(
					"reasonCode" in decision ? decision.reasonCode : decision.policy?.reasonCode,
					command.includes(" library ") ? "library-confirm" : "skill-authority",
					command,
				);
				strictEqual(policy.evaluate(call, "confirmed").kind, command.includes(" library ") ? "allow" : "block", command);
			}
		}
	});

	it("preserves real help arguments following quoted, escaped and embedded hash words", () => {
		const policy = engine();
		for (const command of [
			"clio-coder skills sync '#' --help",
			"clio-coder skills sync \\# --help",
			"clio-coder skills sync ''#suffix --help",
			"clio-coder skills sync x#suffix --help",
			"clio-coder skills sync '|' --help",
			"clio-coder skills sync ';' --help",
			"clio-coder skills sync '>' --help",
			"clio-coder skills sync --help # harmless comment",
		]) {
			strictEqual(shellArgv(command).includes("--help"), true, command);
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
		}
		const command = 'clio-coder "" \'\' "\\#" "--he\\lp" \\# word#suffix # dropped\n';
		deepStrictEqual(tokenizeShellLike(command), ["clio-coder", ...shellArgv(command), ";"]);
	});

	it("keeps compound redirects to active skills blocked while allowing descriptor duplication on reads", () => {
		for (const policy of [engine(), createWorkerSafety({ cwd: scratch })]) {
			for (const operator of ["&>", "&>>", ">|", "<>", ">&"]) {
				const command = `printf changed ${operator} .clio-coder/skills/example/SKILL.md`;
				strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "block", command);
			}
			const command = "cd .clio-coder/skills && cat example/SKILL.md 2>&1";
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
		}
	});

	it("keeps quoted shell syntax as path operands before protected rm, cp and sed destinations", () => {
		const target = ".clio-coder/skills/example/SKILL.md";
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		for (const literal of ["&", "&&", "||", "|", ";", ">", ">>", "&>", ">&"]) {
			for (const quoted of [`'${literal}'`, literal.replace(/[&|;<>]/gu, "\\$&")]) {
				for (const [program, command, expected] of [
					["rm", `rm ${quoted} ${target}`, [literal, target]],
					["cp", `cp ${quoted} ${target}`, [literal, target]],
					["sed", `sed -i -e 's/old/new/' ${quoted} ${target}`, ["-i", "-e", "s/old/new/", literal, target]],
				] as const) {
					deepStrictEqual(shellArgv(command, program), expected, command);
					const targets = program === "rm" ? extractCommandDeleteTargets(command) : extractCommandWriteTargets(command);
					strictEqual(targets.includes(target), true, command);
					for (const policy of [main, worker]) {
						const call = { tool: ToolNames.Bash, args: { command } };
						strictEqual(policy.evaluate(call).kind, "block", command);
						strictEqual(policy.evaluate(call, "confirmed").kind, command.includes(" library ") ? "allow" : "block", command);
					}
				}
			}
		}
	});

	it("allows quoted and escaped grep patterns that are not actual redirect operators", () => {
		const target = ".clio-coder/skills/example/SKILL.md";
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		const protectedWorker = createWorkerSafety({
			cwd: scratch,
			protectedArtifactState: {
				artifacts: [{ path: target, protectedAt: "2026-09-05T00:00:00Z", reason: "fixture", source: "user" }],
			},
		});
		for (const literal of ["&", "&&", "||", "|", ";", ">", ">>", "&>", ">&", "<>"]) {
			for (const quoted of [`'${literal}'`, literal.replace(/[&|;<>]/gu, "\\$&")]) {
				const command = `grep -F ${quoted} ${target}`;
				deepStrictEqual(shellArgv(command, "grep"), ["-F", literal, target], command);
				deepStrictEqual(extractCommandWriteTargets(command), [], command);
				for (const policy of [main, worker, protectedWorker])
					strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
			}
		}
	});

	it("protects literal ampersand filenames under a shell cwd without treating them as descriptors", () => {
		mkdirSync(join(scratch, ".clio-coder", "skills"));
		const command = "cd .clio-coder/skills && rm '&'";
		deepStrictEqual(shellArgv(command, "rm"), ["&"]);
		deepStrictEqual(extractCommandDeleteTargets(command), ["&"]);
		for (const policy of [engine(), createWorkerSafety({ cwd: scratch })])
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "block", command);
	});

	it("retains literal Git path operands and actual redirects in observed run effects", () => {
		const recorder = createRunEffectsRecorder(scratch);
		recorder.start("quoted-git-paths", ToolNames.Bash, {
			command: "git rm '|' kept.txt > output.log && git rm '>&' second.txt",
		});
		recorder.finish("quoted-git-paths", false);
		const effects = recorder.snapshot();
		deepStrictEqual(
			[...effects.mutatedPaths].sort(),
			["|", "kept.txt", "output.log", ">&", "second.txt"].map((name) => join(scratch, name)).sort(),
		);
		strictEqual(effects.writeRecordComplete, false);
	});

	it("keeps destructive transitions blocked while allowing explicit one-shot rails once", () => {
		const policy = engine();
		for (const command of ["git push --force origin main", "find . -name '*.log' -delete", "shred -u key.txt"]) {
			const call = { tool: ToolNames.Bash, args: { command } };
			strictEqual(policy.evaluate(call).kind, "block", command);
			strictEqual(policy.evaluate(call, "confirmed").kind, command.includes(" library ") ? "allow" : "block", command);
		}
		for (const command of ["git stash drop", "truncate -s 0 server.log"]) {
			const call = { tool: ToolNames.Bash, args: { command } };
			strictEqual(policy.evaluate(call).kind, "ask", command);
			strictEqual(policy.evaluate(call, "confirmed").kind, "allow", command);
		}
		strictEqual(mapAutonomy("yolo", "git_destructive"), "deny");
		strictEqual(mapAutonomy("default", "unknown"), "ask");
		strictEqual(mapAutonomy("yolo", "unknown"), "allow");
		strictEqual(mapAutonomy("default", "system_modify"), "ask");
		strictEqual(mapAutonomy("yolo", "system_modify"), "allow");
	});

	it("fails execution closed under an invalid project policy without blocking normal reads", () => {
		writeFileSync(join(scratch, ".clio-coder", "safety.yaml"), "version: 1\nzeroAccessPaths:\n  - /etc\n");
		const policy = engine();
		strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command: "npm test" } }).kind, "block");
		strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: ".env" } }).kind, "block");
		strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: "notes.txt" } }).kind, "allow");
	});

	function writeInspectionFixture(): void {
		mkdirSync(join(scratch, "src"), { recursive: true });
		for (const file of ["package.json", "README.md", "a.txt", "src/a.js", "src/duration.js"]) {
			writeFileSync(join(scratch, file), "// TODO\n");
		}
	}

	it("never recognizes read-only shell forms that expand, execute, recurse or follow links", () => {
		writeInspectionFixture();
		const policy = engine();
		for (const command of [
			"cat ~akougkas/.ssh/id_rsa",
			"cat {~,x}/.aws/credentials",
			"cat $'\\x2fetc/passwd'",
			"cat .e*",
			"cat .e*''",
			"cat .[e]nv",
			"cat .e{n,n}v",
			"cat <(touch pwn)",
			"echo hi | cat >(touch x)",
			"grep -r API_KEY .",
			"grep -rn API_KEY .",
			"grep -d recurse API_KEY .",
			"grep --directories=recurse x .",
			"sort --out=o.txt a.txt",
			"tail --fo a.txt",
			"file --compil",
			"find -L . -name x",
			"tree -l",
			"du -L .",
			"ls --dereference",
			"ls -L && cat a.txt",
			"rg x",
			"rg x src/",
			"rg -e x .",
			"cat a.txt | rg -f p",
			"sh -c 'cat .env'",
			"sh -c 'cat a.txt && cat key.pem'",
			"cd li? && cat passwd",
			"sort --files0-from=list",
			"wc --files0-from=list",
			"wc --files0=list",
			"du --files0-from=list",
			"file -f.env",
			"grep -f.env a.txt",
			"grep -nf.env a.txt",
			"rg -f.env a.txt",
			"diff -rN sub .",
			"jq -n env",
			"ls /etc",
			"ls ..",
			"ls -R",
			"ls --recursive",
			"git grep --open-f=x x",
			"git grep SECRET",
			"git blame -S /proc/self/environ a.txt",
			"git blame --ignore-revs-file=/proc/self/environ a.txt",
			"git blame --cont /etc/hosts a.txt",
			"git cat-file --batch-all-objects --batch",
			"git diff --outp=o.txt",
			"git ls-files -X /etc/passwd",
			"git ls-files --exclude-f=/etc/passwd",
			"git log -- /etc/passwd",
			"git -C .. log",
			"git -C /etc log",
			"git -C ~ log",
			'git -C "$HOME" log',
			"git -C s* log",
			"git -C src grep x",
			"git -C src blame a.js",
			"git -C src cat-file -p HEAD",
			"git -C . -c core.pager=x log",
			"git -c core.pager=x -C . log",
			"git -C . --git-dir=/etc log",
			"git --git-dir=.git log",
			"git --work-tree=. status",
			"git -C . log -- /etc/passwd",
			'cat "a b/../.env"',
			"cat a\\ b/../.env",
			'sed -n 1p "a b/../.env"',
			"printf -v PATH bin && cat a.txt",
			"printf -nv PATH bin && cat a.txt",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			strictEqual(decision.execRecognition !== "recognized", true, command);
		}
	});

	it("keeps everyday read-only openers recognized", () => {
		writeInspectionFixture();
		const policy = engine();
		for (const command of [
			"ls src/ && cat package.json",
			'find . -name "*.test.js" -o -name "*.spec.js" | head -5',
			"ls -la && find src test | head",
			"ls; cat README.md; git log --oneline -3",
			"cat package.json 2>/dev/null",
			"npm test 2>&1 | tail -30",
			"grep -n TODO src/duration.js | wc -l",
			"sed -n '1,20p' src/duration.js",
			"git log --oneline | head -3",
			'cd pkg && git branch -a && echo "---X---" && git status && cat ../src/a.js',
			"git log | rg foo",
			"rg -n TODO src/a.js",
			"git -C . status",
			`git -C ${scratch} log --oneline -5`,
			"git -C src log --oneline -5",
			"git -C pkg -C .. status",
			"git -C src diff -- a.js",
			"cd pkg && git -C .. log --oneline -3",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			strictEqual(decision.execRecognition, "recognized", command);
		}
	});

	it("holds git -C to the workspace even where an exempt read root is readable", () => {
		// A repository under an exempt root carries a .git/config the operator never
		// vetted, and Git runs its core.fsmonitor and core.pager on inspection.
		const exempt = mkdtempSync(join(tmpdir(), "clio-coder-safety-exempt-"));
		try {
			writeFileSync(join(exempt, "dep.js"), "// dep\n");
			const policy = createSafetyPolicyEngine({
				cwd: scratch,
				projectPolicy: loadProjectSafetyPolicy(scratch),
				readExemptRoots: [exempt],
			});
			strictEqual(
				policy.evaluate({ tool: ToolNames.Bash, args: { command: `cat ${exempt}/dep.js` } }).execRecognition,
				"recognized",
				"the exempt root is readable",
			);
			for (const command of [`git -C ${exempt} log`, `git -C ${exempt} status`]) {
				const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
				strictEqual(decision.execRecognition !== "recognized", true, command);
			}
		} finally {
			rmSync(exempt, { recursive: true, force: true });
		}
	});

	it("keeps /etc and /var system roots where macOS lands them, under /private", () => {
		// A write is classified where it lands, and on macOS /etc and /var are
		// links into /private, so a workspace opened in /etc there is /private/etc.
		process.chdir("/etc");
		deepStrictEqual(classify({ tool: ToolNames.Write, args: { path: "clio.conf" } }), {
			actionClass: "system_modify",
			reasons: [`write-path-system-root: ${realpathSync("/etc")}`],
		});
		for (const [target, root] of [
			["/private/etc/hosts", "/private/etc"],
			["/private/var/log/clio.log", "/private/var"],
		]) {
			deepStrictEqual(classify({ tool: ToolNames.Write, args: { path: target } }).reasons, [
				`write-path-system-root: ${root}`,
			]);
		}
		// The scratch trees stay carved out under their canonical names too.
		for (const target of ["/private/var/folders/ab/T/clio/x.txt", "/private/var/tmp/clio/x.txt"]) {
			deepStrictEqual(classify({ tool: ToolNames.Write, args: { path: target } }).reasons, [
				`write-path-outside-cwd: ${target}`,
			]);
		}
	});
});
