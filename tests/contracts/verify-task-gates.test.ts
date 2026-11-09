import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStatePath } from "../../src/core/xdg.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { clearTaskGates, configureTaskGates, extractTaskGates } from "../../src/tools/verify/task-gates.js";

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
		if (hung.kind === "error") match(hung.message, /timed out after 300ms/u);

		const widened = await verify("gate-1", { args: ["--extra"] });
		strictEqual(widened.kind === "error" && widened.details?.unresolved, true);
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

	it("admits an unrecognized gate unasked only inside a sandbox that writes nothing, else as bash would", () => {
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
});
