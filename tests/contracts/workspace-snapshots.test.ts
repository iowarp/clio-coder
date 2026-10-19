import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SafetyContract, SafetyDecision } from "../../src/domains/safety/contract.js";
import {
	createWorkspaceSnapshots,
	type WorkspaceSnapshotOutcome,
	type WorkspaceSnapshotRequest,
} from "../../src/domains/workspace-snapshots/index.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Workspace snapshots: a private-index Git commit of the work tree, deduped,
 * restorable with /rewind, and taken by the main registry before the first
 * mutating call of a turn and before every destructive one.
 */

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

describe("workspace snapshots", () => {
	let env: IsolatedClioEnv;
	let repo: string;
	let stateDir: string;

	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-snapshots-");
		repo = path.join(env.dir, "repo");
		stateDir = path.join(env.dir, "state");
		mkdirSync(repo);
		git(repo, "init", "-q");
		writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
		writeFileSync(path.join(repo, "a.txt"), "tracked\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "init");
		writeFileSync(path.join(repo, "u.txt"), "untracked\n");
		writeFileSync(path.join(repo, "z.log"), "ignored\n");
		writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(2048, 1));
	});

	afterEach(() => env.restore());

	const store = () => createWorkspaceSnapshots({ stateDir, sessionId: "s-1", cwd: repo, maxUntrackedBytes: 1024 });
	const operatorIndex = () => readFileSync(path.join(repo, ".git", "index"));

	it("captures tracked and untracked files, skips ignored and oversized ones, dedups, and leaves the index alone", async () => {
		const index = operatorIndex();
		const head = git(repo, "rev-parse", "HEAD");
		const first = await store().snapshot({ reason: "turn-start", tool: ToolNames.Edit });
		ok(first.kind === "taken", JSON.stringify(first));
		strictEqual(first.reused, false);
		deepStrictEqual(first.record.skipped, [{ path: "big.bin", why: "too-large", bytes: 2048 }]);
		deepStrictEqual(git(repo, "ls-tree", "-r", "--name-only", first.record.commit).split("\n"), [
			".gitignore",
			"a.txt",
			"u.txt",
		]);
		strictEqual(git(repo, "rev-parse", "refs/clio-coder/snapshots/s-1/1"), first.record.commit);

		const again = await store().snapshot({ reason: "turn-start" });
		ok(again.kind === "taken" && again.reused && again.record.n === 1, JSON.stringify(again));
		deepStrictEqual(operatorIndex(), index);
		strictEqual(git(repo, "rev-parse", "HEAD"), head);
	});

	it("rewinds by overwriting, recreating and removing files, never touching ignored or oversized ones", async () => {
		const index = operatorIndex();
		const snapshots = store();
		ok((await snapshots.snapshot({ reason: "turn-start" })).kind === "taken");
		writeFileSync(path.join(repo, "a.txt"), "edited\n");
		rmSync(path.join(repo, "u.txt"));
		mkdirSync(path.join(repo, "src"));
		writeFileSync(path.join(repo, "src", "new.txt"), "new\n");
		writeFileSync(path.join(repo, "z.log"), "ignored, edited\n");

		const preview = await snapshots.preview(1);
		ok(preview.kind === "plan", JSON.stringify(preview));
		deepStrictEqual([preview.plan.restore, preview.plan.remove], [["a.txt", "u.txt"], ["src/new.txt"]]);

		const outcome = await snapshots.restore(1);
		ok(outcome.kind === "restored", JSON.stringify(outcome));
		strictEqual(outcome.preRewind.n, 2);
		strictEqual(readFileSync(path.join(repo, "a.txt"), "utf8"), "tracked\n");
		strictEqual(readFileSync(path.join(repo, "u.txt"), "utf8"), "untracked\n");
		strictEqual(existsSync(path.join(repo, "src")), false);
		strictEqual(readFileSync(path.join(repo, "z.log"), "utf8"), "ignored, edited\n");
		strictEqual(existsSync(path.join(repo, "big.bin")), true);
		deepStrictEqual(operatorIndex(), index);

		// The pre-rewind snapshot makes the rewind itself undoable.
		ok((await snapshots.restore(2)).kind === "restored");
		strictEqual(readFileSync(path.join(repo, "a.txt"), "utf8"), "edited\n");
		strictEqual(readFileSync(path.join(repo, "src", "new.txt"), "utf8"), "new\n");
		strictEqual(existsSync(path.join(repo, "u.txt")), false);
	});

	it("is unavailable outside a Git work tree", async () => {
		const plain = path.join(env.dir, "plain");
		mkdirSync(plain);
		const outcome = await createWorkspaceSnapshots({ stateDir, sessionId: "s-1", cwd: plain }).snapshot({
			reason: "turn-start",
		});
		deepStrictEqual(outcome.kind === "unavailable" ? outcome.reason : outcome, "not a git repository");
	});
});

describe("registry snapshot trigger", () => {
	/** Every call is admitted with its tool's base class; the trigger reads bash commands itself. */
	const safety: SafetyContract = {
		...createWorkerSafety(),
		evaluate(call): SafetyDecision {
			const actionClass = call.tool === ToolNames.Write ? "write" : call.tool === ToolNames.Read ? "read" : "execute";
			return { kind: "allow", classification: { actionClass, reasons: [] } };
		},
	};

	it("takes one snapshot for a turn's first mutating call and one before each destructive call", async () => {
		const requests: Array<WorkspaceSnapshotRequest & { sessionId?: string }> = [];
		let next: WorkspaceSnapshotOutcome["kind"] = "taken";
		const registry = createRegistry({
			safety,
			autonomy: () => "yolo",
			workspaceSnapshot: async (request) => {
				requests.push(request);
				return next === "taken"
					? {
							kind: "taken",
							reused: false,
							durationMs: 1,
							record: { n: requests.length, at: "", reason: request.reason, tree: "", commit: "", ref: "", skipped: [] },
						}
					: { kind: "unavailable", reason: "not a git repository", durationMs: 1 };
			},
		});
		for (const name of [ToolNames.Write, ToolNames.Read, ToolNames.Bash]) {
			registry.register({
				name,
				description: `${name} fixture`,
				parameters: Type.Object({}),
				baseActionClass: name === ToolNames.Write ? "write" : name === ToolNames.Read ? "read" : "execute",
				run: async () => ({ kind: "ok", output: `${name} ran` }),
			});
		}
		const turn = { sessionId: "s-1", turnId: "t-1" };
		await registry.invoke({ tool: ToolNames.Read, args: {} }, turn);
		await registry.invoke({ tool: ToolNames.Write, args: {} }, { ...turn, toolCallId: "c-1" });
		await registry.invoke({ tool: ToolNames.Write, args: {} }, turn);
		await registry.invoke({ tool: ToolNames.Bash, args: { command: "git checkout -- ." } }, turn);
		await registry.invoke({ tool: ToolNames.Bash, args: { command: "rm notes.txt" } }, turn);
		deepStrictEqual(
			requests.map((request) => [request.reason, request.tool, request.turnId]),
			[
				["turn-start", ToolNames.Write, "t-1"],
				["git-discard", ToolNames.Bash, "t-1"],
				["delete", ToolNames.Bash, "t-1"],
			],
		);
		strictEqual(requests[0]?.toolCallId, "c-1");

		next = "unavailable";
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: {} }, { ...turn, turnId: "t-2" });
		strictEqual(requests.length, 4);
		ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
		ok(verdict.result.output.startsWith(`${ToolNames.Write} ran`));
		ok(verdict.result.output.includes("no snapshot: not a git repository"), verdict.result.output);
	});
});
