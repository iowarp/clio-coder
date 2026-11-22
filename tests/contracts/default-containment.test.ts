import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { AUTONOMY_HELP } from "../../src/core/settings-awareness.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import { PLAYWRIGHT_CORE_VERSION, resolveBrowserComponent } from "../../src/domains/lifecycle/browser-component.js";
import { componentInstallDir } from "../../src/domains/lifecycle/components.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { ActionClass, ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { denialLines } from "../../src/domains/safety/denial.js";
import { createEscapeScopeLedger, ESCAPE_SCOPE_CUSTOM_TYPE } from "../../src/domains/safety/escape-scope.js";
import { EMPTY_INFORMATION_FLOW_INPUT } from "../../src/domains/safety/information-flow.js";
import { isSameOrDescendant } from "../../src/domains/safety/path-policy.js";
import {
	createSafetyPolicyEngine,
	type OperatorDefaultScope,
	type OperatorYoloScope,
} from "../../src/domains/safety/policy-engine.js";
import {
	createSafetyJudge,
	operatorOnlyAsk,
	resolveSafetyJudgeConfig,
	type SafetyJudgeSubject,
} from "../../src/domains/safety/safety-judge.js";
import { asksToLeaveSandbox } from "../../src/domains/safety/sandbox-escape.js";
import { effectiveScratchRoots } from "../../src/domains/safety/scratch-roots.js";
import {
	createWorkspaceSnapshots,
	type WorkspaceSnapshotOutcome,
} from "../../src/domains/workspace-snapshots/store.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createAskUserTool } from "../../src/tools/ask-user.js";
import { bashTool } from "../../src/tools/bash.js";
import { createBrowserTool } from "../../src/tools/browser/index.js";
import {
	browserOutwardHosts,
	browserToolSurface,
	browserUngrantedEndpoint,
	grantBrowserEndpoint,
	grantBrowserHosts,
} from "../../src/tools/browser/surface.js";
import { editTool } from "../../src/tools/edit.js";
import {
	createRegistry,
	type PermissionRequiredMeta,
	type RegistryDeps,
	type ToolSpec,
} from "../../src/tools/registry.js";
import { createRunScriptTool } from "../../src/tools/run-script.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { loopSafety } from "../harness/loop-guard.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function workspace(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const bash = (command: string, extra: Record<string, unknown> = {}): ClassifierCall => ({
	tool: ToolNames.Bash,
	args: { command, ...extra },
});

/**
 * The main session's registry at autonomy default with the containment the
 * orchestrator wires, a judge seat that records what it was asked to review
 * and then gives no verdict, and a bash body that records how it was run.
 * With no permission listener an unjudged ask is denied, never run.
 */
function defaultSession(
	cwd: string,
	containment: { sandbox: boolean; snapshots: boolean },
	extra: Partial<RegistryDeps> = {},
) {
	const reviewed: SafetyJudgeSubject[] = [];
	const order: string[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => containment,
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
		...extra,
	});
	const ran: Array<{ command: string; sandboxed: boolean }> = [];
	registry.register({
		...bashTool,
		run: async (args, options) => {
			order.push("body");
			ran.push({ command: String(args.command), sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	return { registry, ran, reviewed, order };
}

const reviewedCommands = (reviewed: SafetyJudgeSubject[]) => reviewed.map((subject) => String(subject.args?.command));

test("a contained unrecognized command and a named script run at default without an ask, in the sandbox", async () => {
	const cwd = workspace("clio-contained-run-");
	writeFileSync(join(cwd, "x.sh"), "echo hi\n");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	for (const command of ["make bench", "bash x.sh"]) {
		strictEqual((await session.registry.invoke(bash(command))).kind, "ok", command);
	}
	deepStrictEqual(session.ran, [
		{ command: "make bench", sandboxed: true },
		{ command: "bash x.sh", sandboxed: true },
	]);
	deepStrictEqual(session.reviewed, []);
});

test("unsandboxed: true and an outward call leave containment and reach the safety judge", async () => {
	const cwd = workspace("clio-contained-leave-");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	for (const call of [bash("make bench", { unsandboxed: true }), bash("git push origin main"), bash("gh pr create")]) {
		strictEqual((await session.registry.invoke(call)).kind, "blocked", JSON.stringify(call.args));
	}
	deepStrictEqual(session.ran, []);
	deepStrictEqual(reviewedCommands(session.reviewed), ["make bench", "git push origin main", "gh pr create"]);
	for (const subject of session.reviewed) strictEqual(operatorOnlyAsk(subject), null, String(subject.args?.command));
});

test("a verify check that runs a command is contained at default like bash; listing runs nothing and is not", async (t) => {
	const cwd = workspace("clio-contained-verify-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	// verify resolves its checks in the process's working directory, as the main session runs it.
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	const checks: Array<{ check: unknown; sandboxed: boolean }> = [];
	session.registry.register({
		...verifyTool,
		run: async (args, options) => {
			checks.push({ check: args.check, sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	for (const args of [{ check: "test" }, {}]) {
		const verdict = await session.registry.invoke({ tool: ToolNames.Verify, args });
		strictEqual(verdict.kind, "ok", JSON.stringify(args));
	}
	deepStrictEqual(checks, [
		{ check: "test", sandboxed: true },
		{ check: undefined, sandboxed: false },
	]);
	deepStrictEqual(session.reviewed, []);
});

test("every browser op is contained at default like bash; a host beyond loopback asks before the page reaches it", async (t) => {
	const home = await isolateClioEnv("clio-contained-browser-home-");
	t.after(() => home.restore());
	// A provisioned component, so only the host rule can ask.
	const pkg = join(componentInstallDir("browser", PLAYWRIGHT_CORE_VERSION), "node_modules", "playwright-core");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), "");
	mkdirSync(join(pkg, "..", "..", "browsers", "chromium_headless_shell-1"), { recursive: true });
	const session = defaultSession(workspace("clio-contained-browser-"), { sandbox: true, snapshots: false });
	const ran: Array<{ op: unknown; sandboxed: boolean }> = [];
	session.registry.register({
		...browserToolSurface,
		run: async (args, options) => {
			ran.push({ op: args.op, sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	for (const args of [
		{ op: "open", url: "http://127.0.0.1:5173/" },
		{ op: "run", script: "await page.click('#save')" },
		{ op: "look" },
		{ op: "serve", command: "npm run dev", ready: "http://127.0.0.1:5173/" },
		// Hermetic reaches loopback only: no host to ask for, and the body refuses this one plainly.
		{ op: "open", url: "https://example.com/", hermetic: true },
	]) {
		strictEqual((await session.registry.invoke({ tool: ToolNames.Browser, args })).kind, "ok", JSON.stringify(args));
	}
	const outward = await session.registry.invoke({
		tool: ToolNames.Browser,
		args: { op: "open", url: "https://example.com/" },
	});
	strictEqual(outward.kind, "blocked");
	deepStrictEqual(ran, [
		{ op: "open", sandboxed: true },
		{ op: "run", sandboxed: true },
		{ op: "look", sandboxed: true },
		{ op: "serve", sandboxed: true },
		{ op: "open", sandboxed: true },
	]);
});

test("a browser host granted beyond loopback lasts for its session: another session, or a switch back, asks again", async (t) => {
	const home = await isolateClioEnv("clio-contained-browser-grant-");
	t.after(() => home.restore());
	const pkg = join(componentInstallDir("browser", PLAYWRIGHT_CORE_VERSION), "node_modules", "playwright-core");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), "");
	mkdirSync(join(pkg, "..", "..", "browsers", "chromium_headless_shell-1"), { recursive: true });
	const { registry } = defaultSession(
		workspace("clio-contained-browser-grant-"),
		{ sandbox: true, snapshots: false },
		{ operatorAttends: () => true },
	);
	// The body's own first step: grant the hosts admission just confirmed.
	registry.register({
		...browserToolSurface,
		run: async (args, options) => {
			grantBrowserHosts(options?.sessionId, browserOutwardHosts(args, options?.sessionId));
			return { kind: "ok", output: "" };
		},
	});
	const cards: Array<{ requestId: string; actionClass: ActionClass }> = [];
	registry.onPermissionRequired((_call, decision, meta) =>
		cards.push({ requestId: meta.requestId, actionClass: decision.classification.actionClass }),
	);
	const openIn = async (sessionId: string) => {
		const before = cards.length;
		const pending = registry.invoke(
			{ tool: ToolNames.Browser, args: { op: "open", url: "https://docs.example.org/guide" } },
			{ sessionId },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const card = cards.length > before ? cards.at(-1) : undefined;
		if (card) await registry.resumeParkedCalls({ ...card, requestedBy: "contract-operator" });
		return { sessionId, asked: card !== undefined, kind: (await pending).kind };
	};
	deepStrictEqual(
		[await openIn("A"), await openIn("A"), await openIn("B"), await openIn("A")],
		[
			{ sessionId: "A", asked: true, kind: "ok" },
			{ sessionId: "A", asked: false, kind: "ok" },
			{ sessionId: "B", asked: true, kind: "ok" },
			{ sessionId: "A", asked: true, kind: "ok" },
		],
	);
});

test("a browser attach asks once per CDP endpoint per session, whatever spelling names it", async (t) => {
	const home = await isolateClioEnv("clio-contained-browser-attach-");
	t.after(() => home.restore());
	const pkg = join(componentInstallDir("browser", PLAYWRIGHT_CORE_VERSION), "node_modules", "playwright-core");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), "");
	mkdirSync(join(pkg, "..", "..", "browsers", "chromium_headless_shell-1"), { recursive: true });
	const { registry } = defaultSession(
		workspace("clio-contained-browser-attach-"),
		{ sandbox: true, snapshots: false },
		{ operatorAttends: () => true },
	);
	registry.register({
		...browserToolSurface,
		run: async (args, options) => {
			const grant = browserUngrantedEndpoint(args, options?.sessionId);
			if (grant !== undefined) grantBrowserEndpoint(options?.sessionId, grant);
			return { kind: "ok", output: "" };
		},
	});
	const cards: Array<{ requestId: string; actionClass: ActionClass; ruleId: string | undefined }> = [];
	registry.onPermissionRequired((_call, decision, meta) =>
		cards.push({
			requestId: meta.requestId,
			actionClass: decision.classification.actionClass,
			ruleId: decision.kind === "ask" ? decision.confirmationRuleId : undefined,
		}),
	);
	const attachIn = async (sessionId: string, endpoint: string) => {
		const before = cards.length;
		const pending = registry.invoke({ tool: ToolNames.Browser, args: { op: "attach", endpoint } }, { sessionId });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const card = cards.length > before ? cards.at(-1) : undefined;
		if (card) await registry.resumeParkedCalls({ ...card, requestedBy: "contract-operator" });
		return { endpoint, asked: card?.ruleId ?? false, kind: (await pending).kind };
	};
	deepStrictEqual(
		[
			await attachIn("A", "9222"),
			await attachIn("A", "http://127.0.0.1:9222/json/version"),
			await attachIn("A", "127.0.0.1:9339"),
			await attachIn("B", "9222"),
		],
		[
			{ endpoint: "9222", asked: "browser-attach-endpoint", kind: "ok" },
			{ endpoint: "http://127.0.0.1:9222/json/version", asked: false, kind: "ok" },
			{ endpoint: "127.0.0.1:9339", asked: "browser-attach-endpoint", kind: "ok" },
			{ endpoint: "9222", asked: "browser-attach-endpoint", kind: "ok" },
		],
	);
});

test("a browser page reaches loopback and granted hosts only: every redirect hop is checked and only http(s) loads", async (t) => {
	const home = await isolateClioEnv("clio-browser-reach-home-");
	t.after(() => home.restore());
	// A real Chromium: the operator's installed component, read-only, named by CLIO_CODER_OPERATOR_COMPONENTS_DIR.
	if (resolveBrowserComponent() === null) {
		t.skip("no browser component: set CLIO_CODER_OPERATOR_COMPONENTS_DIR to an installed components directory");
		return;
	}
	// A host that is not loopback but answers here, so an unchecked redirect hop would load it.
	const outward =
		Object.values(networkInterfaces())
			.flat()
			.find((a) => a?.family === "IPv4" && !a.internal)?.address ?? "ungranted.invalid";
	let port = 0;
	let secretHits = 0;
	const server = createServer((req, res) => {
		if (req.url === "/hop") {
			res.writeHead(302, { location: `http://${outward}:${port}/secret` }).end();
			return;
		}
		if (req.url === "/secret") secretHits++;
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<title>${req.url === "/secret" ? "SECRET PAGE" : "home"}</title><p>page</p>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
	t.after(() => server.close());
	port = (server.address() as AddressInfo).port;
	const dir = workspace("clio-browser-reach-");
	const secretFile = join(dir, "secret.txt");
	writeFileSync(secretFile, "FILE-SECRET-CONTENT");
	const tool = createBrowserTool({ getWorkspaceRoot: () => dir });
	t.after(() => tool.closeSessions());
	const call = async (args: Record<string, unknown>) => {
		const result = await tool.run(args, { sessionId: "browser-reach" });
		return { kind: result.kind, text: result.kind === "ok" ? result.output : "message" in result ? result.message : "" };
	};

	const hop = await call({ op: "open", url: `http://127.0.0.1:${port}/hop` });
	strictEqual(hop.kind, "error", hop.text);
	match(hop.text, new RegExp(`blocked: ${outward.replace(/\./gu, "\\.")} not granted to this browser session`, "u"));
	ok(!hop.text.includes("SECRET PAGE"), hop.text);
	strictEqual(secretHits, 0);

	const fileUrl = pathToFileURL(secretFile).href;
	const opened = await call({ op: "open", url: fileUrl });
	strictEqual(opened.kind, "error", opened.text);
	match(opened.text, /only http and https URLs load/u);
	ok(!opened.text.includes("FILE-SECRET-CONTENT"), opened.text);
	const page = await call({ op: "open", url: `http://127.0.0.1:${port}/` });
	strictEqual(page.kind, "ok", page.text);
	const routed = await call({
		op: "run",
		script: `return await page.goto(${JSON.stringify(fileUrl)}).then(() => "loaded", () => "refused");`,
	});
	match(routed.text, /value: "refused"[\s\S]*blocked: file: URLs do not load/u);
	ok(!routed.text.includes("FILE-SECRET-CONTENT"), routed.text);

	if (outward === "ungranted.invalid") return;
	const granted = await call({ op: "open", url: `http://127.0.0.1:${port}/hop`, allow_hosts: [outward] });
	strictEqual(granted.kind, "ok", granted.text);
	match(granted.text, /title: SECRET PAGE/u);
	strictEqual(secretHits, 1);
});

// ob-yolo Q7: a recognized command with unsandboxed: true ran unconfined at default with no review.
test("unsandboxed: true asks at default even for a recognized command; the judge decides it first", async (t) => {
	const cwd = workspace("clio-contained-escape-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	writeFileSync(join(cwd, "x.sh"), "echo hi\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const escapes: ClassifierCall[] = [
		bash("npm test", { unsandboxed: true }),
		{ tool: ToolNames.Verify, args: { check: "test", unsandboxed: true } },
		{ tool: ToolNames.RunScript, args: { interpreter: "bash", script: "x.sh", unsandboxed: true } },
	];
	const session = (verdict: "skip" | "allow") => {
		const ran: Array<{ tool: string; sandboxed: boolean }> = [];
		const recorder = (spec: ToolSpec): ToolSpec => ({
			...spec,
			run: async (_args, options) => {
				ran.push({ tool: spec.name, sandboxed: options?.shellSandbox !== undefined });
				return { kind: "ok" as const, output: "" };
			},
		});
		const judge = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{
				safetyJudge: {
					review: () =>
						verdict === "skip"
							? { kind: "skip" }
							: { kind: "allow", rule: "operator-named", reason: "the operator asked for it", build: "t", latencyMs: 0 },
					operatorApproved: () => {},
				},
			},
		);
		for (const spec of [bashTool, verifyTool, createRunScriptTool({ getWorkspaceRoot: () => cwd })])
			judge.registry.register(recorder(spec));
		return { registry: judge.registry, ran };
	};
	const unjudged = session("skip");
	for (const call of escapes) {
		const verdict = await unjudged.registry.invoke(call);
		strictEqual(verdict.kind, "blocked", call.tool);
		strictEqual(verdict.decision.policy?.reasonCode, "sandbox-escape", call.tool);
	}
	strictEqual(unjudged.ran.length, 0);
	// The same calls without the flag run contained with no ask.
	for (const call of escapes) {
		const { unsandboxed: _, ...args } = call.args ?? {};
		strictEqual((await unjudged.registry.invoke({ tool: call.tool, args })).kind, "ok", call.tool);
	}
	deepStrictEqual(
		unjudged.ran.map((entry) => entry.sandboxed),
		[true, true, true],
	);
	const allowed = session("allow");
	for (const call of escapes) strictEqual((await allowed.registry.invoke(call)).kind, "ok", call.tool);
	deepStrictEqual(
		allowed.ran.map((entry) => entry.sandboxed),
		[false, false, false],
	);
});

// ob-yolo batch7: a judge allowed npm test unsandboxed as task-local on a repository file's say-so.
// ob-yolo batch8: a judge cited operator-named for it when the operator had only asked to fix the tests.
test("a sandbox escape runs only when the judge finds the operator named it and they did", async (t) => {
	const cwd = workspace("clio-escape-named-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const escapes = [bash("npm test", { unsandboxed: true }), bash("rm -rf build", { unsandboxed: true })];
	const session = (rule: string, operator = "fix the tests, running them outside the sandbox") => {
		const ran: boolean[] = [];
		const reviewed: SafetyJudgeSubject[] = [];
		const judge = createSafetyJudge({
			config: () => ({ enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] }),
			complete: async () => ({ text: JSON.stringify({ verdict: "allow", rule, reason: "serves the task" }) }),
			operatorMessages: () => [operator],
			session: () => "s",
			consequences: () => [],
		});
		const { registry } = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{
				safetyJudge: {
					review: (subject) => {
						reviewed.push(subject);
						return judge.review(subject);
					},
					operatorApproved: () => {},
				},
			},
		);
		registry.register({
			...bashTool,
			run: async (_args, options) => {
				ran.push(options?.shellSandbox !== undefined);
				return { kind: "ok" as const, output: "" };
			},
		});
		return { registry, ran, reviewed };
	};
	const inferred = session("task-local");
	for (const call of escapes) {
		const verdict = await inferred.registry.invoke(call);
		strictEqual(verdict.kind, "blocked", String(call.args?.command));
	}
	deepStrictEqual(inferred.ran, []);
	// The delete asks under its own rule; the escape rides along as a reason.
	deepStrictEqual(
		inferred.reviewed.map((subject) => [subject.decision.policy?.ruleId, asksToLeaveSandbox(subject.decision)]),
		[
			["sandbox-escape", true],
			["delete-without-snapshot", true],
		],
	);
	const misread = session("operator-named", "The tests fail. Fix calc.js so npm test passes.");
	for (const call of escapes)
		strictEqual((await misread.registry.invoke(call)).kind, "blocked", String(call.args?.command));
	deepStrictEqual(misread.ran, []);
	const named = session("operator-named");
	for (const call of escapes) strictEqual((await named.registry.invoke(call)).kind, "ok", String(call.args?.command));
	deepStrictEqual(named.ran, [false, false]);
});

// bt-21: a shell write to an outside path the operator named was blocked, and no approval card ever appeared.
test("a blocked escape whose outside target the operator named goes to the approval card, never runs on its own", async (t) => {
	const cwd = workspace("clio-escape-target-");
	const outside = workspace("clio-escape-outside-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const named = join(outside, "log.txt");
	const session = (attends: boolean) => {
		const judge = createSafetyJudge({
			config: () => ({ enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] }),
			complete: async () => ({
				text: JSON.stringify({ verdict: "block", rule: "unsandboxed", reason: "No message asks to leave the sandbox." }),
			}),
			operatorMessages: () => [`Append the line \`median fixed\` to ${named} using a shell command.`],
			session: () => "s",
			consequences: () => [],
		});
		const { registry, ran } = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{ safetyJudge: judge, operatorAttends: () => attends },
		);
		const cards: Array<{ requestId: string; gateReason?: string }> = [];
		registry.onPermissionRequired((_call, _decision, meta) => cards.push(meta));
		return { registry, ran, cards };
	};
	const append = (target: string) => bash(`printf '%s\\n' 'median fixed' >> ${target}`, { unsandboxed: true });

	const attended = session(true);
	const pending = attended.registry.invoke(append(named));
	await new Promise((resolve) => setTimeout(resolve, 20));
	strictEqual(attended.cards.length, 1);
	match(attended.cards[0]?.gateReason ?? "", /would block this sandbox escape \(rule unsandboxed\).*name its target/u);
	attended.registry.cancelParkedCall(attended.cards[0]?.requestId ?? "", "denied", { denied: true });
	strictEqual((await pending).kind, "blocked");
	deepStrictEqual(attended.ran, []);
	// A path the operator never named stays the judge's block, as does a run with nobody to answer.
	const unnamed = await attended.registry.invoke(append(join(outside, "other.txt")));
	strictEqual(unnamed.kind, "blocked");
	if (unnamed.kind === "blocked") match(unnamed.reason, /safety judge blocked this bash call/u);
	const headless = session(false);
	const refused = await headless.registry.invoke(append(named));
	strictEqual(refused.kind, "blocked");
	if (refused.kind === "blocked") match(refused.reason, /safety judge blocked this bash call/u);
	deepStrictEqual([...attended.ran, ...headless.ran, ...headless.cards], []);
	strictEqual(attended.cards.length, 1);
});

test("with no sandbox backend the default rails still ask", async () => {
	const cwd = workspace("clio-contained-none-");
	const session = defaultSession(cwd, { sandbox: false, snapshots: false });
	strictEqual((await session.registry.invoke(bash("make bench"))).kind, "blocked");
	deepStrictEqual(session.ran, []);
	deepStrictEqual(reviewedCommands(session.reviewed), ["make bench"]);
});

test("git reset --hard runs after its snapshot, is refused without one, and asks when snapshots are off", async () => {
	const cwd = workspace("clio-contained-reset-");
	const taken = (order: string[]) => async (): Promise<WorkspaceSnapshotOutcome> => {
		order.push("snapshot");
		return { kind: "taken", record: {} as never, reused: false, durationMs: 0 };
	};
	const order: string[] = [];
	const snapshotted = defaultSession(cwd, { sandbox: true, snapshots: true }, { workspaceSnapshot: taken(order) });
	strictEqual((await snapshotted.registry.invoke(bash("git reset --hard"))).kind, "ok");
	deepStrictEqual([...order, ...snapshotted.order], ["snapshot", "body"]);
	deepStrictEqual(snapshotted.reviewed, []);

	const failed = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: async () => ({ kind: "unavailable", reason: "git timed out", durationMs: 0 }) },
	);
	const refused = await failed.registry.invoke(bash("git reset --hard"));
	strictEqual(refused.kind === "blocked" && refused.decision.policy?.reasonCode, "snapshot-required");
	deepStrictEqual(failed.ran, []);

	const off = defaultSession(cwd, { sandbox: true, snapshots: false });
	strictEqual((await off.registry.invoke(bash("git reset --hard"))).kind, "blocked");
	deepStrictEqual(off.ran, []);
	deepStrictEqual(reviewedCommands(off.reviewed), ["git reset --hard"]);
});

test("a recoverable stash drop is refused when its snapshot cannot pin the stash", async () => {
	const cwd = workspace("clio-contained-pins-");
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", ...args], { cwd, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(cwd, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "init");
	writeFileSync(join(cwd, "a.txt"), "two\n");
	git("stash", "push", "-q");
	// A ref where the pin directory belongs fails every pin write; the files snapshot still lands.
	git("update-ref", "refs/clio-coder/snapshots/s-1/pins", "HEAD");
	const snapshots = createWorkspaceSnapshots({
		stateDir: workspace("clio-contained-pins-state-"),
		sessionId: "s-1",
		cwd,
	});
	const session = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: (request) => snapshots.snapshot(request) },
	);
	const refused = await session.registry.invoke(bash("git stash drop"));
	strictEqual(refused.kind === "blocked" && refused.decision.policy?.reasonCode, "snapshot-required");
	match(refused.kind === "blocked" ? refused.reason : "", /could not pin the stash/);
	deepStrictEqual(session.ran, []);
	strictEqual(snapshots.list().length, 1);
});

// N3: a scratch-root delete was journaled snapshot-recoverable, though no workspace snapshot covers a scratch root.
test("a lone delete inside a scratch root runs as scratch-disposable and needs no workspace snapshot", async () => {
	const cwd = workspace("clio-contained-scratch-rm-ws-");
	const scratch = workspace("clio-contained-scratch-rm-");
	const session = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: async () => ({ kind: "unavailable", reason: "git timed out", durationMs: 0 }) },
	);
	const ran = await session.registry.invoke(bash(`rm -rf ${join(scratch, "build")}`));
	strictEqual(ran.kind, "ok", JSON.stringify(ran));
	const policy = ran.kind === "ok" ? ran.decision.policy : undefined;
	strictEqual(policy?.reasonCode, "scratch-disposable");
	strictEqual(policy?.recoverable, undefined);
	deepStrictEqual(session.reviewed, []);
});

// cw-5: a lane's rm under its own $TMPDIR was refused as destroy-data; the judge was never told the scratch roots.
test("the judge reads the session's workspace and scratch roots by path, and a delete escaping them by its real target", async (t) => {
	const cwd = workspace("clio-judge-roots-ws-");
	const temp = workspace("clio-judge-roots-tmp-");
	// Every temp tree is a scratch root, and the escape target must be in none of them, so it
	// lives in the checkout's gitignored tmp/ rather than under tmpdir() (FX-8).
	const parent = fileURLToPath(new URL("../../tmp/", import.meta.url));
	const madeParent = !existsSync(parent);
	mkdirSync(parent, { recursive: true });
	const outside = realpathSync(mkdtempSync(join(parent, "clio-judge-roots-out-")));
	symlinkSync(outside, join(temp, "link"));
	const saved = { cwd: process.cwd(), tmp: process.env.TMPDIR };
	process.env.TMPDIR = temp;
	process.chdir(cwd);
	t.after(() => {
		process.chdir(saved.cwd);
		if (saved.tmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved.tmp;
		rmSync(outside, { recursive: true, force: true });
		if (madeParent) rmdirSync(parent);
	});
	const holder = effectiveScratchRoots(DEFAULT_SETTINGS.safety.scratchRoots, cwd).find((root) =>
		isSameOrDescendant(outside, root),
	);
	if (holder !== undefined) {
		t.skip(`the checkout lies in scratch root ${holder}, so no escape target outside every scratch root exists`);
		return;
	}
	const prompts: Array<{ system: string; user: string }> = [];
	const judge = createSafetyJudge({
		config: () => ({ ...resolveSafetyJudgeConfig(DEFAULT_SETTINGS, cwd), target: "local" }),
		complete: async ({ system, user }) => {
			prompts.push({ system, user });
			return { text: JSON.stringify({ verdict: "allow", rule: "scratch", reason: "inside a scratch root" }) };
		},
		operatorMessages: () => ["remove your scratch files when done"],
		session: () => "s",
		consequences: () => [],
	});
	const { registry } = defaultSession(cwd, { sandbox: false, snapshots: false }, { safetyJudge: judge });
	for (const command of [`rm -rf ${temp}/sub`, `rm -rf "$TMPDIR/sub"`, `rm -rf ${temp}/link/`]) {
		strictEqual((await registry.invoke(bash(command))).kind, "ok", command);
	}
	strictEqual(prompts.length, 3);
	const system = prompts[0]?.system ?? "";
	ok(system.includes(`The workspace is ${cwd}.`), system);
	ok(system.includes(`- ${temp} (this process's temp directory, $TMPDIR)`), system);
	match(system, /strictly inside a scratch root is the scratch allow rule, never destroy-data/u);
	deepStrictEqual(new Set(prompts.map((prompt) => prompt.system)).size, 1);
	ok(prompts[2]?.user.includes(`delete-path-outside-workspace: ${outside}`), prompts[2]?.user);
});

test("a force push asks at default instead of being refused, and the floor still refuses", () => {
	const cwd = workspace("clio-contained-resort-");
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const push = admit(bash("git push --force origin main"));
	strictEqual(push.kind === "ask" && push.approvalAuthority, "operator");
	strictEqual(push.decision.policy?.reasonCode, "damage-control:git-push-force-main");
	// Without the operator's scope (a worker, a grant, a command job) it stays a hard block.
	strictEqual(
		evaluateAdmission({ principal: "main", effects: [bash("git push --force origin main")], safety }).kind,
		"deny",
	);
	const floor = admit(bash("rm -rf ~"));
	strictEqual(floor.kind === "deny" && floor.decision.policy?.reasonCode, "yolo-floor:rm-home-or-root");
});

test("reads of Clio's credential store are floor at default and at yolo", async (t) => {
	const home = await isolateClioEnv("clio-contained-credentials-");
	t.after(() => home.restore());
	const store = join(clioConfigDir(), "credentials.yaml");
	mkdirSync(clioConfigDir(), { recursive: true });
	writeFileSync(store, "openai: x\n");
	const engine = createSafetyPolicyEngine({ cwd: workspace("clio-contained-credentials-ws-") });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	for (const call of [{ tool: ToolNames.Read, args: { path: store } }, bash(`cat ${store}`)]) {
		for (const decision of [
			engine.evaluate(call, undefined, operatorDefault),
			engine.evaluate(call, "yolo", { scratchRoots: [] }),
		]) {
			strictEqual(decision.kind, "block", JSON.stringify(call.args));
			strictEqual(decision.reasonCode, "yolo-floor:yolo-floor-clio-credentials", JSON.stringify(call.args));
		}
	}
});

test("typed writes and edits inside a scratch root run at default with no ask, even with the sandbox off", async (t) => {
	const cwd = workspace("clio-contained-scratch-write-ws-");
	// $TMPDIR is a built-in scratch root, and the typed tools resolve paths against the process cwd.
	const scratch = workspace("clio-contained-scratch-write-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const session = defaultSession(cwd, { sandbox: false, snapshots: false });
	session.registry.register(writeTool);
	session.registry.register(editTool);
	const target = join(scratch, "smoke", "analyze.py");
	const calls: ClassifierCall[] = [
		{ tool: ToolNames.Write, args: { path: target, content: "print(1)\n" } },
		// The file now exists, so these used to ask under outside-file-replacement.
		{ tool: ToolNames.Edit, args: { path: target, edits: [{ oldText: "print(1)", newText: "print(2)" }] } },
		{ tool: ToolNames.Write, args: { path: target, content: "print(3)\n" } },
	];
	for (const call of calls) {
		const verdict = await session.registry.invoke(call);
		strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : call.tool);
	}
	strictEqual(readFileSync(target, "utf8"), "print(3)\n");
	deepStrictEqual(session.reviewed, []);
});

test("outside scratch roots, in a scratch repository's .git and on secret paths the write rails still hold", () => {
	const cwd = workspace("clio-contained-scratch-rails-ws-");
	const scratch = workspace("clio-contained-scratch-rails-");
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	// /opt is never a scratch root, so this path is outside every one on any host.
	const outside = admit(write("/opt/clio-contained-scratch-probe/x.txt"));
	strictEqual(outside.kind === "ask" && outside.decision.policy?.reasonCode, "system-modify-confirm");
	const hook = admit(write(join(scratch, "repo", ".git", "hooks", "pre-commit")));
	strictEqual(hook.kind === "ask" && hook.decision.policy?.reasonCode, "git-control-file");
	const secret = admit(write(join(scratch, "server.pem")));
	strictEqual(secret.kind === "deny" && secret.decision.policy?.reasonCode, "path-policy:zeroAccessPaths");
	// Without the operator's scope (a worker, a grant, a command job) a scratch write keeps its ask.
	const unscoped = evaluateAdmission({ principal: "main", effects: [write(join(scratch, "a.txt"))], safety });
	strictEqual(unscoped.kind, "ask");
});

test("at default the main session reads outside the workspace, and replacing an existing outside file asks", (t) => {
	const cwd = workspace("clio-contained-outside-ws-");
	// A tracked repository file: it exists, and it lies outside the workspace and every scratch root.
	const outside = realpathSync(fileURLToPath(new URL("../../package.json", import.meta.url)));
	// A checkout under a temp tree (release qualification runs one there) lies in a scratch root, where a write runs.
	const holder = effectiveScratchRoots(DEFAULT_SETTINGS.safety.scratchRoots, cwd).find((root) =>
		isSameOrDescendant(outside, root),
	);
	if (holder !== undefined) {
		t.skip(`the checkout lies in scratch root ${holder}, so its package.json is no outside file`);
		return;
	}
	// The typed tools resolve paths against the process cwd, which a session sets to its workspace.
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: false, snapshots: true };
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const read = admit({ tool: ToolNames.Read, args: { path: outside } });
	strictEqual(read.kind, "allow");
	strictEqual(read.decision.policy?.readScope, undefined);
	const replace = admit({ tool: ToolNames.Write, args: { path: outside, content: "x" } });
	strictEqual(replace.kind === "ask" && replace.approvalAuthority, "operator");
	strictEqual(replace.decision.policy?.reasonCode, "outside-file-replacement");
	strictEqual(admit({ tool: ToolNames.Write, args: { path: join(cwd, "a.txt"), content: "x" } }).kind, "allow");
	// The posture the model is told states the same thing.
	match(AUTONOMY_HELP.default, /read anywhere outside secret paths/);
	ok(!/reads outside the workspace/.test(AUTONOMY_HELP.default));
});

test("a typed write to the workspace repository's hooks asks at default, and an ordinary workspace file runs", (t) => {
	const cwd = workspace("clio-contained-git-control-");
	mkdirSync(join(cwd, ".git"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const admit = (path: string) =>
		evaluateAdmission({
			principal: "main",
			effects: [{ tool: ToolNames.Write, args: { path, content: "x" } }],
			safety,
			autonomy: "default",
			operatorDefault,
		});
	const hook = admit(".git/hooks/pre-commit");
	strictEqual(hook.kind === "ask" && hook.decision.policy?.reasonCode, "git-control-file");
	strictEqual(admit("src/app.py").kind, "allow");
});

test("a worker's typed write to its repository's hooks asks the main agent at default, and an ordinary file runs", (t) => {
	const cwd = workspace("clio-worker-git-control-");
	mkdirSync(join(cwd, ".git"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const admit = (path: string) =>
		evaluateAdmission({
			principal: "worker",
			effects: [{ tool: ToolNames.Write, args: { path, content: "x" } }],
			safety,
		});
	const hook = admit(".git/hooks/pre-commit");
	strictEqual(hook.kind === "ask" && hook.approvalAuthority, "main");
	strictEqual(hook.decision.policy?.ruleId, "git-control-file");
	strictEqual(admit("src/app.py").kind, "allow");
});

test("a typed write into a repository created after the engine was built asks at default, main and worker alike", (t) => {
	const cwd = workspace("clio-git-control-late-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	spawnSync("git", ["init", "-q"], { cwd });
	spawnSync("git", ["init", "-q", "nested"], { cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admitMain = (path: string) =>
		evaluateAdmission({ principal: "main", effects: [write(path)], safety: main, autonomy: "default", operatorDefault });
	const admitWorker = (path: string) =>
		evaluateAdmission({ principal: "worker", effects: [write(path)], safety: worker });
	for (const path of [".git/hooks/pre-commit", "nested/.git/hooks/pre-commit"]) {
		const asked = admitMain(path);
		strictEqual(asked.kind === "ask" && asked.decision.policy?.reasonCode, "git-control-file", path);
		const workerAsked = admitWorker(path);
		strictEqual(workerAsked.kind === "ask" && workerAsked.approvalAuthority, "main", path);
		strictEqual(workerAsked.decision.policy?.ruleId, "git-control-file", path);
	}
	strictEqual(admitMain("src/app.py").kind, "allow");
	strictEqual(admitWorker("src/app.py").kind, "allow");
});

test("a typed write into the core.hooksPath directory asks at default, also once the session has set it", (t) => {
	const cwd = workspace("clio-git-control-hooks-path-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	spawnSync("git", ["init", "-q"], { cwd });
	mkdirSync(join(cwd, ".husky"));
	const before = createWorkerSafety({ cwd });
	spawnSync("git", ["config", "core.hooksPath", ".husky"], { cwd });
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admitMain = (safety: typeof main, call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const asked = admitMain(main, write(".husky/pre-commit"));
	strictEqual(asked.kind === "ask" && asked.decision.policy?.reasonCode, "git-control-file");
	const workerAsked = evaluateAdmission({ principal: "worker", effects: [write(".husky/pre-commit")], safety: worker });
	strictEqual(workerAsked.kind === "ask" && workerAsked.approvalAuthority, "main");
	strictEqual(admitMain(main, write("src/app.py")).kind, "allow");
	// An engine built before the setting re-reads it after an admitted command that may have written it.
	strictEqual(admitMain(before, bash("git config core.hooksPath .husky")).kind, "allow");
	const refreshed = admitMain(before, write(".husky/pre-commit"));
	strictEqual(refreshed.kind === "ask" && refreshed.decision.policy?.reasonCode, "git-control-file");
});

test("the default scratch roots include $TMPDIR and /tmp", () => {
	const roots = effectiveScratchRoots([], workspace("clio-contained-scratch-"));
	ok(roots.includes(realpathSync(tmpdir())), roots.join(", "));
	ok(roots.includes(realpathSync("/tmp")), roots.join(", "));
});

test("under bwrap a contained main-session command writes the workspace and /tmp but not $HOME", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	// The assertion about $HOME means something only where the host itself can write it.
	if (spawnSync("bash", ["-c", 'test -w "$HOME"']).status !== 0) {
		t.skip("$HOME is not writable on this host");
		return;
	}
	const cwd = workspace("clio-contained-bwrap-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	// `test -w` asks the kernel, so a read-only bind answers no without a file being written.
	const verdict = await registry.invoke(
		bash('echo a > a.txt; test -w /tmp && echo tmp-writable; test -w "$HOME" || echo home-read-only'),
	);
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	match(output, /tmp-writable/u);
	match(output, /home-read-only/u);
	strictEqual(existsSync(join(cwd, "a.txt")), true);
});

test("under bwrap the core.hooksPath directory is read-only for a contained command", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const cwd = workspace("clio-contained-hooks-path-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	spawnSync("git", ["init", "-q"], { cwd });
	spawnSync("git", ["config", "core.hooksPath", ".husky"], { cwd });
	mkdirSync(join(cwd, ".husky"));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	const verdict = await registry.invoke(bash("echo a > a.txt; echo x > .husky/pre-commit || echo hooks-path-read-only"));
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	match(output, /hooks-path-read-only/u);
	strictEqual(existsSync(join(cwd, "a.txt")), true);
	strictEqual(existsSync(join(cwd, ".husky", "pre-commit")), false);
});

/** A read-only main session's registry, recording the sandbox each bash call was given. */
function readOnlySession(cwd: string, readOnlySandbox: boolean, level: "default" | "yolo") {
	const reviewed: SafetyJudgeSubject[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => level,
		readOnly: true,
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: true, readOnlySandbox }),
		currentSessionId: () => "s1",
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
	});
	const ran: Array<{ command: string; readOnly: boolean; writableRoots: ReadonlyArray<string> }> = [];
	registry.register({
		...bashTool,
		run: async (args, options) => {
			ran.push({
				command: String(args.command),
				readOnly: options?.shellSandbox?.readOnly === true,
				writableRoots: options?.shellSandbox?.writableRoots ?? [],
			});
			return { kind: "ok", output: "" };
		},
	});
	return { registry, ran, reviewed };
}

for (const level of ["default", "yolo"] as const) {
	test(`a read-only session runs a contained command at ${level} in the read-only sandbox, and asks nobody`, async () => {
		const cwd = workspace("clio-read-only-shell-");
		const session = readOnlySession(cwd, true, level);
		strictEqual((await session.registry.invoke(bash("make bench"))).kind, "ok");
		strictEqual(session.ran.length, 1);
		strictEqual(session.ran[0]?.readOnly, true);
		strictEqual(session.ran[0]?.writableRoots.length, 1);
		match(session.ran[0]?.writableRoots[0] ?? "", /\/scratch\/read-only\/s1$/u);
		for (const call of [bash("make bench", { unsandboxed: true }), bash("git push origin main")]) {
			const verdict = await session.registry.invoke(call);
			strictEqual(verdict.kind, "blocked", JSON.stringify(call.args));
			if (verdict.kind === "blocked") match(verdict.reason, /read-only/u);
		}
		strictEqual(session.ran.length, 1);
		deepStrictEqual(session.reviewed, []);
	});
}

test("a read-only session refuses shell commands where the read-only sandbox does not run", async () => {
	const session = readOnlySession(workspace("clio-read-only-shell-none-"), false, "default");
	strictEqual((await session.registry.invoke(bash("make bench"))).kind, "blocked");
	deepStrictEqual(session.ran, []);
	deepStrictEqual(session.reviewed, []);
});

test("a read-only worker's shell command passes only when its sandbox confines every write, and never asks", () => {
	const cwd = workspace("clio-read-only-worker-shell-");
	const safety = createWorkerSafety({ cwd });
	const admit = (command: string, confined: boolean, extra: Record<string, unknown> = {}) =>
		evaluateAdmission({
			principal: "worker",
			effects: [bash(command, extra)],
			safety,
			constraints: { readOnly: true },
			...(confined ? { readOnlyShellConfined: true } : {}),
		});
	strictEqual(admit("ls -la", true).kind, "allow");
	strictEqual(admit("ls -la", false).kind, "deny");
	strictEqual(admit("ls -la", true, { unsandboxed: true }).kind, "deny");
	const unrecognized = admit("make bench", true);
	strictEqual(unrecognized.kind === "deny" && unrecognized.code, "read_only");
});

test("a read-only run admits a dispatch, whose workers inherit read-only, and refuses steering", () => {
	const cwd = workspace("clio-read-only-dispatch-");
	const safety = createWorkerSafety({ cwd });
	for (const principal of ["main", "worker"] as const) {
		const admit = (tool: string, args: Record<string, unknown>) =>
			evaluateAdmission({ principal, effects: [{ tool, args }], safety, constraints: { readOnly: true } });
		strictEqual(admit(ToolNames.Dispatch, { agent: "scout", task: "map the repo" }).kind, "allow", principal);
		const steer = admit(ToolNames.Steer, { run_id: "r1", action: "guide", message: "write it" });
		strictEqual(steer.kind === "deny" && steer.code, "read_only", principal);
		// Cancelling a run changes no file; the steer tool still refuses a run this session did not dispatch (CLI-P38).
		const cancel = admit(ToolNames.Steer, { run_id: "r1", action: "cancel" });
		strictEqual(cancel.kind, "allow", `${principal}: ${JSON.stringify(cancel)}`);
	}
});

test("an execute-class MCP tool call is not contained by the sandbox and goes to the judge under its own rule", async () => {
	const cwd = workspace("clio-mcp-execute-");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	const sent: unknown[] = [];
	const name = "mcp_stub__send_note" as ToolSpec["name"];
	session.registry.register({
		name,
		description: "Sends a note. Local MCP server stub (user), trusted with action class execute.",
		parameters: bashTool.parameters,
		baseActionClass: "execute",
		safetyCall: () => ({ tool: ToolNames.Bash, args: { command: "python3 stub_mcp.py" }, projection: "mcp-server" }),
		run: async (args) => {
			sent.push(args);
			return { kind: "ok", output: "sent" };
		},
	});
	const result = await session.registry.invoke({ tool: name, args: { text: "hi" } });
	strictEqual(result.kind, "blocked", JSON.stringify(result));
	deepStrictEqual(sent, [], "an unjudged ask never reaches the server");
	strictEqual(session.reviewed.length, 1);
	const decision = session.reviewed[0]?.decision;
	strictEqual(decision?.kind, "ask");
	deepStrictEqual(
		{ ruleId: decision?.policy?.ruleId, source: decision?.policy?.policySource, sandbox: decision?.policy?.shellSandbox },
		{ ruleId: "mcp-execute", source: "mcp-trust", sandbox: undefined },
	);
});

/** A trusted execute-class MCP tool whose server launches with `command`, registered on `session`. */
function registerMcpExecute(session: ReturnType<typeof defaultSession>, command: string) {
	const sent: unknown[] = [];
	const name = "mcp_stub__send_message" as ToolSpec["name"];
	session.registry.register({
		name,
		description: "Sends a message. Local MCP server stub (user), trusted with action class execute.",
		parameters: bashTool.parameters,
		baseActionClass: "execute",
		safetyCall: () => ({ tool: ToolNames.Bash, args: { command }, projection: "mcp-server" }),
		run: async (args) => {
			sent.push(args);
			return { kind: "ok", output: "sent" };
		},
	});
	return { name, sent };
}

test("an execute-class MCP tool call asks at default even when a project policy approves its launch command", async () => {
	const cwd = workspace("clio-mcp-execute-project-");
	const command = "python3 stub_mcp.py";
	// In-memory project policy; the named safety.yaml is never written.
	const policy = createSafetyPolicyEngine({
		cwd,
		projectPolicy: {
			trustVerdict: "trusted",
			path: join(cwd, ".clio-coder", "safety.yaml"),
			hash: null,
			valid: true,
			errors: [],
			commands: [
				{
					id: "stub-server",
					command,
					actionClass: "execute",
					shellOperators: "deny",
					env: { mode: "none", allow: [] },
					requireConfirmation: false,
				},
			],
			pathPolicy: {},
			disableDefaultPathPolicy: false,
			informationFlow: EMPTY_INFORMATION_FLOW_INPUT,
		},
	});
	const launch = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
	strictEqual(launch.policySource, "project-policy", "the launch command itself is the project's approved command");
	const safety: SafetyContract = {
		...createWorkerSafety({ cwd }),
		evaluate(call, posture, scope) {
			const decision = policy.evaluate(call, posture, scope);
			strictEqual(decision.kind, "allow", call.tool);
			return { kind: "allow", classification: decision.classification, policy: decision };
		},
	};
	const session = defaultSession(cwd, { sandbox: true, snapshots: false }, { safety });
	const { name, sent } = registerMcpExecute(session, command);
	const result = await session.registry.invoke({ tool: name, args: { text: "hi" } });
	strictEqual(result.kind, "blocked", JSON.stringify(result));
	deepStrictEqual(sent, [], "an unjudged ask never reaches the server");
	const decision = session.reviewed[0]?.decision;
	strictEqual(decision?.kind, "ask");
	deepStrictEqual(
		{
			ruleId: decision?.policy?.ruleId,
			source: decision?.policy?.policySource,
			recognition: decision?.policy?.execRecognition,
		},
		{ ruleId: "mcp-execute", source: "mcp-trust", recognition: "unrecognized" },
	);
});

test("an MCP tool call keeps a rail's own ask or block, and at yolo is never refused as an unsandboxed script", () => {
	const engine = createSafetyPolicyEngine({ cwd: workspace("clio-mcp-execute-yolo-") });
	const mcp = (command: string): ClassifierCall => ({
		tool: ToolNames.Bash,
		args: { command },
		projection: "mcp-server",
	});
	const floor = engine.evaluate(mcp("rm -rf ~"));
	strictEqual(floor.kind, "block");
	strictEqual(floor.ruleId === "mcp-execute", false, "a rail's block keeps its own rule");
	for (const scriptSandbox of ["refused", "sandboxed"] as const) {
		const scope: OperatorYoloScope = { scratchRoots: [], scriptSandbox };
		const decision = engine.evaluate(mcp("python3 ./stub_mcp.py"), "yolo", scope);
		deepStrictEqual(
			{ kind: decision.kind, ruleId: decision.ruleId, sandbox: decision.shellSandbox },
			{ kind: "allow", ruleId: "mcp-execute", sandbox: undefined },
			scriptSandbox,
		);
	}
});

// M-7: an escape approved for the session covers reruns of its exact, unchanged script files only.
test("a sandbox escape approved for this session covers reruns of the same unchanged script; anything else asks", async (t) => {
	const cwd = workspace("clio-escape-scope-");
	mkdirSync(join(cwd, "probes"));
	mkdirSync(join(cwd, "other"));
	for (const file of ["probes/a.sh", "probes/b.sh", "other/c.sh"]) writeFileSync(join(cwd, file), "echo hi\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const entries: unknown[] = [];
	const ledger = () =>
		createEscapeScopeLedger({
			session: () => "session-1",
			entries: () => entries,
			append: (grant) => entries.push({ kind: "custom", customType: ESCAPE_SCOPE_CUSTOM_TYPE, data: grant }),
			roots: () => [cwd],
		});
	const unsandboxed = (command: string) => bash(command, { unsandboxed: true });

	// The approval card: the parked escape carries its scope, and the session option grants it.
	const card = defaultSession(cwd, { sandbox: true, snapshots: false }, { escapeScopes: ledger() });
	const asked: PermissionRequiredMeta[] = [];
	card.registry.onPermissionRequired((_call, _decision, meta) => asked.push(meta));
	const first = card.registry.invoke(unsandboxed("bash probes/a.sh"));
	await new Promise((settle) => setImmediate(settle));
	const offered = asked[0];
	ok(offered?.escapeScope !== undefined);
	deepStrictEqual(
		offered.escapeScope.scripts.map((script) => script.path),
		[join(cwd, "probes", "a.sh")],
	);
	await card.registry.resumeParkedCalls({
		actionClass: "execute",
		requestId: offered.requestId,
		requestedBy: "tool:one_shot",
		sessionScope: true,
	});
	strictEqual((await first).kind, "ok");
	strictEqual(entries.length, 1);
	// The same unchanged file: no card. A sibling in the same directory, another env, or the file edited: a card.
	strictEqual((await card.registry.invoke(unsandboxed("bash probes/a.sh"))).kind, "ok");
	strictEqual(asked.length, 1);
	const asks = async (command: string): Promise<void> => {
		void card.registry.invoke(unsandboxed(command));
		await new Promise((settle) => setImmediate(settle));
		card.registry.cancelParkedCalls("test");
	};
	for (const command of ["bash probes/b.sh", "FOO=1 bash probes/a.sh"]) await asks(command);
	strictEqual(asked.length, 3);
	// The grant is on the session ledger, so a ledger read afresh (a resumed session) still holds it.
	const resumed = defaultSession(cwd, { sandbox: true, snapshots: false }, { escapeScopes: ledger() });
	strictEqual((await resumed.registry.invoke(unsandboxed("bash probes/a.sh"))).kind, "ok");
	writeFileSync(join(cwd, "probes/a.sh"), "echo edited\n");
	await asks("bash probes/a.sh");
	strictEqual(asked.length, 4);
	deepStrictEqual(
		card.ran.map((entry) => entry.command),
		["bash probes/a.sh", "bash probes/a.sh"],
	);

	// Contained yolo: the refusal names the option, ask_user adds it to a question about leaving the sandbox,
	// drops one the agent wrote itself, and only the operator's pick of it grants; typed text never does.
	entries.length = 0;
	const answers: Array<(labels: string[]) => { options?: string[]; value?: string }> = [
		() => ({ value: "yes, approve unsandboxed runs of other/c.sh for the session" }),
		(labels) => ({ options: [labels.at(-1) ?? ""] }),
	];
	const yolo = defaultSession(
		cwd,
		{ sandbox: true, snapshots: false },
		{ escapeScopes: ledger(), unattendedAsks: () => true },
	);
	const shown: string[][] = [];
	yolo.registry.register(
		createAskUserTool({
			askUser: async (questions) => {
				const labels = (questions[0]?.options ?? []).map((option) => option.label);
				shown.push(labels);
				const pick = answers.shift()?.(labels) ?? {};
				const answer = [...(pick.options ?? []), pick.value ?? ""].filter((part) => part.length > 0).join(" ");
				return { answers: [{ question: questions[0]?.question ?? "", answer, ...pick }] };
			},
		}),
	);
	const refused = await yolo.registry.invoke(unsandboxed("bash other/c.sh"));
	strictEqual(refused.kind, "blocked");
	ok(
		refused.kind === "blocked" &&
			refused.reason.includes(`Approve for this session: script ${join(cwd, "other", "c.sh")} (sha256:`),
	);
	const ask = (question: string) =>
		yolo.registry.invoke({
			tool: ToolNames.AskUser,
			args: {
				action: "ask",
				mode: "single_question",
				questions: [
					{
						question,
						options: [{ label: "Yes, run it once" }, { label: "Approve for this session: everything" }, { label: "No" }],
					},
				],
			},
		});
	await ask("Run other/c.sh outside the sandbox?");
	strictEqual(entries.length, 0);
	await ask("Run other/c.sh outside the sandbox, again?");
	strictEqual(entries.length, 1);
	for (const labels of shown) {
		strictEqual(labels.includes("Approve for this session: everything"), false);
		ok(labels.at(-1)?.startsWith(`Approve for this session: script ${join(cwd, "other", "c.sh")} (sha256:`));
	}
	strictEqual((await yolo.registry.invoke(unsandboxed("bash other/c.sh"))).kind, "ok");
});

// M-7 bounce: the refused escape says one true thing about retrying, and once the operator grants its scope the
// refusal is no failed attempt the loop guard counts, so two reruns in the same turn both run.
test("a contained-yolo escape refusal tells when to retry, and a granted rerun is not a repeat of a failed attempt", async (t) => {
	const cwd = workspace("clio-escape-loop-");
	writeFileSync(join(cwd, "probe.sh"), "echo hi\\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const entries: unknown[] = [];
	const escapeScopes = createEscapeScopeLedger({
		session: () => "session-1",
		entries: () => entries,
		append: (grant) => entries.push({ kind: "custom", customType: ESCAPE_SCOPE_CUSTOM_TYPE, data: grant }),
		roots: () => [cwd],
	});
	const guard = createLoopGuardRegistration({ safety: loopSafety() });
	const yolo = defaultSession(
		cwd,
		{ sandbox: true, snapshots: false },
		{
			escapeScopes,
			unattendedAsks: () => true,
			middleware: createMiddlewareBundle({ registrations: [guard] }).contract,
		},
	);
	yolo.registry.register(
		createAskUserTool({
			askUser: async (questions) => {
				const label = questions[0]?.options?.at(-1)?.label ?? "";
				return { answers: [{ question: questions[0]?.question ?? "", answer: label, options: [label] }] };
			},
		}),
	);
	const turn = { sessionId: "session-1", turnId: "turn-1" };
	const call = bash("bash probe.sh", { unsandboxed: true });
	const refused = await yolo.registry.invoke(call, turn);
	ok(refused.kind === "blocked" && refused.denial !== undefined);
	const [account, remedy] = denialLines(refused.denial);
	strictEqual(account.includes("Not retryable"), false, account);
	match(account, /until the operator answers an ask_user question/u);
	match(remedy, /session option/u);
	match(refused.reason, /rerun the call after they choose it/u);
	await yolo.registry.invoke(
		{
			tool: ToolNames.AskUser,
			args: {
				action: "ask",
				mode: "single_question",
				questions: [{ question: "Run probe.sh outside the sandbox?", options: [{ label: "Yes, once" }] }],
			},
		},
		turn,
	);
	strictEqual(entries.length, 1);
	for (const rerun of [1, 2]) strictEqual((await yolo.registry.invoke(call, turn)).kind, "ok", `rerun ${rerun}`);
});

// Row 328: a judge block of a contained-yolo escape gives one account of retrying. With a session option on offer
// the judge's no-retry route yields to it; with none, the refusal says why no option exists.
test("a judge-blocked contained-yolo escape gives one retry account: the scoped remedy, or why no option exists", async (t) => {
	const cwd = workspace("clio-escape-judged-");
	writeFileSync(join(cwd, "probe.sh"), "echo hi\n");
	const outside = workspace("clio-escape-outside-");
	writeFileSync(join(outside, "far.sh"), "echo far\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const escapeScopes = createEscapeScopeLedger({
		session: () => "session-1",
		entries: () => [],
		append: () => {},
		roots: () => [cwd],
	});
	const judge = createSafetyJudge({
		config: () => ({ enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] }),
		complete: async () => ({
			text: JSON.stringify({ verdict: "block", rule: "unclear", reason: "The approval does not scope this write." }),
		}),
		operatorMessages: () => ["run the probes"],
		session: () => "session-1",
		consequences: () => [],
		record: () => {},
	});
	const yolo = defaultSession(
		cwd,
		{ sandbox: true, snapshots: false },
		{ escapeScopes, unattendedAsks: () => true, safetyJudge: judge },
	);
	const turn = { sessionId: "session-1", turnId: "turn-1" };
	const scoped = await yolo.registry.invoke(bash("bash probe.sh && bash probe.sh", { unsandboxed: true }), turn);
	ok(scoped.kind === "blocked" && scoped.denial !== undefined);
	match(scoped.reason, /safety judge blocked this bash call \(rule unclear\)/u);
	strictEqual(
		/Do not retry (?:this call|the compound command) or a reworded|Run each sub-command/u.test(scoped.reason),
		false,
		scoped.reason,
	);
	match(scoped.reason, /Until the operator answers, do not retry this call or a reworded form of it/u);
	match(scoped.reason, /rerun the call after they choose it/u);
	match(denialLines(scoped.denial)[0], /Retry only after the operator answers/u);

	const unscoped = await yolo.registry.invoke(bash(`bash ${outside}/far.sh`, { unsandboxed: true }), turn);
	ok(unscoped.kind === "blocked" && unscoped.denial !== undefined);
	match(unscoped.reason, /Do not retry this call or a reworded form of it/u);
	strictEqual(
		/rerun the call after they choose it|Approve for this session/u.test(unscoped.reason),
		false,
		unscoped.reason,
	);
	ok(
		unscoped.reason.includes(
			`CLIO Coder offers no session option for this call because its script ${join(outside, "far.sh")} lies outside the workspace and scratch roots`,
		),
		unscoped.reason,
	);
	deepStrictEqual(yolo.ran, []);
});
