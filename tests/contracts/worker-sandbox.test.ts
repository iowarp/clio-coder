import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { WORKER_SANDBOX_SPEC_VERSION, type WorkerSandboxSpec } from "../../src/core/sandbox/types.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import {
	composeWorkerSandboxInvocation,
	configureWorkerProcessSandbox,
	planSandboxedSpawn,
} from "../../src/core/sandbox/worker-process.js";

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
});
