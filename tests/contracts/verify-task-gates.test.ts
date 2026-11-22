import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../../src/core/safe-exec.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import { configureWorkerProcessSandbox } from "../../src/core/sandbox/worker-process.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStatePath } from "../../src/core/xdg.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine, TASK_GATE_REFUSED_RULE_ID } from "../../src/domains/safety/policy-engine.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { renderToolPreview } from "../../src/interactive/renderers/tool-execution.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { createRegistry } from "../../src/tools/registry.js";
import { discoverDeclaredChecks } from "../../src/tools/verify/discovery.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import {
	clearTaskGates,
	configureTaskGates,
	configureWorkerTaskGates,
	contractDeclaresTaskGates,
	extractTaskGates,
	taskGateBounds,
	taskGateCheck,
} from "../../src/tools/verify/task-gates.js";

const roots: string[] = [];
const originalCwd = process.cwd();

/** A workspace with no declared or derivable checks, entered as a worker's cwd. */
function enter(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-task-gates-")));
	roots.push(root);
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
	process.chdir(root);
	return root;
}

afterEach(() => {
	clearTaskGates();
	process.chdir(originalCwd);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const verify = (check: string, extra: Record<string, unknown> = {}) => verifyTool.run({ check, ...extra });
const judgementOf = (result: Awaited<ReturnType<typeof verifyTool.run>>) =>
	(result.details?.judgement as { execution: string } | undefined)?.execution;

describe("verifier task gates", () => {
	it("reads plain commands from the task's inline code and refuses shell composition", () => {
		const { gates, rejected } = extractTaskGates(
			"Run `python3 bench/heat_check.py --plain` and `python3 -m pytest -q tests`, then `pytest`. " +
				"Do not touch `calc.py` or `calc.py --plain`; skip `make test && rm -rf build`, `curl https://x` and `FOO=1 make`.",
		);
		deepStrictEqual(
			gates.map((gate) => [gate.id, gate.command]),
			[
				["gate-1", ["python3", "bench/heat_check.py", "--plain"]],
				["gate-2", ["python3", "-m", "pytest", "-q", "tests"]],
				["gate-3", ["pytest"]],
			],
		);
		deepStrictEqual(
			rejected.map((entry) => entry.text),
			["make test && rm -rf build", "curl https://x", "FOO=1 make"],
		);
	});

	it("runs a declared gate by id or exact text and reports pass, fail and timeout with evidence", async () => {
		enter({
			"pass.js": "console.log('gate ok')\n",
			"fail.js": "console.error('gate broke'); process.exit(3)\n",
			"hang.js": "setInterval(() => {}, 1000)\n",
		});
		configureTaskGates("Run `node pass.js`, `node fail.js` and `node hang.js`. Change nothing.", { confined: false });

		const passed = await verify("gate-1", { timeout_ms: 10_000_000 });
		strictEqual(passed.kind, "ok");
		strictEqual(judgementOf(passed), "succeeded");
		deepStrictEqual(passed.details?.argv, ["node", "pass.js"]);
		// A model-supplied timeout is clamped to the gate ceiling.
		strictEqual(passed.details?.declaredTimeoutMs, 600_000);

		const failed = await verify("node fail.js");
		strictEqual(failed.kind, "error");
		strictEqual(judgementOf(failed), "failed");
		strictEqual(failed.details?.exitCode, 3);
		if (failed.kind === "error") match(failed.message, /gate broke/u);

		const hung = await verify("gate-3", { timeout_ms: 300 });
		strictEqual(judgementOf(hung), "timed-out");
		if (hung.kind === "error") match(hung.message, /timed out after 0\.3 s/u);

		const widened = await verify("gate-1", { args: ["--extra"] });
		strictEqual(widened.kind === "error" && widened.details?.unresolved, true);
	});

	it("runs a checker's `check:` task line as a verify check, inline source only in a worker sandbox that confines writes (M-42)", async () => {
		const root = enter({ "m.py": "def add(a, b):\n    return a + b\n" });
		const task = 'Without editing any file, verify m.add(1,1)==2.\ncheck: python3 -c "import m; print(m.add(1,1))"';
		ok(contractDeclaresTaskGates("debugger-report") && !contractDeclaresTaskGates("mutation-report"));
		deepStrictEqual(
			extractTaskGates(task).gates.map((gate) => gate.command),
			[["python3", "-c", "import m; print(m.add(1,1))"]],
		);
		// Prose is never scanned for commands; a marker that names no program is refused, not dropped.
		deepStrictEqual(extractTaskGates("Verify it by running python3 -c 'print(2)' and report.").gates, []);
		deepStrictEqual(
			extractTaskGates("check: calc.py --plain").rejected.map((entry) => entry.text),
			["calc.py --plain"],
		);
		const gateKind = (confined: boolean) => {
			configureTaskGates(task, { confined });
			return createSafetyPolicyEngine({ cwd: root }).evaluate({ tool: ToolNames.Verify, args: { check: "gate-1" } }).kind;
		};
		strictEqual(gateKind(false), "block");
		strictEqual(gateKind(true), "allow");
		const ran = await verify("gate-1");
		strictEqual(ran.kind, "ok", JSON.stringify(ran));
		if (ran.kind === "ok") match(ran.output, /\b2\b/u);
		// A no-edit checker's gate leaves no interpreter cache behind, so its observed delta stays empty.
		strictEqual(existsSync(join(root, "__pycache__")), false);

		// The default checker dispatch ({agent, task}, no write roots) runs in a sandbox that writes its workspace: the
		// gate takes the contained verdict main bash at default gives inline source. With no worker sandbox it is refused.
		const defaultGate = () => {
			configureWorkerTaskGates(task);
			return createSafetyPolicyEngine({ cwd: root }).evaluate({ tool: ToolNames.Verify, args: { check: "gate-1" } });
		};
		const spec = resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: root,
			writeBoundaries: [],
			network: false,
			dependencyRoots: [],
		});
		deepStrictEqual(spec?.writableRoots, [root]);
		configureWorkerProcessSandbox(spec, true);
		try {
			const contained = defaultGate();
			strictEqual(contained.kind, "allow", JSON.stringify(contained));
		} finally {
			configureWorkerProcessSandbox(undefined);
		}
		const unsandboxed = defaultGate();
		strictEqual(unsandboxed.kind, "block");
		strictEqual(unsandboxed.ruleId, TASK_GATE_REFUSED_RULE_ID);
	});

	it("lists the gates and tells a verifier it has no shell for anything else", async () => {
		enter({});
		configureTaskGates("Run `node pass.js` and `node a.js | tee log`.", { confined: false });
		const listed = await verifyTool.run({});
		strictEqual(listed.kind, "ok");
		if (listed.kind === "ok") {
			match(listed.output, /- gate-1: node pass\.js/u);
			match(listed.output, /not runnable: node a\.js \| tee log/u);
			ok(!/through bash/u.test(listed.output));
		}
		const other = await verify("python3 other.py");
		ok(other.kind === "error" && /no shell/u.test(other.message) && !/use bash/u.test(other.message));
	});

	it("admits an unrecognized gate unasked only inside a worker sandbox that confines writes, else as bash would", () => {
		const root = enter({});
		const headless = (confined: boolean, task = "Run `node check.js`.") => {
			configureTaskGates(task, { confined });
			const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({
				tool: ToolNames.Verify,
				args: { check: "gate-1" },
			});
			if (decision.kind !== "allow") return decision.kind;
			return mapAutonomy("default", decision.actionClass, {
				executeRecognized: decision.execRecognition !== "unrecognized",
			});
		};
		strictEqual(headless(true), "allow");
		strictEqual(headless(false), "ask");
		strictEqual(headless(false, "Run `pytest`."), "allow");
		configureTaskGates("Run `node check.js`.", { confined: false });
		const admitted = evaluateAdmission({
			principal: "worker",
			effects: [{ tool: ToolNames.Verify, args: { check: "gate-1" } }],
			safety: createWorkerSafety({ cwd: root }),
		});
		strictEqual(admitted.kind === "deny" && admitted.code, "task_gate");
	});

	it("judges a gate as bash would judge its argv, or stricter, and never lets a gate ask", () => {
		const root = enter({});
		const home = homedir();
		const rank = { allow: 0, ask: 1, block: 2 } as const;
		const yoloScope = { scratchRoots: [], scriptSandbox: "unsandboxed" as const };
		for (const command of [
			"unlink .git/index",
			`tee ${home}/.bashrc`,
			"npm install -g left-pad",
			"pip install --user requests",
			`touch ${home}/.config/autostart/x`,
		]) {
			for (const sandbox of [{ confined: false }, { confined: false, containable: true }, { confined: true }]) {
				configureTaskGates(`Run \`${command}\`.`, sandbox);
				const engine = createSafetyPolicyEngine({ cwd: root });
				for (const [posture, scope] of [
					[undefined, undefined],
					["yolo", yoloScope],
				] as const) {
					const bash = engine.evaluate({ tool: ToolNames.Bash, args: { command } }, posture, scope);
					const gate = engine.evaluate({ tool: ToolNames.Verify, args: { check: "gate-1" } }, posture, scope);
					ok(rank[gate.kind] >= rank[bash.kind], `${command}: gate ${gate.kind} is looser than bash ${bash.kind}`);
					notStrictEqual(gate.kind, "ask", `${command}: a gate asked`);
				}
				const admitted = evaluateAdmission({
					principal: "worker",
					effects: [{ tool: ToolNames.Verify, args: { check: "gate-1" } }],
					safety: createWorkerSafety({ cwd: root }),
				});
				notStrictEqual(admitted.kind, "ask", `${command}: worker admission asked`);
				notStrictEqual(admitted.kind, "allow", `${command}: worker admission allowed`);
			}
		}
	});

	it("runs an unrecognized gate that main bash would contain, inside that sandbox", async (t) => {
		const availability = sandboxAvailability();
		if (!availability.available || availability.backend !== "bwrap") {
			t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
			return;
		}
		const root = enter({ "w.py": "import sys\nopen(sys.argv[1], 'w').write('x')\n" });
		// Clio's state dir sits outside every root a contained command may write.
		mkdirSync(clioStatePath(), { recursive: true });
		const escaped = join(clioStatePath(), "ESCAPED");
		configureTaskGates(`Run \`python3 w.py inside.txt\` and \`python3 w.py ${escaped}\`.`, {
			confined: false,
			containable: true,
		});
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), principal: "worker" });
		registry.register(verifyTool);
		const inside = await registry.invoke({ tool: ToolNames.Verify, args: { check: "gate-1" } });
		const ran = (verdict: typeof inside) => (verdict.kind === "ok" ? verdict.result.kind : verdict.kind);
		strictEqual(ran(inside), "ok", JSON.stringify(inside));
		ok(existsSync(join(root, "inside.txt")));
		const outside = await registry.invoke({ tool: ToolNames.Verify, args: { check: "gate-2" } });
		strictEqual(ran(outside), "error", JSON.stringify(outside));
		if (outside.kind === "ok") match(JSON.stringify(outside.result), /Read-only file system/u);
		strictEqual(existsSync(escaped), false);

		configureTaskGates("Run `python3 w.py inside.txt`.", { confined: false, containable: false });
		const unsandboxed = await registry.invoke({ tool: ToolNames.Verify, args: { check: "gate-1" } });
		strictEqual(unsandboxed.kind, "blocked", JSON.stringify(unsandboxed));
	});

	it("a read-only worker runs a gate only inside a sandbox that writes nothing, else says unverified", async () => {
		const root = enter({});
		configureTaskGates("Run `node check.js`.", { confined: true });
		const safety = createWorkerSafety({ cwd: root });
		const call = { tool: ToolNames.Verify, args: { check: "gate-1" } };
		const admit = (confined: boolean) =>
			evaluateAdmission({
				principal: "worker",
				effects: [call],
				safety,
				constraints: { readOnly: true },
				...(confined ? { readOnlyShellConfined: true } : {}),
			});
		strictEqual(admit(true).kind, "allow");
		const refused = admit(false);
		strictEqual(refused.kind === "deny" && refused.code, "read_only");

		const ran: unknown[] = [];
		const registry = createRegistry({
			safety,
			principal: "worker",
			readOnly: true,
			readOnlyShellConfined: () => false,
		});
		registry.register({
			...verifyTool,
			run: async (args) => {
				ran.push(args);
				return { kind: "ok", output: "" };
			},
		});
		const verdict = await registry.invoke(call);
		strictEqual(verdict.kind, "blocked");
		if (verdict.kind === "blocked") match(verdict.reason, /unverified: no OS sandbox/u);
		deepStrictEqual(ran, []);
	});

	it("truncates passing verify output to max_output_bytes (head, marker, tail) without killing the check (XR-7)", async () => {
		const noisyPass = 'process.stdout.write("HEAD_START\\n" + "x".repeat(4000) + "\\nTAIL_SUMMARY\\n");\n';
		enter({
			"noisy-pass.js": noisyPass,
			"package.json": JSON.stringify({ name: "xr7-pass", scripts: { test: "node noisy-pass.js" } }),
		});
		configureTaskGates("Run `node noisy-pass.js`.", { confined: false });

		const gateResult = await verify("gate-1", { max_output_bytes: 500 });
		strictEqual(gateResult.kind, "ok");
		strictEqual(gateResult.details?.exitCode, 0);
		strictEqual(gateResult.details?.outputCapped, false);
		strictEqual(judgementOf(gateResult), "succeeded");
		if (gateResult.kind === "ok") {
			ok(Buffer.byteLength(gateResult.output, "utf8") <= 500);
			match(gateResult.output, /HEAD_START/u);
			match(gateResult.output, /\[\.\.\. \d+ bytes omitted \.\.\.\]/u);
			match(gateResult.output, /TAIL_SUMMARY/u);
		}

		clearTaskGates();
		const scriptResult = await verify("test", { max_output_bytes: 500 });
		strictEqual(scriptResult.kind, "ok");
		strictEqual(scriptResult.details?.exitCode, 0);
		strictEqual(scriptResult.details?.outputCapped, false);
		strictEqual(judgementOf(scriptResult), "succeeded");
		if (scriptResult.kind === "ok") {
			ok(Buffer.byteLength(scriptResult.output, "utf8") <= 500);
			match(scriptResult.output, /HEAD_START/u);
			match(scriptResult.output, /\[\.\.\. \d+ bytes omitted \.\.\.\]/u);
			match(scriptResult.output, /TAIL_SUMMARY/u);
		}
	});

	it("keeps a failing verify check's non-zero exit code when output exceeds max_output_bytes (XR-7)", async () => {
		enter({
			"noisy-fail.js":
				'process.stdout.write("HEAD_START\\n" + "y".repeat(4000) + "\\nTAIL_FAILURE\\n"); process.exit(3);\n',
		});
		configureTaskGates("Run `node noisy-fail.js`.", { confined: false });

		const failed = await verify("gate-1", { max_output_bytes: 500 });
		strictEqual(failed.kind, "error");
		strictEqual(failed.details?.exitCode, 3);
		strictEqual(failed.details?.outputCapped, false);
		strictEqual(judgementOf(failed), "failed");
		if (failed.kind === "error") {
			match(failed.message, /^verify: exited with code 3:/u);
			ok(!/output exceeded/u.test(failed.message));
			match(failed.message, /HEAD_START/u);
			match(failed.message, /\[\.\.\. \d+ bytes omitted \.\.\.\]/u);
			match(failed.message, /TAIL_FAILURE/u);
		}
	});

	it("names timed out after <N> s in result text and card head, and gives build gates a 300 s default deadline (CLI-P28)", async () => {
		enter({
			"hang-verbose.js": 'process.stdout.write("✓ Step 1\\n✓ Step 2\\n"); setTimeout(() => {}, 10_000);\n',
			"package.json": JSON.stringify({ name: "cli-p28", scripts: { build: "node hang-verbose.js", test: "node -e ''" } }),
		});
		configureTaskGates("Run `pnpm run build` and `node hang-verbose.js`.", { confined: false });

		const extracted = extractTaskGates("Run `pnpm run build` and `node hang-verbose.js`.");
		const buildGate = extracted.gates[0];
		const nonBuildGate = extracted.gates[1];
		ok(buildGate !== undefined && nonBuildGate !== undefined);
		strictEqual(taskGateCheck(buildGate).timeoutMs, 300_000);
		strictEqual(taskGateBounds({}, taskGateCheck(buildGate).timeoutMs).timeout_ms, 300_000);
		strictEqual(taskGateCheck(nonBuildGate).timeoutMs, SAFE_EXEC_DEFAULT_TIMEOUT_MS);
		strictEqual(SAFE_EXEC_DEFAULT_TIMEOUT_MS, 120_000);

		const discovered = discoverDeclaredChecks(undefined);
		strictEqual(discovered.ok, true);
		if (discovered.ok) {
			const checks = discovered.sources.flatMap((source) => source.checks);
			const pkgBuild = checks.find((entry) => entry.id === "build");
			const pkgTest = checks.find((entry) => entry.id === "test");
			strictEqual(pkgBuild?.timeoutMs, 300_000);
			strictEqual(pkgTest?.timeoutMs, SAFE_EXEC_DEFAULT_TIMEOUT_MS);
		}

		const timedOut = await verify("gate-2", { timeout_ms: 1_000 });
		strictEqual(timedOut.kind, "error");
		strictEqual(judgementOf(timedOut), "timed-out");
		strictEqual(timedOut.details?.timedOut, true);
		strictEqual(timedOut.details?.timeoutMs, 1_000);
		if (timedOut.kind === "error") {
			match(timedOut.message, /^verify: timed out after 1 s\b/u);
			// Render both with no details (main-agent thrown-error path) and with details.
			for (const result of [
				{ content: [{ type: "text", text: timedOut.message }] },
				{ content: [{ type: "text", text: timedOut.message }], details: timedOut.details },
			]) {
				const rows = renderToolPreview(
					{
						toolCallId: "v-timeout",
						toolName: "verify",
						args: { check: "build" },
						result,
						isError: true,
						durationMs: 1_000,
					},
					120,
					transcriptDetail("standard"),
				).map(stripTerminalSequences);
				match(rows[0] ?? "", /timed out after 1 s/u);
			}
		}
	});
});
