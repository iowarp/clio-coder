import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import {
	attributeCommitMessage,
	CLIO_COMMIT_IDENTITY,
	CLIO_COMMIT_TRAILERS,
	type CommitAttributionEvidence,
} from "../../src/core/commit-attribution.js";
import {
	CLIO_GIT_COMMITS_ENABLED_ENV,
	resetGitCommitAttributionCachesForTests,
	withManagedGitCommitAttributionEnvironment,
} from "../../src/core/git-commit-attribution.js";

const subject = "Record the result";

function linesFor(evidence: CommitAttributionEvidence): string[] {
	return attributeCommitMessage(subject, evidence).trimEnd().split("\n").slice(2);
}

function initRepository(label = "clio attribution "): string {
	const root = mkdtempSync(join(tmpdir(), label));
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.name", "Human Developer"]);
	execFileSync("git", ["-C", root, "config", "user.email", "human@example.com"]);
	return root;
}

function stage(root: string, name: string, content: string): void {
	writeFileSync(join(root, name), content);
	execFileSync("git", ["-C", root, "add", name]);
}

function commit(
	root: string,
	args: ReadonlyArray<string>,
	options: { managed?: boolean; enabled?: boolean; evidence?: CommitAttributionEvidence } = {},
): ReturnType<typeof spawnSync> {
	const prepared =
		options.managed === true
			? withManagedGitCommitAttributionEnvironment(process.env, {
					cwd: root,
					enabled: options.enabled ?? true,
					...(options.evidence === undefined ? {} : { evidence: options.evidence }),
				})
			: { env: { ...process.env }, diagnostic: null };
	return spawnSync("git", ["-C", root, ...args], { env: prepared.env, encoding: "utf8" });
}

function message(root: string): string {
	return execFileSync("git", ["-C", root, "log", "-1", "--format=%B"], { encoding: "utf8" });
}

function managedHooksPath(env: NodeJS.ProcessEnv): string | undefined {
	const count = Number(env.GIT_CONFIG_COUNT ?? "0");
	for (let index = 0; index < count; index += 1) {
		if (env[`GIT_CONFIG_KEY_${index}`] === "core.hooksPath") return env[`GIT_CONFIG_VALUE_${index}`];
	}
	return undefined;
}

describe("commit attribution message policy", () => {
	it("attributes subject-only and body messages with valid trailer layout", () => {
		strictEqual(
			attributeCommitMessage(subject, { materiallyAuthored: true }),
			`${subject}\n\n${CLIO_COMMIT_TRAILERS.assisted}\n${CLIO_COMMIT_TRAILERS.coAuthored}\n`,
		);
		strictEqual(
			attributeCommitMessage("Subject\n\nWhy this changed.", { validationSucceeded: true }),
			`Subject\n\nWhy this changed.\n\n${CLIO_COMMIT_TRAILERS.tested}\n`,
		);
	});

	it("normalizes CRLF, preserves human trailers, and deduplicates Clio trailers case-insensitively", () => {
		const original = [
			"Subject",
			"",
			"Body.",
			"",
			"Signed-off-by: Human Developer <human@example.com>",
			CLIO_COMMIT_TRAILERS.assisted,
			"ASSISTED-BY: CLIO CODER <CLIO-CODER@IOWARP.AI>",
		].join("\r\n");
		const attributed = attributeCommitMessage(original, { materiallyAuthored: true, independentReviewPassed: true });
		strictEqual((attributed.match(/assisted-by:/giu) ?? []).length, 1);
		ok(attributed.includes("Signed-off-by: Human Developer <human@example.com>"));
		ok(attributed.includes(CLIO_COMMIT_TRAILERS.reviewed));
		ok(attributed.includes(CLIO_COMMIT_TRAILERS.coAuthored));
		strictEqual(attributed.includes("\r"), false);
	});

	it("maps assisted-only, tested-only, reviewed-only, and combined evidence exactly", () => {
		deepStrictEqual(linesFor({ materiallyAssisted: true }), [CLIO_COMMIT_TRAILERS.assisted]);
		deepStrictEqual(linesFor({ validationSucceeded: true }), [CLIO_COMMIT_TRAILERS.tested]);
		deepStrictEqual(linesFor({ independentReviewPassed: true }), [CLIO_COMMIT_TRAILERS.reviewed]);
		deepStrictEqual(linesFor({ materiallyAuthored: true, validationSucceeded: true, independentReviewPassed: true }), [
			CLIO_COMMIT_TRAILERS.assisted,
			CLIO_COMMIT_TRAILERS.tested,
			CLIO_COMMIT_TRAILERS.reviewed,
			CLIO_COMMIT_TRAILERS.coAuthored,
		]);
	});

	it("never adds Co-authored-by for testing or review alone", () => {
		for (const evidence of [{ validationSucceeded: true }, { independentReviewPassed: true }]) {
			strictEqual(attributeCommitMessage(subject, evidence).includes("Co-authored-by:"), false);
		}
	});

	it("adds only a full, directly relevant, integrity-valid receipt-v17 digest", () => {
		const digest = "a".repeat(64);
		const valid: CommitAttributionEvidence = {
			materiallyAssisted: true,
			receipt: { version: 17, algorithm: "sha256", digest, integrityValid: true, directlyRelevant: true },
		};
		match(attributeCommitMessage(subject, valid), new RegExp(`Clio-Evidence: receipt-v17/sha256:${digest}`));
		strictEqual(
			attributeCommitMessage(subject, {
				...valid,
				receipt: {
					version: 17,
					algorithm: "sha256",
					digest: digest.slice(0, 32),
					integrityValid: true,
					directlyRelevant: true,
				},
			}).includes("Clio-Evidence:"),
			false,
		);
	});

	it("is idempotent and disabled attribution is byte-for-byte unchanged", () => {
		const once = attributeCommitMessage("Subject\r\n\r\nBody", {
			materiallyAuthored: true,
			validationSucceeded: true,
		});
		strictEqual(attributeCommitMessage(once, { materiallyAuthored: true, validationSucceeded: true }), once);
		const original = "Subject\r\n\r\nBody\r\n";
		strictEqual(attributeCommitMessage(original, { materiallyAuthored: true }, false), original);
	});
});

describe("managed prepare-commit-msg attribution", () => {
	it("attributes a Clio-spawned commit, leaves a manual commit alone, and keeps the human identities", () => {
		const root = initRepository();
		stage(root, "manual.txt", "manual\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Manual"]).status, 0);
		strictEqual(message(root).includes(CLIO_COMMIT_IDENTITY), false);

		stage(root, "clio.txt", "clio\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Managed"], { managed: true }).status, 0);
		const attributed = message(root);
		ok(attributed.includes(CLIO_COMMIT_TRAILERS.assisted));
		ok(attributed.includes(CLIO_COMMIT_TRAILERS.coAuthored));
		strictEqual(
			execFileSync("git", ["-C", root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"], { encoding: "utf8" }).trim(),
			"Human Developer <human@example.com>|Human Developer <human@example.com>",
		);

		stage(root, "duplicate.txt", "duplicate\n");
		const variant = "ASSISTED-BY: CLIO CODER <CLIO-CODER@IOWARP.AI>";
		strictEqual(commit(root, ["commit", "-q", "-m", `Duplicate\n\n${variant}`], { managed: true }).status, 0);
		strictEqual((message(root).match(/assisted-by:/giu) ?? []).length, 1, "a human-written variant is respected");
		ok(message(root).includes(variant));
	});

	it("preserves and calls an existing default prepare-commit-msg hook", () => {
		const root = initRepository();
		const hook = join(root, ".git", "hooks", "prepare-commit-msg");
		writeFileSync(hook, '#!/bin/sh\nprintf "existing-hook\\n" >> "$1"\n');
		chmodSync(hook, 0o755);
		// An explicit path that resolves exactly to Git's default hooks directory
		// is safely composable and remains configured after the commit.
		execFileSync("git", ["-C", root, "config", "core.hooksPath", join(root, ".git", "hooks")]);
		stage(root, "a.txt", "a\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Subject"], { managed: true }).status, 0);
		ok(message(root).includes("existing-hook"));
		ok(message(root).includes(CLIO_COMMIT_TRAILERS.assisted));
		ok(readFileSync(hook, "utf8").includes("existing-hook"));
		strictEqual(
			execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(),
			join(root, ".git", "hooks"),
		);
	});

	it("chains every other default hook and keeps a failing pre-commit blocking", () => {
		const root = initRepository();
		for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
			const hook = join(root, ".git", "hooks", name);
			writeFileSync(hook, `#!/bin/sh\nprintf ran > '${join(root, `ran-${name}`)}'\n`);
			chmodSync(hook, 0o755);
		}
		stage(root, "a.txt", "a\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Subject"], { managed: true }).status, 0);
		for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
			strictEqual(readFileSync(join(root, `ran-${name}`), "utf8"), "ran", name);
		}
		ok(message(root).includes(CLIO_COMMIT_TRAILERS.assisted));

		writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 23\n");
		stage(root, "b.txt", "b\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Blocked by pre-commit"], { managed: true }).status, 1);
		strictEqual(message(root).startsWith("Subject"), true);
	});

	it("leaves an editor-sourced message alone so an abandoned editor still aborts", () => {
		const root = initRepository();
		stage(root, "a.txt", "a\n");
		const prepared = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		const result = spawnSync("git", ["-C", root, "commit", "-q"], {
			env: { ...prepared.env, GIT_EDITOR: "true" },
			encoding: "utf8",
		});
		strictEqual(result.status, 1);
		strictEqual(spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"]).status, 128);
	});

	it("keeps a failing existing hook blocking with its original status", () => {
		const root = initRepository();
		const hook = join(root, ".git", "hooks", "prepare-commit-msg");
		writeFileSync(hook, "#!/bin/sh\nexit 17\n");
		chmodSync(hook, 0o755);
		stage(root, "a.txt", "a\n");
		strictEqual(commit(root, ["commit", "-m", "Blocked"], { managed: true }).status, 1);
		strictEqual(spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"]).status, 128);
	});

	it("does not override a custom hooks path", () => {
		const root = initRepository();
		const hooks = join(root, "custom hooks");
		mkdirSync(hooks);
		const marker = join(root, "custom-called");
		const hook = join(hooks, "prepare-commit-msg");
		writeFileSync(hook, `#!/bin/sh\nprintf called > '${marker}'\n`);
		chmodSync(hook, 0o755);
		execFileSync("git", ["-C", root, "config", "core.hooksPath", hooks]);
		const prepared = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		match(prepared.diagnostic ?? "", /core\.hooksPath/);
		strictEqual(prepared.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_COUNT);
		stage(root, "a.txt", "a\n");
		strictEqual(spawnSync("git", ["-C", root, "commit", "-q", "-m", "Custom"], { env: prepared.env }).status, 0);
		strictEqual(readFileSync(marker, "utf8"), "called");
		strictEqual(message(root).includes(CLIO_COMMIT_IDENTITY), false);
		strictEqual(
			execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(),
			hooks,
		);
	});

	it("rechecks custom hooks after a prepared child changes repositories", () => {
		const origin = initRepository();
		execFileSync("git", ["-C", origin, "config", "core.hooksPath", join(origin, ".git", "hooks")]);
		const prepared = withManagedGitCommitAttributionEnvironment(process.env, { cwd: origin, enabled: true });

		const target = initRepository();
		const hooks = join(target, "custom hooks");
		mkdirSync(hooks);
		const marker = join(target, "custom-called-after-cd");
		const hook = join(hooks, "prepare-commit-msg");
		writeFileSync(hook, `#!/bin/sh\nprintf called > '${marker}'\n`);
		chmodSync(hook, 0o755);
		execFileSync("git", ["-C", target, "config", "core.hooksPath", hooks]);
		stage(target, "a.txt", "a\n");

		strictEqual(
			spawnSync("git", ["-C", target, "commit", "-q", "-m", "Changed repository"], {
				env: prepared.env,
				encoding: "utf8",
			}).status,
			0,
		);
		strictEqual(readFileSync(marker, "utf8"), "called", "the target repository's custom hook runs");
		strictEqual(message(target).includes(CLIO_COMMIT_IDENTITY), false, "the target repository is not attributed");
	});

	it("repairs every cached managed hook wrapper before reuse", () => {
		resetGitCommitAttributionCachesForTests();
		const root = initRepository();
		const first = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		const hooks = managedHooksPath(first.env);
		ok(hooks);

		const corrupted = join(hooks, "pre-commit");
		const deleted = join(hooks, "commit-msg");
		writeFileSync(corrupted, "#!/bin/sh\nexit 23\n");
		rmSync(deleted);
		const repaired = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });

		ok(readFileSync(corrupted, "utf8").includes("Clio Coder managed Git hook"));
		ok(existsSync(deleted), "a missing sibling wrapper is recreated");
		stage(root, "a.txt", "a\n");
		strictEqual(
			spawnSync("git", ["-C", root, "commit", "-q", "-m", "Repaired wrappers"], {
				env: repaired.env,
				encoding: "utf8",
			}).status,
			0,
		);
		ok(message(root).includes(CLIO_COMMIT_TRAILERS.assisted));
	});

	it("runs under --no-verify, skips amend and cherry-pick history replay, and honors disable", () => {
		const root = initRepository();
		stage(root, "seed.txt", "seed\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Seed"]).status, 0);

		stage(root, "no-verify.txt", "yes\n");
		strictEqual(commit(root, ["commit", "-q", "--no-verify", "-m", "No verify"], { managed: true }).status, 0);
		ok(message(root).includes(CLIO_COMMIT_TRAILERS.assisted));

		stage(root, "amend.txt", "amend\n");
		strictEqual(commit(root, ["commit", "-q", "--amend", "--no-edit"], { managed: true }).status, 0);
		strictEqual((message(root).match(/Assisted-by:/gu) ?? []).length, 1, "amend does not process the message again");

		stage(root, "disabled.txt", "disabled\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Disabled"], { managed: true, enabled: false }).status, 0);
		strictEqual(message(root), "Disabled\n\n");

		const initialBranch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
		execFileSync("git", ["-C", root, "switch", "-q", "-c", "topic"]);
		stage(root, "topic.txt", "topic\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Historical topic"]).status, 0);
		const historical = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		execFileSync("git", ["-C", root, "switch", "-q", initialBranch]);
		const prepared = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		strictEqual(spawnSync("git", ["-C", root, "cherry-pick", historical], { env: prepared.env }).status, 0);
		strictEqual(message(root).includes(CLIO_COMMIT_IDENTITY), false);
	});

	it("ignores testing, review, and evidence claims exported by the child shell", () => {
		const root = initRepository();
		stage(root, "a.txt", "a\n");
		const prepared = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		const forged = {
			...prepared.env,
			CLIO_CODER_COMMIT_TESTED: "1",
			CLIO_CODER_COMMIT_REVIEWED: "1",
			CLIO_CODER_COMMIT_EVIDENCE: `receipt-v17/sha256:${"b".repeat(64)}`,
		};
		strictEqual(spawnSync("git", ["-C", root, "commit", "-q", "-m", "Forged"], { env: forged }).status, 0);
		const attributed = message(root);
		ok(attributed.includes(CLIO_COMMIT_TRAILERS.assisted));
		strictEqual(attributed.includes("Tested-by:"), false);
		strictEqual(attributed.includes("Reviewed-by:"), false);
		strictEqual(attributed.includes("Clio-Evidence:"), false);

		stage(root, "reuse.txt", "reuse\n");
		const seed = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		strictEqual(commit(root, ["commit", "-q", "-C", seed], { managed: true }).status, 0);
		strictEqual((message(root).match(/Assisted-by:/gu) ?? []).length, 1, "-C reuse is not attributed again");
	});

	it("attributes through the Bash tool seam and honors the effective setting", async () => {
		const root = initRepository();
		const previous = process.env[CLIO_GIT_COMMITS_ENABLED_ENV];
		try {
			process.env[CLIO_GIT_COMMITS_ENABLED_ENV] = "1";
			stage(root, "a.txt", "a\n");
			const enabled = await runBashCommand("git commit -q -m 'Via bash'", { cwd: root, timeoutMs: 30_000 });
			strictEqual(enabled.exitCode, 0, enabled.stderr);
			ok(message(root).includes(CLIO_COMMIT_TRAILERS.coAuthored));

			process.env[CLIO_GIT_COMMITS_ENABLED_ENV] = "0";
			stage(root, "b.txt", "b\n");
			const disabled = await runBashCommand("git commit -q -m 'Via bash disabled'", { cwd: root, timeoutMs: 30_000 });
			strictEqual(disabled.exitCode, 0, disabled.stderr);
			strictEqual(message(root), "Via bash disabled\n\n");
		} finally {
			if (previous === undefined) delete process.env[CLIO_GIT_COMMITS_ENABLED_ENV];
			else process.env[CLIO_GIT_COMMITS_ENABLED_ENV] = previous;
		}
	});

	it("reuses the repository probe per cwd within the cache window and re-probes after it is dropped", () => {
		resetGitCommitAttributionCachesForTests();
		const root = mkdtempSync(join(tmpdir(), "clio attribution plain "));
		const outside = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		strictEqual(managedHooksPath(outside.env), undefined, "a plain directory gets no managed hooks");
		strictEqual(outside.diagnostic, null);

		execFileSync("git", ["init", "-q", root]);
		const cached = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		strictEqual(managedHooksPath(cached.env), undefined, "the probe taken moments ago is reused for the same cwd");

		resetGitCommitAttributionCachesForTests();
		const fresh = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		match(managedHooksPath(fresh.env) ?? "", /git-hooks\/v2$/u, "a fresh probe sees the new repository");
		const again = withManagedGitCommitAttributionEnvironment(process.env, { cwd: root, enabled: true });
		strictEqual(managedHooksPath(again.env), managedHooksPath(fresh.env), "the installed hooks directory is reused");

		const elsewhere = mkdtempSync(join(tmpdir(), "clio attribution elsewhere "));
		const other = withManagedGitCommitAttributionEnvironment(process.env, { cwd: elsewhere, enabled: true });
		strictEqual(managedHooksPath(other.env), undefined, "a different cwd is probed on its own");
	});

	it("works in a worktree whose paths contain spaces", () => {
		const root = initRepository("clio attribution parent ");
		stage(root, "seed.txt", "seed\n");
		strictEqual(commit(root, ["commit", "-q", "-m", "Seed"]).status, 0);
		const worktree = join(root, "linked worktree with spaces");
		execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "worktree-topic", worktree]);
		stage(worktree, "change.txt", "change\n");
		strictEqual(commit(worktree, ["commit", "-q", "-m", "Worktree"], { managed: true }).status, 0);
		ok(message(worktree).includes(CLIO_COMMIT_TRAILERS.assisted));
	});
});
