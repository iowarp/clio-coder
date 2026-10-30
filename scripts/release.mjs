#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { git, run, source, verifyCandidate } from "./release-candidate.mjs";
import {
	api,
	forwardedTags,
	publicationPlan,
	registryTags,
	registryVersion,
	requireIntegrity,
} from "./release-publish.mjs";

const repository = "iowarp/clio-coder";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function recentRun(workflow, branch, commit, since = "") {
	return api(
		`repos/${repository}/actions/workflows/${workflow}/runs?${branch ? `branch=${encodeURIComponent(branch)}&` : ""}event=workflow_dispatch&head_sha=${commit}&per_page=100`,
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

// release.yml cannot authenticate to npm (its OIDC exchange returns 404), so the
// owner publishes the qualified bytes here, before the job writes to GitHub.
async function ownerPublish(receipt, plan, ask, foreground) {
	const published = await registryVersion(receipt.name, receipt.version);
	if (published) {
		requireIntegrity(published, receipt);
		console.log(`npm already contains the qualified bytes of ${plan.package}.`);
		return;
	}
	const args = ["publish", receipt.tarball, "--access", "public", "--tag", plan.channel];
	await ask(
		`npm has no ${plan.package}. Publish the qualified tarball as the owner:\n  npm ${args.join(" ")}\nnpm may ask for browser two-factor approval in this terminal.`,
	);
	foreground("npm", args);
	for (let attempt = 0; attempt < 30; attempt++) {
		const visible = await registryVersion(receipt.name, receipt.version);
		if (visible) {
			requireIntegrity(visible, receipt);
			console.log(`npm serves ${plan.package} with the qualified integrity.`);
			return;
		}
		console.log(`Waiting for npm to serve ${plan.package}...`);
		await delay(10_000);
	}
	throw new Error(
		`npm accepted the publish but has not served ${plan.package} for 5 minutes. Rerun \`pnpm run release\` once it is visible; matching bytes are reused.`,
	);
}

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((argument) => argument !== "--"),
		options: { rehearse: { type: "boolean" }, platforms: { type: "boolean" }, help: { type: "boolean" } },
	});
	if (values.help) {
		console.log(
			"pnpm run release [-- --platforms]\npnpm run release:rehearse [-- --platforms]\nInteractive qualification, owner npm publication, and release dispatch. The release environment requires the owner's final approval.\nRehearsal uses ci-scratch-* and makes no package, tag, main, or site changes.",
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
	// readline keeps the TTY raw; npm's login and two-factor prompts need it cooked.
	const foreground = (command, args) => {
		process.stdin.setRawMode(false);
		try {
			run(command, args);
		} finally {
			process.stdin.setRawMode(true);
		}
	};
	let scratchBranch;
	let scratchDirectory;
	try {
		const commit = source();
		const branch = git("branch", "--show-current");
		if (!/^v\d{3}$/u.test(branch)) throw new Error("Start from the clean version branch, such as v062.");
		run("git", ["fetch", "origin"]);
		run("git", ["merge-base", "--is-ancestor", "origin/main", commit], { stdio: "pipe" });
		let qualification = await recentRun("ci.yml", undefined, commit);
		if (qualification && !values.rehearse) {
			if (qualification.status !== "completed") await watch(qualification);
			else if (qualification.conclusion !== "success") {
				await ask(
					`Resume failed qualification jobs in ${qualification.html_url}? Passed jobs keep their artifacts and are not rerun.`,
				);
				run("gh", ["run", "rerun", String(qualification.id), "--repo", repository, "--failed"]);
				await watch({ ...qualification, status: "queued" });
			}
			qualification = api(`repos/${repository}/actions/runs/${qualification.id}`);
		}
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
			// A rehearsal qualifies on a scratch branch, so origin's version branch can still lack
			// the candidate that release.yml is dispatched against (#442). A plain push refuses
			// to move a diverged remote branch.
			await ask(`Synchronize ${branch} with origin by fast-forward before publishing. This publishes nothing.`);
			run("git", ["push", "--set-upstream", "origin", branch]);
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
		const candidate = verifyCandidate(scratchDirectory, commit);
		const plan = publicationPlan(candidate, branch);
		await ownerPublish(candidate, plan, ask, foreground);
		await ask(
			"Request the owner's final GitHub approval for the GitHub release/tag, main, website, and branch cleanup? Review the receipt above first.",
		);
		const publication = await dispatch("release.yml", branch, commit, {
			sha: commit,
			qualification_run: qualification.id,
		});
		console.log(
			"Open the run above and approve the protected release environment as the owner. Agents must leave that decision to you.",
		);
		await watch(publication);
		// The owner forwards npm tags after GitHub publication.
		const tags = forwardedTags(await registryTags(candidate.name), candidate.version, plan.channel);
		if (tags.length) {
			const commands = tags.map((tag) => ["dist-tag", "add", plan.package, tag]);
			await ask(`Forward the npm tags as the owner:\n${commands.map((args) => `  npm ${args.join(" ")}`).join("\n")}`);
			for (const args of commands) foreground("npm", args);
		}
		await ask(
			"The public release completed. Update clean local main to origin/main and remove this finished local version branch?",
		);
		run("git", ["fetch", "origin", "--prune"]);
		const worktrees = git("worktree", "list", "--porcelain").split("\n\n");
		const mainTree = worktrees
			.find((entry) => entry.includes("branch refs/heads/main"))
			?.split("\n")[0]
			?.slice("worktree ".length);
		// The release already succeeded, so a local main that cannot move is a notice, not a failure (#442).
		if (mainTree && git("-C", mainTree, "status", "--porcelain"))
			console.log(`Local main at ${mainTree} is dirty; keep its edits and synchronize it manually.`);
		else if (mainTree) run("git", ["-C", mainTree, "merge", "--ff-only", "origin/main"]);
		// The main checkout usually sits on the version branch with main checked out nowhere;
		// fetching into the unchecked-out ref fast-forwards it or refuses a diverged one.
		else
			try {
				run("git", ["fetch", "origin", "main:main"]);
			} catch {
				// git printed why it refused; the release itself is complete.
				console.log("Local main did not fast-forward to origin/main; synchronize it manually.");
			}
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
