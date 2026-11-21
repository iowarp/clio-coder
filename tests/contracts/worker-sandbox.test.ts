import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { mainSandboxPolicy, planMainSandboxSpawn } from "../../src/core/sandbox/main-session.js";
import { WORKER_SANDBOX_SPEC_VERSION, type WorkerSandboxSpec } from "../../src/core/sandbox/types.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import {
	composeWorkerSandboxInvocation,
	configureWorkerProcessSandbox,
	planSandboxedSpawn,
} from "../../src/core/sandbox/worker-process.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resolveWorkerEnvelope } from "../../src/domains/dispatch/envelope.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// A scratch Clio home for the whole file, holding the desktop app's launch token.
const clioHome = await isolateClioEnv("clio-worker-sandbox-' ; ");
after(() => clioHome.restore());
const appToken = join(clioHome.dir, "state", "gui", "background", "server.json");
mkdirSync(join(appToken, ".."), { recursive: true });
writeFileSync(appToken, '{"port":1,"token":"GUI_LAUNCH_TOKEN"}\n', { mode: 0o600 });

function run(file: string, args: string[]): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
			resolve({ code, output: `${stdout}${stderr}` });
		});
	});
}

test("a worker granted any network tool, web_read included, gets shell network (M6, envelope M7)", () => {
	const network = (tools: ToolName[]) =>
		resolveWorkerEnvelope({
			role: "builder",
			capabilityClass: "workspace-edit",
			recipeTools: tools,
			profiledTools: tools,
			denied: new Set(),
			ledger: false,
			write: { mode: "none", roots: [] },
			runtime: { toolsSupported: true, ownLoop: true, offers: () => true },
			host: { networkStripped: false, shellStripped: false, confinesWrites: false, harnessTools: new Set() },
			skills: { names: [], paths: [], disabled: false, contextAttached: () => false },
			read: { roots: [], outside: [] },
			sandbox: { backend: "bwrap", applies: true, networkSetting: false, networkOff: false },
			approval: { autonomy: "default", asks: "deny" },
			permitDigest: "",
		}).network.shell;
	assert.equal(network([ToolNames.Bash]), false);
	assert.equal(network([ToolNames.Bash, ToolNames.WebFetch]), true);
	assert.equal(network([ToolNames.Bash, ToolNames.WebRead]), true);
});

test("under bwrap a worker command writes only its writable root and cannot reach the network", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-worker-sandbox-")));
	const root = join(scratch, "worktree");
	const outside = join(scratch, "checkout");
	mkdirSync(root);
	mkdirSync(outside);
	const server = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const policy = (network: boolean): WorkerSandboxSpec => ({
		version: WORKER_SANDBOX_SPEC_VERSION,
		mode: "required",
		writableRoots: [root],
		readOnlyPaths: [],
		gitWritablePaths: [],
		// The parent checkout stays visible read-only, as a task worktree's does.
		readableRoots: [outside],
		network,
	});
	const command = {
		argv: [
			"/bin/bash",
			"--noprofile",
			"--norc",
			"-c",
			[
				'echo inside > "$1/inside.txt" && echo wrote-inside',
				'if echo outside > "$2/outside.txt" 2>/dev/null; then echo wrote-outside; fi',
				'if exec 3<>"/dev/tcp/127.0.0.1/$3"; then echo connected; else echo no-network; fi',
			].join("; "),
			"worker-sandbox",
			root,
			outside,
			String(address.port),
		],
	};

	const isolated = composeWorkerSandboxInvocation(policy(false), command, root, availability, []);
	assert.ok(isolated !== null);
	const result = await run(isolated.file, isolated.args);
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /wrote-inside/u);
	assert.doesNotMatch(result.output, /wrote-outside/u);
	assert.match(result.output, /no-network/u);
	assert.equal(existsSync(join(root, "inside.txt")), true);
	assert.equal(existsSync(join(outside, "outside.txt")), false);

	// Control: the same listener is reachable once the run holds a network
	// grant, so the refusal above is the namespace and not a dead port.
	const granted = composeWorkerSandboxInvocation(policy(true), command, root, availability, []);
	assert.ok(granted !== null);
	assert.match((await run(granted.file, granted.args)).output, /connected/u);
});

test("under bwrap a task worktree's worker cannot read the secrets of the checkout that owns it", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const checkout = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-worker-checkout-")));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(checkout, "README.md"), "x\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "init");
	const worktree = join(checkout, ".clio-coder", "worktrees", "run1");
	const sibling = join(checkout, ".clio-coder", "worktrees", "run2");
	git("worktree", "add", "-q", "-b", "clio-coder/task/run1", worktree);
	git("worktree", "add", "-q", "-b", "clio-coder/task/run2", sibling);
	writeFileSync(join(checkout, ".env"), "ROOT_SECRET=checkout\n");
	writeFileSync(join(sibling, ".env"), "SIBLING_SECRET=sibling\n");
	const spec = resolveWorkerSandboxSpec({
		mode: "auto",
		readOnly: false,
		cwd: worktree,
		writeBoundaries: [],
		taskWorktree: { path: worktree, branch: "clio-coder/task/run1" },
		network: false,
		dependencyRoots: [],
	});
	configureWorkerProcessSandbox(spec);
	t.after(() => configureWorkerProcessSandbox(undefined));
	const plan = planSandboxedSpawn(
		{
			argv: [
				"/bin/sh",
				"-c",
				'cat "$@" README.md 2>&1; true',
				"worker-sandbox",
				join(checkout, ".env"),
				join(sibling, ".env"),
			],
		},
		worktree,
	);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const result = await run(plan.file, plan.args);
	assert.match(result.output, /^x$/mu, "the worker still reads its own tree");
	assert.doesNotMatch(result.output, /ROOT_SECRET|SIBLING_SECRET/u, result.output);

	// A bare repository's checkouts are all linked worktrees of `<name>.git`, so the source is found the same way.
	const bare = join(checkout, "..", `${basename(checkout)}-bare.git`);
	const source = `${bare.slice(0, -".git".length)}-main`;
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	t.after(() => rmSync(source, { recursive: true, force: true }));
	execFileSync("git", ["clone", "-q", "--bare", checkout, bare], { stdio: "ignore" });
	execFileSync("git", ["-C", bare, "worktree", "add", "-q", source, "main"], { stdio: "ignore" });
	const bareTask = join(source, ".clio-coder", "worktrees", "run1");
	execFileSync("git", ["-C", source, "worktree", "add", "-q", "-b", "clio-coder/task/bare1", bareTask], {
		stdio: "ignore",
	});
	writeFileSync(join(source, ".env"), "BARE_SOURCE_SECRET=source\n");
	configureWorkerProcessSandbox(
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: bareTask,
			writeBoundaries: [],
			taskWorktree: { path: bareTask, branch: "clio-coder/task/bare1" },
			network: false,
			dependencyRoots: [],
		}),
	);
	const barePlan = planSandboxedSpawn(
		{ argv: ["/bin/sh", "-c", 'cat "$1" README.md 2>&1; true', "worker-sandbox", join(source, ".env")] },
		bareTask,
	);
	assert.equal(barePlan.kind, "sandboxed");
	if (barePlan.kind !== "sandboxed") return;
	const bareResult = await run(barePlan.file, barePlan.args);
	assert.match(bareResult.output, /^x$/mu, "the worker still reads its own tree");
	assert.doesNotMatch(bareResult.output, /BARE_SOURCE_SECRET/u, bareResult.output);
});

test("under bwrap no contained command reads the desktop app's launch token", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-app-token-")));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const command = { argv: ["/bin/sh", "-c", 'cat "$1" 2>&1; true', "worker-sandbox", appToken] };
	configureWorkerProcessSandbox(
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: workspace,
			writeBoundaries: [],
			network: false,
		}),
	);
	t.after(() => configureWorkerProcessSandbox(undefined));
	const plans = {
		worker: planSandboxedSpawn(command, workspace),
		main: planMainSandboxSpawn(mainSandboxPolicy({ workspace, scratchRoots: [] }), command, workspace),
	};
	for (const [name, plan] of Object.entries(plans)) {
		assert.equal(plan.kind, "sandboxed", name);
		if (plan.kind !== "sandboxed") continue;
		const result = await run(plan.file, plan.args);
		assert.doesNotMatch(result.output, /GUI_LAUNCH_TOKEN/u, `${name}: ${result.output}`);
	}
});

test("under bwrap a running command cannot read Clio's credential store after Clio rewrites it, and still reads settings and recipes", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const config = join(clioHome.dir, "config");
	const store = join(config, "credentials.yaml");
	mkdirSync(join(config, "skills", "demo"), { recursive: true });
	writeFileSync(join(config, "skills", "demo", "SKILL.md"), "SKILL_BODY\n");
	mkdirSync(join(config, "agents"), { recursive: true });
	writeFileSync(join(config, "agents", "demo.md"), "AGENT_BODY\n");
	const settings = join(config, "settings.yaml");
	writeFileSync(settings, "# SETTINGS_BEFORE\n");
	writeFileSync(store, "token: STORE_BEFORE\n", { mode: 0o600 });
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-store-rename-")));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const command = {
		argv: [
			"/bin/sh",
			"-c",
			'cat "$1/skills/demo/SKILL.md" "$1/agents/demo.md"; for i in 1 2 3 4 5 6 7 8; do cat "$1/credentials.yaml" "$1/settings.yaml" 2>&1; ls -a "$1"; sleep 0.25; done',
			"worker-sandbox",
			config,
		],
	};
	const plan = planMainSandboxSpawn(mainSandboxPolicy({ workspace, scratchRoots: [] }), command, workspace);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const child = spawn(plan.file, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise((resolve) => child.on("exit", resolve));
	await new Promise((resolve) => setTimeout(resolve, 600));
	// What safeResourceWrite does on a login or an OAuth refresh: a sibling temp file renamed over the store.
	const temp = join(config, ".credentials.yaml.tmp-1-x");
	writeFileSync(temp, "token: STORE_AFTER\n", { mode: 0o600 });
	await new Promise((resolve) => setTimeout(resolve, 300));
	renameSync(temp, store);
	// settings.yaml is bound back from its old inode, so the same rewrite cannot show the new file.
	writeFileSync(join(config, ".settings.yaml.tmp-1-x"), "# SETTINGS_AFTER\n");
	renameSync(join(config, ".settings.yaml.tmp-1-x"), settings);
	await exited;
	assert.match(output, /^SKILL_BODY$/mu, "installed skills stay readable");
	assert.match(output, /^AGENT_BODY$/mu, "user agent recipes stay readable");
	assert.match(output, /^# SETTINGS_BEFORE$/mu, "settings.yaml stays readable when it is not masked");
	assert.doesNotMatch(output, /SETTINGS_AFTER|settings\.yaml\.tmp/u, output);
	assert.doesNotMatch(output, /STORE_BEFORE|STORE_AFTER|credentials\.yaml\.tmp/u, output);
});
