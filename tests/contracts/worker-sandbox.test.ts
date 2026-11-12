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
import { isolateClioEnv } from "../harness/scratch-env.js";

// A scratch Clio home for the whole file, holding the desktop app's launch token.
const clioHome = await isolateClioEnv("clio-worker-sandbox-");
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
	const script = [
		`echo inside > ${join(root, "inside.txt")} && echo wrote-inside`,
		`if echo outside > ${join(outside, "outside.txt")} 2>/dev/null; then echo wrote-outside; fi`,
		`if exec 3<>/dev/tcp/127.0.0.1/${address.port}; then echo connected; else echo no-network; fi`,
	].join("; ");

	const isolated = composeWorkerSandboxInvocation(policy(false), { shell: script }, root, availability, []);
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
	const granted = composeWorkerSandboxInvocation(policy(true), { shell: script }, root, availability, []);
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
		allowedTools: ["bash"],
		networkSetting: false,
		dependencyRoots: [],
	});
	configureWorkerProcessSandbox(spec);
	t.after(() => configureWorkerProcessSandbox(undefined));
	const plan = planSandboxedSpawn(
		{ shell: `cat ${join(checkout, ".env")} ${join(sibling, ".env")} README.md 2>&1; true` },
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
			allowedTools: ["bash"],
			networkSetting: false,
			dependencyRoots: [],
		}),
	);
	const barePlan = planSandboxedSpawn({ shell: `cat ${join(source, ".env")} README.md 2>&1; true` }, bareTask);
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
	const shell = `cat ${appToken} 2>&1; true`;
	configureWorkerProcessSandbox(
		resolveWorkerSandboxSpec({
			mode: "auto",
			readOnly: false,
			cwd: workspace,
			writeBoundaries: [],
			allowedTools: ["bash"],
			networkSetting: false,
		}),
	);
	t.after(() => configureWorkerProcessSandbox(undefined));
	const plans = {
		worker: planSandboxedSpawn({ shell }, workspace),
		main: planMainSandboxSpawn(mainSandboxPolicy({ workspace, scratchRoots: [] }), { shell }, workspace),
	};
	for (const [name, plan] of Object.entries(plans)) {
		assert.equal(plan.kind, "sandboxed", name);
		if (plan.kind !== "sandboxed") continue;
		const result = await run(plan.file, plan.args);
		assert.doesNotMatch(result.output, /GUI_LAUNCH_TOKEN/u, `${name}: ${result.output}`);
	}
});

test("under bwrap a running command cannot read Clio's credential store after Clio rewrites it", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const config = join(clioHome.dir, "config");
	const store = join(config, "credentials.yaml");
	mkdirSync(join(config, "skills", "demo"), { recursive: true });
	writeFileSync(join(config, "skills", "demo", "SKILL.md"), "SKILL_BODY\n");
	writeFileSync(store, "token: STORE_BEFORE\n", { mode: 0o600 });
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-store-rename-")));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const shell = `cat ${join(config, "skills", "demo", "SKILL.md")}; for i in 1 2 3 4 5 6 7 8; do cat ${store} 2>&1; ls -a ${config}; sleep 0.25; done`;
	const plan = planMainSandboxSpawn(mainSandboxPolicy({ workspace, scratchRoots: [] }), { shell }, workspace);
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
	await exited;
	assert.match(output, /^SKILL_BODY$/mu, "installed skills stay readable");
	assert.doesNotMatch(output, /STORE_BEFORE|STORE_AFTER|credentials\.yaml\.tmp/u, output);
});
