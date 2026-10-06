import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
function workspace(): string {
	assert.ok(process.env.TMPDIR, "Set an owned TMPDIR for the fixtures.");
	return mkdtempSync(path.join(process.env.TMPDIR, "git-pulse-"));
}
function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@localhost",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-C",
			cwd,
			...args,
		],
		{ encoding: "utf8" },
	).trim();
}

test("pulse reports real branch and dirty paths; the clock tick refreshes and persists the snapshot", async () => {
	const cwd = workspace();
	git(cwd, "init", "-q", "-b", "main");
	const host = await createExtensionTestHost(ROOT, { workspace: cwd });
	try {
		const initial = await host.observe({ event: "session_open", reason: "startup" });
		assert.match(initial?.status?.text ?? "", /Git main · 0 dirty · no upstream/);
		writeFileSync(path.join(cwd, "sample.txt"), "prepared fixture\n");
		assert.deepEqual(await host.advance(4999), []);
		const [ticked] = await host.advance(1);
		assert.match(ticked?.band?.t === "text" ? ticked.band.text : "", /main · dirty 1 · no upstream/);
		const stored = (await host.state.get<{ dirty: number; checkedAt: number }>("lastSnapshot")).value;
		assert.equal(stored?.dirty, 1);
		assert.equal(stored?.checkedAt, 5000);
		const pulse = await host.command("pulse");
		assert.equal(pulse.card?.t, "text");
		assert.match(pulse.text, /dirty 1/);
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("watch observes local ahead/behind and counts a staged rename with newline paths once", async () => {
	const cwd = workspace();
	git(cwd, "init", "-q", "-b", "main");
	writeFileSync(path.join(cwd, "? original\nname.txt"), "fixture\n");
	git(cwd, "add", "--all");
	git(cwd, "commit", "-qm", "initial fixture");
	const initial = git(cwd, "rev-parse", "HEAD");
	git(cwd, "remote", "add", "origin", path.join(cwd, "uncontacted-origin"));
	git(cwd, "update-ref", "refs/remotes/origin/main", initial);
	git(cwd, "config", "branch.main.remote", "origin");
	git(cwd, "config", "branch.main.merge", "refs/heads/main");
	const host = await createExtensionTestHost(ROOT, { workspace: cwd });
	try {
		writeFileSync(path.join(cwd, "second.txt"), "fixture two\n");
		git(cwd, "add", "--all");
		git(cwd, "commit", "-qm", "second fixture");
		const ahead = await host.observe({ event: "fs_changed", paths: [".git/HEAD", ".git/index"] });
		assert.match(ahead?.text ?? "", /ahead 1 · behind 0/);
		const second = git(cwd, "rev-parse", "HEAD");
		git(cwd, "update-ref", "refs/remotes/origin/main", second);
		git(cwd, "reset", "--hard", initial);
		assert.match((await host.command("pulse")).text, /ahead 0 · behind 1/);
		git(cwd, "mv", "? original\nname.txt", "renamed\nname.txt");
		const renamed = await host.observe({ event: "fs_changed", paths: [".git/index"] });
		assert.match(renamed?.text ?? "", /dirty 1/);
		git(cwd, "checkout", "--detach", "-q", initial);
		assert.match((await host.command("pulse")).text, new RegExp(`detached@${initial.slice(0, 8)}`));
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a non-repository reports unavailable facts without inventing a clean snapshot", async () => {
	const cwd = workspace();
	mkdirSync(path.join(cwd, "empty"));
	const host = await createExtensionTestHost(ROOT, { workspace: cwd });
	try {
		const pulse = await host.command("pulse");
		assert.match(pulse.text, /Git unavailable/);
		assert.equal(pulse.status?.tone, "warning");
		assert.match(pulse.status?.text ?? "", /upstream \?/);
		assert.equal((await host.state.get<{ dirty: null }>("lastSnapshot")).value?.dirty, null);
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
