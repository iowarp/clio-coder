import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	cleanupFleetChangeReturn,
	importFleetChanges,
	prepareFleetChangeReturn,
} from "../../src/domains/dispatch/fleet-change-return.js";
import { applyTaskWorktree, createTaskWorktree, previewTaskWorktree } from "../../src/tools/task-worktree.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

const node = { id: "worker", host: "worker.invalid" };

describe("SSH task change return", () => {
	let env: IsolatedClioEnv;
	let client: string;
	let server: string;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-ssh-return-");
		client = join(env.dir, "client");
		server = join(env.dir, "server");
		const bin = join(env.dir, "bin");
		mkdirSync(client);
		mkdirSync(bin);
		git(client, "init", "-q", "-b", "main");
		git(client, "config", "user.name", "Contract");
		git(client, "config", "user.email", "contract@example.invalid");
		git(client, "config", "commit.gpgsign", "false");
		writeFileSync(join(client, "math.js"), "export const add = (a, b) => a + b;\n");
		git(client, "add", ".");
		git(client, "commit", "-qm", "base");
		git(client, "clone", "-q", client, server);
		git(server, "config", "commit.gpgsign", "false");
		// The fake channel maps identical node paths onto an independent local clone.
		// Upload-pack must keep its stdin live; only Node operations consume JSON.
		writeFileSync(
			join(bin, "ssh"),
			`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const client=${JSON.stringify(client)},server=${JSON.stringify(server)};
// Parsed as real ssh does: options, one host, then everything left is the remote command.
const words=process.argv.slice(2);
for(;;){if(['-o','-p','-i','-l'].includes(words[0]))words.splice(0,2);else if(words[0]==='-T')words.shift();else break;}
words.shift();
if(words[0]==='--')words.shift();
const command=words.join(' ').split(client).join(server);
const operation=command.startsWith('node -e ');
const options={stdio:operation?['pipe','inherit','inherit']:'inherit'};
if(operation)options.input=fs.readFileSync(0,'utf8').split(client).join(server);
const result=cp.spawnSync('sh',['-c',command],options);
process.exit(result.status??1);
`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${bin}:${process.env.PATH}`;
	});
	afterEach(() => env.restore());

	it("imports an allowed commit only into the task tree before guarded application and cleanup", async () => {
		const worktree = createTaskWorktree(client, "allowed");
		const remote = await prepareFleetChangeReturn(node, worktree);
		const remotePath = worktree.path.replace(client, server);
		const content = "export const add = (a, b) => Number(a) + Number(b);\n";
		writeFileSync(join(remotePath, "math.js"), content);
		writeFileSync(join(remotePath, "sum.js"), "export const sum = 0;\n");
		mkdirSync(join(remotePath, "__pycache__"));
		writeFileSync(join(remotePath, "__pycache__", "x.pyc"), "byproduct\n");
		const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		writeFileSync(
			join(env.dir, "bin", "git"),
			`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),remotePath=${JSON.stringify(remotePath)};
const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(result.status===0&&args[args.indexOf('-C')+1]===remotePath&&args.includes('commit'))fs.writeFileSync(remotePath+'/late.txt','created after commit\\n');
process.exit(result.status??1);
`,
			{ mode: 0o755 },
		);
		const imported = await importFleetChanges(remote, [join(worktree.path, "sum.js")], [worktree.path], []);
		const { commit } = imported;
		strictEqual(git(worktree.path, "show", "--name-only", "--format=", commit), "math.js\nsum.js");
		deepStrictEqual(imported.leftUncommitted, { count: 2, paths: ["__pycache__/x.pyc", "late.txt"] });
		strictEqual(readFileSync(join(remotePath, "late.txt"), "utf8"), "created after commit\n");
		strictEqual(git(client, "rev-parse", "HEAD"), worktree.base);
		strictEqual(git(worktree.path, "rev-parse", "HEAD"), commit);
		strictEqual(readFileSync(join(worktree.path, "math.js"), "utf8"), content);
		const applied = applyTaskWorktree({
			worktree,
			apply: "merge",
			preview: previewTaskWorktree(worktree, commit),
			authoredPaths: [],
		});
		strictEqual(applied.applied, true);
		strictEqual(readFileSync(join(client, "math.js"), "utf8"), content);
		await cleanupFleetChangeReturn(remote, imported);
		strictEqual(existsSync(remotePath), false);
		strictEqual(git(server, "branch", "--list", "--format=%(refname:short)", worktree.branch), "");
	});

	it("refuses a changed node baseline before creating a remote branch", async () => {
		const worktree = createTaskWorktree(client, "wrong-base");
		writeFileSync(join(server, "math.js"), "export const add = () => 0;\n");
		git(server, "add", ".");
		git(server, "-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", "commit", "-qm", "changed base");
		await rejects(prepareFleetChangeReturn(node, worktree), /baseline or clean tree changed/);
		strictEqual(git(client, "rev-parse", "HEAD"), worktree.base);
		strictEqual(git(server, "branch", "--list", "--format=%(refname:short)", worktree.branch), "");
	});

	it("refuses a path outside the permit and preserves the remote branch and worktree", async () => {
		const worktree = createTaskWorktree(client, "outside-permit");
		const remote = await prepareFleetChangeReturn(node, worktree);
		const remotePath = worktree.path.replace(client, server);
		writeFileSync(join(remotePath, "outside.txt"), "preserve this rejected change\n");
		await rejects(importFleetChanges(remote, null, [join(worktree.path, "math.js")], []), /path outside write permit/);
		strictEqual(git(client, "rev-parse", "HEAD"), worktree.base);
		strictEqual(git(worktree.path, "rev-parse", "HEAD"), worktree.base);
		ok(existsSync(remotePath));
		strictEqual(git(server, "branch", "--list", "--format=%(refname:short)", worktree.branch), worktree.branch);
		strictEqual(readFileSync(join(remotePath, "outside.txt"), "utf8"), "preserve this rejected change\n");
		const vendor = join(remotePath, "vendor");
		git(remotePath, "clone", "-q", server, vendor);
		mkdirSync(join(vendor, "src"));
		writeFileSync(join(vendor, "src", "worker.txt"), "before preview\n");
		const imported = await importFleetChanges(remote, [], [worktree.path], []);
		deepStrictEqual(imported.leftUncommitted, { count: 1, paths: ["vendor/"] });
		await rejects(
			cleanupFleetChangeReturn(remote, imported),
			/untracked directory vendor\/; destructive cleanup refused/,
		);
		writeFileSync(join(vendor, "src", "worker.txt"), "after preview\n");
		await rejects(
			cleanupFleetChangeReturn(remote, imported),
			/untracked directory vendor\/; destructive cleanup refused/,
		);
		strictEqual(readFileSync(join(vendor, "src", "worker.txt"), "utf8"), "after preview\n");
		strictEqual(git(server, "branch", "--list", "--format=%(refname:short)", worktree.branch), worktree.branch);
	});
});
