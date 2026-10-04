#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { git, run, source } from "./release-candidate.mjs";
import { api } from "./release-publish.mjs";

const repository = "iowarp/clio-coder";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function recentRun(workflow, branch, commit, since = "") {
	return api(
		`repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=100`,
	).workflow_runs.find((record) => record.head_sha === commit && record.created_at >= since);
}

async function dispatch(workflow, branch, commit, fields) {
	const since = new Date(Date.now() - 1000).toISOString();
	run("gh", [
		"workflow",
		"run",
		workflow,
		"--repo",
		repository,
		"--ref",
		branch,
		...Object.entries(fields).flatMap(([name, value]) => ["--field", `${name}=${value}`]),
	]);
	for (let attempt = 0; attempt < 18; attempt++) {
		const record = await recentRun(workflow, branch, commit, since);
		if (record) return record;
		await delay(5000);
	}
	throw new Error("Dispatch accepted but its run was not visible. Inspect Actions before retrying.");
}

async function watch(record) {
	console.log(record.html_url);
	if (record.status !== "completed")
		run("gh", ["run", "watch", String(record.id), "--repo", repository, "--exit-status", "--interval", "10"]);
	const finished = api(`repos/${repository}/actions/runs/${record.id}`);
	if (finished.conclusion !== "success")
		throw new Error(`Run ${record.id} did not pass. Resume its failed jobs after correcting the cause.`);
}

async function main() {
	const { values } = parseArgs({
		options: { rehearse: { type: "boolean" }, platforms: { type: "boolean" }, help: { type: "boolean" } },
	});
	if (values.help) {
		console.log(
			"pnpm run release [-- --platforms]\npnpm run release:rehearse [-- --platforms]\nInteractive qualification and publication. The release environment requires the owner's final approval.\nRehearsal uses ci-scratch-* and makes no package, tag, main, or site changes.",
		);
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Run this interactive command in a visible terminal.");
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const ask = async (description) => {
		const reply = await prompt.question(`${description}\nContinue? [y/N] `);
		if (!/^y(?:es)?$/iu.test(reply.trim())) throw new Error("Stopped at your request. No later step was executed.");
	};
	let scratchBranch;
	let scratchDirectory;
	try {
		const commit = source();
		const branch = git("branch", "--show-current");
		if (!/^v\d{3}$/u.test(branch)) throw new Error("Start from the clean version branch, such as v062.");
		run("git", ["fetch", "origin"]);
		run("git", ["merge-base", "--is-ancestor", "origin/main", commit], { stdio: "pipe" });
		let qualification = await recentRun("ci.yml", branch, commit);
		if (qualification?.conclusion !== "success" || values.rehearse) {
			await ask(`Qualify ${branch} at ${commit} locally before pushing. Successful qualification is reused on retries.`);
			run(process.execPath, ["scripts/release-candidate.mjs", "qualify"]);
			if (values.rehearse) {
				scratchBranch = `ci-scratch-release-${Date.now()}`;
				await ask(`Push ${commit} to temporary ${scratchBranch} and run one non-public qualification/rehearsal.`);
				run("git", ["push", "origin", `${commit}:refs/heads/${scratchBranch}`]);
			} else {
				await ask(`Synchronize ${branch} with origin and dispatch its package qualification. This publishes nothing.`);
				run("git", ["push", "--set-upstream", "origin", branch]);
			}
			qualification = await dispatch("ci.yml", scratchBranch ?? branch, commit, {
				sha: commit,
				version_branch: branch,
				rehearse: Boolean(values.rehearse),
				platforms: Boolean(values.platforms),
			});
			await watch(qualification);
		} else {
			console.log(`Reusing qualification ${qualification.html_url}; no build or test rerun.`);
			const artifacts = api(`repos/${repository}/actions/runs/${qualification.id}/artifacts?per_page=100`).artifacts;
			for (const name of [`candidate-${commit}`, `results-${commit}`])
				if (!artifacts.some((artifact) => artifact.name === name && !artifact.expired))
					throw new Error("Qualification artifact expired; run qualification again before publishing.");
		}
		if (values.rehearse) {
			console.log("Non-public rehearsal passed. No release was published.");
			return;
		}
		scratchDirectory = mkdtempSync(join(tmpdir(), "clio-release-review-"));
		for (const name of [`candidate-${commit}`, `results-${commit}`])
			run("gh", [
				"run",
				"download",
				String(qualification.id),
				"--repo",
				repository,
				"--name",
				name,
				"--dir",
				scratchDirectory,
			]);
		run(process.execPath, [
			"scripts/release-publish.mjs",
			"verify",
			"--directory",
			scratchDirectory,
			"--sha",
			commit,
			"--run",
			String(qualification.id),
			"--branch",
			branch,
		]);
		await ask(
			"Request the owner's final GitHub approval for npm, GitHub release/tag, main, website, and branch cleanup? Review the receipt above first.",
		);
		const publication = await dispatch("release.yml", branch, commit, {
			sha: commit,
			qualification_run: qualification.id,
		});
		console.log(
			"Open the run above and approve the protected release environment as the owner. Agents must leave that decision to you.",
		);
		await watch(publication);
		await ask(
			"The public release completed. Update clean local main to origin/main and remove this finished local version branch?",
		);
		run("git", ["fetch", "origin", "--prune"]);
		const worktrees = git("worktree", "list", "--porcelain").split("\n\n");
		const mainTree = worktrees
			.find((entry) => entry.includes("branch refs/heads/main"))
			?.split("\n")[0]
			?.slice("worktree ".length);
		if (!mainTree) throw new Error("No main worktree is present; synchronize it manually.");
		if (git("-C", mainTree, "status", "--porcelain"))
			throw new Error("Local main is dirty; keep its edits and synchronize it manually.");
		run("git", ["-C", mainTree, "merge", "--ff-only", "origin/main"]);
		if (git("rev-parse", "origin/main") === commit) {
			run("git", ["switch", "--detach", commit]);
			run("git", ["branch", "-d", branch]);
		}
	} finally {
		prompt.close();
		if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
		if (scratchBranch) run("git", ["push", "origin", `:refs/heads/${scratchBranch}`]);
	}
}

main().catch((error) => {
	console.error(`release: ${error.message}`);
	process.exitCode = 1;
});
