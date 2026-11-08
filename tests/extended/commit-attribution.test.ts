import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	attributeCommitMessage,
	CLIO_COMMIT_EMAIL,
	CLIO_COMMIT_IDENTITY,
	CLIO_COMMIT_TRAILERS,
	CLIO_DECISION_TRAILER_CAP,
	decisionTrailerRefs,
} from "../../src/core/commit-attribution.js";
import {
	enterAutonomousCommitScope,
	setAutonomousCommitProcess,
	setCommitDecisionRefsProvider,
	setGitCommitAttributionEnabled,
	setGitCommitAuthorSetting,
	withManagedGitCommitAttributionEnvironment,
} from "../../src/core/git-commit-attribution.js";
import type { ExecutionPlan, ExecutionPlanCodeStep } from "../../src/domains/dispatch/execution-plan.js";
import { deriveFleetCommitAttribution } from "../../src/domains/dispatch/fleet-commit-attribution.js";
import { commitWorktreePath } from "../../src/tools/task-worktree.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const REFS = ["interview-1/db_engine", "agent:a1b2/cache-key-shape"];

describe("Clio-Decision commit trailer", () => {
	it("renders one sorted trailer per ref, idempotently, after the role trailers", () => {
		const once = attributeCommitMessage("feat: add cache\n", { materiallyAuthored: true, decisions: REFS });
		strictEqual(
			once,
			[
				"feat: add cache",
				"",
				CLIO_COMMIT_TRAILERS.assisted,
				CLIO_COMMIT_TRAILERS.coAuthored,
				"Clio-Decision: agent:a1b2/cache-key-shape",
				"Clio-Decision: interview-1/db_engine",
				"",
			].join("\n"),
		);
		strictEqual(attributeCommitMessage(once, { materiallyAuthored: true, decisions: REFS }), once);
	});

	it("respects a human-cased duplicate and drops a repeated Clio line", () => {
		const message = "fix: thing\n\nclio-decision: INTERVIEW-1/db\nClio-Decision: interview-1/db\n";
		const result = attributeCommitMessage(message, { decisions: ["interview-1/db"] });
		strictEqual(result, "fix: thing\n\nclio-decision: INTERVIEW-1/db\n");
	});

	it("writes only well-formed refs and caps the count", () => {
		deepStrictEqual(
			decisionTrailerRefs(["b/k", "a/k", "a/k", "nokey", "a/Bad Key", "x/k\nInjected: y", "/k", "a/", "a/_k", "a/k-"]),
			["a/k", "b/k"],
		);
		const many = Array.from(
			{ length: CLIO_DECISION_TRAILER_CAP + 5 },
			(_, index) => `i/k-${String(index).padStart(2, "0")}`,
		);
		strictEqual(decisionTrailerRefs(many).length, CLIO_DECISION_TRAILER_CAP);
		const message = attributeCommitMessage("chore: x", { decisions: ["x/k\nInjected: y"] });
		strictEqual(message, "chore: x\n");
	});

	it("adds nothing when evidence carries no decisions", () => {
		strictEqual(
			attributeCommitMessage("chore: x\n", { validationSucceeded: true }),
			`chore: x\n\n${CLIO_COMMIT_TRAILERS.tested}\n`,
		);
	});
});

describe("fleet commit seam", () => {
	it("takes the decision refs from the committed step's sealed receipt", () => {
		const agentStep = { id: "build", kind: "agent", scope: "workspace" } as unknown as ExecutionPlan["steps"][number];
		const commitStep = { id: "commit", kind: "code", commitFrom: ["build"] } as unknown as ExecutionPlanCodeStep;
		const plan = { steps: [agentStep, commitStep] } as unknown as ExecutionPlan;
		const digest = "a".repeat(64);
		const evidence = deriveFleetCommitAttribution({
			plan,
			step: commitStep,
			priorResults: new Map([["build", { succeeded: true, integrityValid: true, runDigest: digest, decisionRefs: REFS }]]),
			validationFresh: true,
			independentReviewFresh: false,
		});
		deepStrictEqual(evidence.decisions, REFS);
		strictEqual(evidence.materiallyAuthored, true);
		strictEqual(evidence.run?.digest, digest);
		const bare = deriveFleetCommitAttribution({
			plan,
			step: commitStep,
			priorResults: new Map([["build", { succeeded: true, integrityValid: true, runDigest: digest }]]),
			validationFresh: false,
			independentReviewFresh: false,
		});
		strictEqual("decisions" in bare, false);
	});
});

describe("session commit seam", () => {
	const roots: string[] = [];
	afterEach(() => {
		setCommitDecisionRefsProvider(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function outsideGit(): string {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-commit-decisions-"));
		roots.push(root);
		return root;
	}

	it("passes the live board's active refs through the spawn environment like assistance", () => {
		setCommitDecisionRefsProvider(() => ["interview-1/db", "agent:a1b2/cache-key-shape", "bad ref"]);
		const { env } = withManagedGitCommitAttributionEnvironment({}, { cwd: outsideGit(), enabled: true });
		strictEqual(env.CLIO_CODER_COMMIT_ASSISTED, "1");
		strictEqual(env.CLIO_CODER_COMMIT_DECISIONS, "agent:a1b2/cache-key-shape interview-1/db");
	});

	it("prefers explicit spawn evidence over the provider and omits the variable when empty", () => {
		setCommitDecisionRefsProvider(() => ["interview-1/db"]);
		const explicit = withManagedGitCommitAttributionEnvironment(
			{},
			{ cwd: outsideGit(), enabled: true, evidence: { materiallyAssisted: true, decisions: ["agent:z/only"] } },
		);
		strictEqual(explicit.env.CLIO_CODER_COMMIT_DECISIONS, "agent:z/only");
		setCommitDecisionRefsProvider(() => []);
		const empty = withManagedGitCommitAttributionEnvironment({}, { cwd: outsideGit(), enabled: true });
		strictEqual("CLIO_CODER_COMMIT_DECISIONS" in empty.env, false);
	});

	it("strips an inherited value so a nested seam starts clean", () => {
		const { env } = withManagedGitCommitAttributionEnvironment(
			{ CLIO_CODER_COMMIT_DECISIONS: "forged/ref" },
			{ cwd: outsideGit(), enabled: false },
		);
		strictEqual("CLIO_CODER_COMMIT_DECISIONS" in env, false);
		ok(!("CLIO_CODER_COMMIT_ASSISTED" in env));
		match(env.CLIO_CODER_GIT_COMMITS_ENABLED ?? "", /^0$/u);
	});
});

describe("Clio commit identity", () => {
	it("rewrites a role trailer naming the earlier address to the current identity, once", () => {
		const message =
			"feat: x\n\nBody.\n\nCo-authored-by: Clio Coder <clio-coder@iowarp.ai>\nSigned-off-by: H <h@example.com>\n";
		const once = attributeCommitMessage(message, { materiallyAuthored: true });
		const coAuthors = once.split("\n").filter((line) => /^co-authored-by:/iu.test(line));
		deepStrictEqual(coAuthors, [CLIO_COMMIT_TRAILERS.coAuthored]);
		strictEqual(attributeCommitMessage(once, { materiallyAuthored: true }), once);
	});

	it("lands Co-authored-by in the final trailer paragraph Git and GitHub parse, through the managed hook", async () => {
		const isolated = await isolateClioEnv("clio-coder-commit-identity-");
		try {
			const repo = join(isolated.dir, "repo");
			mkdirSync(repo);
			const git = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
				execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
			git(["init", "-q"]);
			git(["config", "user.name", "Human"]);
			git(["config", "user.email", "human@example.com"]);
			const { env, diagnostic } = withManagedGitCommitAttributionEnvironment(process.env, { cwd: repo, enabled: true });
			strictEqual(diagnostic, null);
			git(["commit", "-q", "--allow-empty", "-m", "feat: x\n\nBody.\nFixes #12"], env);
			const paragraphs = git(["log", "-1", "--format=%B"]).trimEnd().split("\n\n");
			deepStrictEqual(paragraphs.at(-1)?.split("\n"), [CLIO_COMMIT_TRAILERS.assisted, CLIO_COMMIT_TRAILERS.coAuthored]);
			strictEqual(git(["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)"]).trim(), CLIO_COMMIT_IDENTITY);
		} finally {
			isolated.restore();
		}
	});
});

describe("autonomous commit authorship", () => {
	const HUMAN = "Human <human@example.com>";
	const CLIO = `Clio Coder <${CLIO_COMMIT_EMAIL}>`;

	afterEach(() => {
		setAutonomousCommitProcess(false);
	});

	it("swaps Clio's trailers for the human co-author and keeps every other trailer", () => {
		const message = attributeCommitMessage(
			`feat: x\n\n${CLIO_COMMIT_TRAILERS.assisted}\n${CLIO_COMMIT_TRAILERS.coAuthored}\nSigned-off-by: ${HUMAN}\n`,
			{ materiallyAuthored: true, decisions: ["i/k"] },
			true,
			{ clioAuthorFor: HUMAN },
		);
		strictEqual(message, `feat: x\n\nSigned-off-by: ${HUMAN}\nCo-authored-by: ${HUMAN}\nClio-Decision: i/k\n`);
		strictEqual(attributeCommitMessage("feat: x", {}, true, { clioAuthorFor: CLIO }), "feat: x\n");
	});

	async function withRepo(run: (repo: string, git: (args: string[], env?: NodeJS.ProcessEnv) => string) => void) {
		const isolated = await isolateClioEnv("clio-coder-commit-author-");
		try {
			const repo = join(isolated.dir, "repo");
			mkdirSync(repo);
			const git = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
				execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
			git(["init", "-q"]);
			git(["config", "user.name", "Human"]);
			git(["config", "user.email", "human@example.com"]);
			setGitCommitAttributionEnabled(true);
			setGitCommitAuthorSetting("auto");
			run(repo, git);
		} finally {
			isolated.restore();
		}
	}

	function commitThroughSeam(
		repo: string,
		git: (args: string[], env?: NodeJS.ProcessEnv) => string,
		source = process.env,
	) {
		const { env, diagnostic } = withManagedGitCommitAttributionEnvironment(source, {
			cwd: repo,
			enabled: true,
			evidence: { materiallyAuthored: true },
		});
		strictEqual(diagnostic, null);
		git(["commit", "-q", "--allow-empty", "-m", "feat: x"], env);
		return {
			ident: git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(),
			trailers: git(["log", "-1", "--format=%(trailers:only)"]).trim().split("\n"),
		};
	}

	it("makes Clio the author of an autonomous commit and the human its committer and co-author", async () => {
		await withRepo((repo, git) => {
			setAutonomousCommitProcess(true);
			const { ident, trailers } = commitThroughSeam(repo, git);
			strictEqual(ident, `${CLIO}|${HUMAN}`);
			deepStrictEqual(trailers, [`Co-authored-by: ${HUMAN}`]);
		});
	});

	it("keeps the human author with Clio trailers for interactive work, the human setting, and an explicit author", async () => {
		await withRepo((repo, git) => {
			const interactive = commitThroughSeam(repo, git);
			strictEqual(interactive.ident, `${HUMAN}|${HUMAN}`);
			deepStrictEqual(interactive.trailers, [CLIO_COMMIT_TRAILERS.assisted, CLIO_COMMIT_TRAILERS.coAuthored]);

			setAutonomousCommitProcess(true);
			setGitCommitAuthorSetting("human");
			strictEqual(commitThroughSeam(repo, git).ident, `${HUMAN}|${HUMAN}`);

			setGitCommitAuthorSetting("auto");
			const chosen = commitThroughSeam(repo, git, { ...process.env, GIT_AUTHOR_NAME: "Op", GIT_AUTHOR_EMAIL: "op@x.io" });
			strictEqual(chosen.ident, `Op <op@x.io>|${HUMAN}`);
		});
	});

	function autonomousSeam(repo: string) {
		setAutonomousCommitProcess(true);
		const { env, diagnostic } = withManagedGitCommitAttributionEnvironment(process.env, { cwd: repo, enabled: true });
		strictEqual(diagnostic, null);
		return env;
	}

	it("keeps the human author on commands that write commits without the hook", async () => {
		await withRepo((repo, git) => {
			git(["commit", "-q", "--allow-empty", "-m", "init"]);
			const env = autonomousSeam(repo);
			const tree = git(["commit-tree", "-p", "HEAD", "-m", "plumbing", "HEAD^{tree}"], env).trim();
			strictEqual(git(["log", "-1", "--format=%an <%ae>", tree]).trim(), HUMAN);
			writeFileSync(join(repo, "a.txt"), "a\n");
			git(["add", "a.txt"]);
			git(["stash", "-q"], env);
			strictEqual(git(["log", "-1", "--format=%an <%ae>", "stash@{0}"]).trim(), HUMAN);
		});
	});

	it("credits the human on a revert finished after a conflict", async () => {
		await withRepo((repo, git) => {
			const write = (text: string) => writeFileSync(join(repo, "f.txt"), text);
			write("one\n");
			git(["add", "f.txt"]);
			git(["commit", "-q", "-m", "one"]);
			write("two\n");
			git(["commit", "-q", "-am", "two"]);
			write("three\n");
			git(["commit", "-q", "-am", "three"]);
			const env = autonomousSeam(repo);
			try {
				git(["revert", "--no-edit", "HEAD~1"], env);
			} catch {
				// The conflict is the point.
			}
			write("resolved\n");
			git(["add", "f.txt"]);
			git(["revert", "--continue"], { ...env, GIT_EDITOR: "true" });
			strictEqual(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(), `${CLIO}|${HUMAN}`);
			deepStrictEqual(git(["log", "-1", "--format=%(trailers:only)"]).trim().split("\n"), [`Co-authored-by: ${HUMAN}`]);
		});
	});

	it("credits the human after an operator's hooks run in a repository Clio's hook does not own", async () => {
		await withRepo((repo, git) => {
			const env = autonomousSeam(repo);
			const other = join(repo, "..", "other");
			const hooks = join(repo, "..", "operator-hooks");
			mkdirSync(other);
			mkdirSync(hooks);
			writeFileSync(join(hooks, "prepare-commit-msg"), '#!/bin/sh\nprintf "Operator-hook: ran\\n\\n" >> "$1"\n', {
				mode: 0o755,
			});
			const inOther = (args: string[], spawnEnv: NodeJS.ProcessEnv = process.env) =>
				execFileSync("git", args, { cwd: other, env: spawnEnv, encoding: "utf8" });
			inOther(["init", "-q"]);
			inOther(["config", "user.name", "Human"]);
			inOther(["config", "user.email", "human@example.com"]);
			inOther(["config", "core.hooksPath", hooks]);
			inOther(["commit", "-q", "--allow-empty", "-m", "feat: y"], env);
			strictEqual(inOther(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(), `${CLIO}|${HUMAN}`);
			const message = inOther(["log", "-1", "--format=%B"]);
			match(message, /Operator-hook: ran/);
			deepStrictEqual(inOther(["log", "-1", "--format=%(trailers:only)"]).trim().split("\n").slice(-1), [
				`Co-authored-by: ${HUMAN}`,
			]);
		});
	});

	it("leaves the human author when no committer identity is configured, so nobody is dropped", async () => {
		await withRepo((repo, git) => {
			git(["config", "--unset", "user.name"]);
			git(["config", "--unset", "user.email"]);
			const release = enterAutonomousCommitScope();
			try {
				const env = { ...process.env, GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" };
				const { env: spawned } = withManagedGitCommitAttributionEnvironment(env, { cwd: repo, enabled: true });
				ok(spawned.GIT_AUTHOR_EMAIL !== CLIO_COMMIT_EMAIL);
			} finally {
				release();
			}
		});
	});

	it("lands a worker's worktree as Clio with the human co-author, unless attribution is off", async () => {
		await withRepo((repo, git) => {
			git(["commit", "-q", "--allow-empty", "-m", "init"]);
			writeFileSync(join(repo, "a.txt"), "a\n");
			commitWorktreePath(repo, "clio", "task: a", { authoredPaths: null });
			strictEqual(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(), `${CLIO}|${HUMAN}`);
			strictEqual(git(["log", "-1", "--format=%B"]), `task: a\n\nCo-authored-by: ${HUMAN}\n\n`);

			setGitCommitAttributionEnabled(false);
			writeFileSync(join(repo, "b.txt"), "b\n");
			commitWorktreePath(repo, "clio", "task: b", { authoredPaths: null });
			strictEqual(git(["log", "-1", "--format=%an <%ae>"]).trim(), HUMAN);
			strictEqual(git(["log", "-1", "--format=%B"]), "task: b\n\n");
		});
	});
});
