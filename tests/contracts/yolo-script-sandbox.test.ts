import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { buildBwrapInvocation } from "../../src/core/sandbox/bwrap.js";
import {
	planYoloScriptSpawn,
	resolveYoloScriptSandboxPolicy,
	yoloScriptAgentMasks,
	yoloScriptGitLayout,
	yoloScriptSandboxInvocationSpec,
	yoloScriptSandboxState,
	yoloScriptSandboxWriteHint,
} from "../../src/core/sandbox/yolo-script.js";

function run(file: string, args: string[]): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
			resolve({ code, output: `${stdout}${stderr}` });
		});
	});
}

// #419: the operator's yolo runs scripts in the OS sandbox with the real /tmp.
test("the yolo script sandbox writes the workspace and scratch roots only, keeps Clio's trees read-only and the network on", () => {
	const policy = resolveYoloScriptSandboxPolicy({
		workspace: "/w",
		scratchRoots: ["/tmp", "/bench"],
		cacheRoots: ["/home/u/.cache", "/home/u/.npm"],
		codeCaches: [],
		clioDirs: ["/home/u/.config/clio-coder", "/home/u/.local/share/clio-coder", "/home/u/.cache/clio-coder"],
	});
	assert.deepEqual(policy.writableRoots, ["/w", "/tmp", "/bench", "/home/u/.cache", "/home/u/.npm"]);
	assert.equal(
		policy.writableRoots.some((root) => root.startsWith("/home/u/.local")),
		false,
		"~/.local/bin is on PATH",
	);
	for (const path of [
		"/w/.git",
		"/w/.clio-coder",
		"/bench/.git",
		"/home/u/.config/clio-coder",
		"/home/u/.cache/clio-coder",
	]) {
		assert.ok(policy.readOnlyPaths.includes(path), path);
	}
	assert.equal(policy.network, true);

	const masks = [{ path: "/home/u/.ssh", kind: "directory" as const }];
	const spec = yoloScriptSandboxInvocationSpec(policy, { argv: ["/bin/bash", "x.sh"] }, "/w", masks);
	const { args } = buildBwrapInvocation(spec);
	assert.equal(args.includes("--unshare-net"), false);
	assert.equal(args.includes("--tmpfs") && args[args.indexOf("--tmpfs") + 1] === "/tmp", false, "no private /tmp");
	const bind = args.indexOf("/tmp");
	assert.equal(args[bind - 1], "--bind-try", "the real /tmp is bound writable");
	assert.ok(args.indexOf("/w/.git") > args.indexOf("/w"), ".git is re-bound after the workspace");
	assert.ok(args.lastIndexOf("/home/u/.ssh") > args.indexOf("/w/.git"), "masks come last");
	assert.deepEqual(args.slice(args.indexOf("--unsetenv"), args.indexOf("--unsetenv") + 2), [
		"--unsetenv",
		"SSH_AUTH_SOCK",
	]);

	const available = { available: true, backend: "bwrap" as const, executable: "/usr/bin/bwrap", reason: null };
	const missing = { available: false, backend: null, executable: null, reason: "bubblewrap (bwrap) is not installed" };
	assert.equal(yoloScriptSandboxState("auto", available), "sandboxed");
	assert.equal(yoloScriptSandboxState("off", available), "unsandboxed");
	assert.equal(yoloScriptSandboxState("auto", missing), "unsandboxed");
	assert.equal(yoloScriptSandboxState("required", missing), "refused");
	assert.equal(planYoloScriptSpawn(policy, { argv: ["/bin/true"] }, "/w", missing).kind, "refused");

	assert.match(
		yoloScriptSandboxWriteHint("x: Read-only file system", policy) ?? "",
		/yolo script sandbox.*\/w, \/tmp, \/bench.*safety\.scratchRoots/u,
	);
	assert.equal(yoloScriptSandboxWriteHint("no such file", policy), null);
});

test("under bwrap a yolo script writes its workspace and scratch roots, sees the host's /tmp and writes nothing else", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-yolo-script-")));
	const workspace = join(scratch, "workspace");
	const bench = join(scratch, "bench");
	const outside = join(scratch, "outside");
	mkdirSync(join(workspace, ".git"), { recursive: true });
	mkdirSync(bench);
	mkdirSync(outside);
	const cache = join(scratch, "cache");
	mkdirSync(join(cache, "clio-coder"), { recursive: true });
	const policy = resolveYoloScriptSandboxPolicy({
		workspace,
		scratchRoots: [bench],
		cacheRoots: [cache],
		codeCaches: [],
		clioDirs: [join(cache, "clio-coder")],
	});
	// A private /tmp is a fresh tmpfs on its own device; the host's keeps its device and inode.
	const script = [
		"stat -c tmp-id=%d:%i /tmp",
		`echo a > ${join(workspace, "a.txt")}`,
		`echo b > ${join(bench, "b.txt")}`,
		`echo e > ${join(cache, "e.txt")}`,
		`echo f > ${join(cache, "clio-coder", "f.txt")} 2>/dev/null || echo clio-cache-refused`,
		`echo c > ${join(outside, "c.txt")} 2>/dev/null || echo outside-refused`,
		`echo d > ${join(workspace, ".git", "d")} 2>/dev/null || echo git-refused`,
	].join("; ");
	const plan = planYoloScriptSpawn(policy, { argv: ["/bin/bash", "-c", script] }, workspace, availability);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const result = await run(plan.file, plan.args);
	assert.equal(result.code, 0, result.output);
	assert.match(result.output, /outside-refused/u);
	assert.match(result.output, /git-refused/u);
	assert.match(result.output, /clio-cache-refused/u);
	assert.equal(existsSync(join(cache, "e.txt")), true);
	assert.match(
		result.output,
		new RegExp(`tmp-id=${statSync("/tmp").dev}:${statSync("/tmp").ino}\\b`, "u"),
		"the host's /tmp, not a private one",
	);
	assert.equal(existsSync(join(workspace, "a.txt")), true);
	assert.equal(existsSync(join(bench, "b.txt")), true);
	assert.equal(existsSync(join(outside, "c.txt")), false);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
		cwd,
		encoding: "utf8",
	});
}

// #419: git inside a yolo script writes objects, refs and the index but never hooks, config or commondir.
test("the yolo script sandbox makes the repository's git dirs writable and keeps their hooks, config and commondir read-only", () => {
	const policy = resolveYoloScriptSandboxPolicy({
		workspace: "/w",
		scratchRoots: ["/tmp"],
		cacheRoots: [],
		codeCaches: [],
		clioDirs: [],
		git: {
			mountDirs: ["/w/.git", "/w/.git/modules", "/w/.git/modules/sub"],
			readOnlyPaths: ["/w/.git/config", "/w/.git/hooks", "/w/.git/modules/sub/config", "/w/sub/.git"],
			absentHooks: ["/w/.git/modules/sub/hooks"],
			absentFiles: ["/w/.git/commondir"],
		},
	});
	assert.deepEqual(policy.writableRoots, ["/w", "/tmp", "/w/.git", "/w/.git/modules", "/w/.git/modules/sub"]);
	assert.equal(policy.readOnlyPaths.includes("/w/.git"), false);
	for (const path of [
		"/w/.clio-coder",
		"/tmp/.git",
		"/w/.git/hooks",
		"/w/.git/commondir",
		"/w/.git/modules/sub/hooks",
	]) {
		assert.ok(policy.readOnlyPaths.includes(path), path);
	}
	const { args } = buildBwrapInvocation(yoloScriptSandboxInvocationSpec(policy, { argv: ["/bin/true"] }, "/w", []));
	assert.ok(
		args.indexOf("/w/.git/config") > args.lastIndexOf("/w/.git/modules/sub"),
		"read-only rebinds follow the git mounts",
	);
});

test("the git layout of a linked worktree covers its .git file, its git dir and the common dir", (t) => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-yolo-git-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const main = join(scratch, "main");
	mkdirSync(main);
	git(main, "init", "-q");
	git(main, "commit", "-q", "--allow-empty", "-m", "init");
	git(main, "worktree", "add", "-q", join(scratch, "wt"));
	const layout = yoloScriptGitLayout(join(scratch, "wt"));
	assert.ok(layout !== undefined);
	const common = join(main, ".git");
	for (const dir of [common, join(common, "worktrees"), join(common, "worktrees", "wt")]) {
		assert.ok(layout.mountDirs.includes(dir), dir);
	}
	for (const path of [
		join(scratch, "wt", ".git"),
		join(common, "config"),
		join(common, "hooks"),
		join(common, "worktrees", "wt", "commondir"),
	]) {
		assert.ok(layout.readOnlyPaths.includes(path), path);
	}
	assert.ok(layout.absentFiles.includes(join(common, "commondir")));
});

test("under bwrap git commits from a yolo script while hooks, config, commondir and module git dirs stay put", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-yolo-git-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const workspace = join(scratch, "main");
	mkdirSync(workspace);
	git(workspace, "init", "-q");
	git(workspace, "commit", "-q", "--allow-empty", "-m", "init");
	const common = join(workspace, ".git");
	const module = join(common, "modules", "sub");
	mkdirSync(join(common, "modules"));
	git(scratch, "init", "-q", `--separate-git-dir=${module}`, join(workspace, "sub"));
	git(module, "config", "core.worktree", "../../../sub");
	rmSync(join(module, "hooks"), { recursive: true, force: true });
	const layout = yoloScriptGitLayout(workspace);
	const policy = resolveYoloScriptSandboxPolicy({
		workspace,
		scratchRoots: [],
		cacheRoots: [],
		codeCaches: [],
		clioDirs: [],
		...(layout !== undefined ? { git: layout } : {}),
	});
	const script = [
		"git -c user.name=t -c user.email=t@t commit -q --allow-empty -m sandboxed && echo committed",
		"echo x > .git/hooks/post-commit 2>/dev/null || echo hooks-refused",
		"git config core.fsmonitor evil 2>/dev/null || echo config-refused",
		"mv .git/modules/sub .git/modules/sub2 2>/dev/null || echo module-rename-refused",
		"mv .git/modules .git/modules2 2>/dev/null || echo modules-rename-refused",
		"echo x > sub/.git 2>/dev/null || echo gitfile-refused",
		"mkdir -p .git/modules/sub/hooks && echo x > .git/modules/sub/hooks/post-checkout",
		"echo /evil > .git/commondir",
	].join("; ");
	const plan = planYoloScriptSpawn(policy, { argv: ["/bin/bash", "-c", script] }, workspace, availability);
	assert.equal(plan.kind, "sandboxed");
	if (plan.kind !== "sandboxed") return;
	const result = await run(plan.file, plan.args);
	plan.afterExit();
	for (const marker of [
		"committed",
		"hooks-refused",
		"config-refused",
		"module-rename-refused",
		"modules-rename-refused",
		"gitfile-refused",
	]) {
		assert.match(result.output, new RegExp(marker, "u"), result.output);
	}
	assert.match(git(workspace, "log", "-1", "--format=%s"), /sandboxed/u);
	assert.equal(existsSync(join(common, "hooks", "post-commit")), false);
	assert.doesNotMatch(readFileSync(join(common, "config"), "utf8"), /fsmonitor/u);
	assert.equal(existsSync(join(module, "hooks", "post-checkout")), false, "an absent hooks dir is a tmpfs");
	assert.equal(existsSync(join(common, "commondir")), false, "a planted commondir is swept");
});

// #419: worker parity. The host's /tmp must not hand a yolo script the operator's ssh-agent.
test("under bwrap a yolo script runs in its own PID namespace and cannot reach an ssh-agent socket", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-yolo-agent-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	// Stands in for /tmp: OpenSSH's agent directory, and an agent socket elsewhere named by SSH_AUTH_SOCK.
	mkdirSync(join(scratch, "ssh-abc"));
	const listen = (socket: string) =>
		new Promise<ReturnType<typeof createServer>>((resolve) => {
			const server = createServer().listen(socket, () => resolve(server));
		});
	const servers = await Promise.all([listen(join(scratch, "ssh-abc", "agent.1")), listen(join(scratch, "agent.sock"))]);
	t.after(() => {
		for (const server of servers) server.close();
	});
	const masks = yoloScriptAgentMasks({ SSH_AUTH_SOCK: join(scratch, "agent.sock") }, scratch);
	assert.deepEqual(masks, [
		{ path: join(scratch, "ssh-abc"), kind: "directory" },
		{ path: join(scratch, "agent.sock"), kind: "file" },
	]);
	const policy = resolveYoloScriptSandboxPolicy({
		workspace: scratch,
		scratchRoots: [],
		cacheRoots: [],
		codeCaches: [],
		clioDirs: [],
	});
	const script = [
		"kill -0 1 && test $$ -lt 10 && echo own-pid-namespace",
		`test -S ${join(scratch, "ssh-abc", "agent.1")} || echo tmp-agent-hidden`,
		`test -S ${join(scratch, "agent.sock")} || echo auth-sock-hidden`,
	].join("; ");
	const spec = yoloScriptSandboxInvocationSpec(policy, { argv: ["/bin/bash", "-c", script] }, scratch, masks);
	const { args } = buildBwrapInvocation(spec, availability.executable ?? undefined);
	assert.ok(args.includes("--unshare-pid"));
	const result = await run(availability.executable ?? "bwrap", args);
	assert.equal(result.code, 0, result.output);
	for (const marker of ["own-pid-namespace", "tmp-agent-hidden", "auth-sock-hidden"]) {
		assert.match(result.output, new RegExp(marker, "u"), result.output);
	}
});
