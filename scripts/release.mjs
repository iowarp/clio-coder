#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { isVersionBranch, tmpdirProblem } from "./release/plan.mjs";
import { acquireLock, LockHeld } from "./release/receipt.mjs";
import { git, releaseState, run, source, verifyCandidate } from "./release-candidate.mjs";
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

function dispatchedRuns(workflow, branch, commit) {
	return api(
		`repos/${repository}/actions/workflows/${workflow}/runs?${branch ? `branch=${encodeURIComponent(branch)}&` : ""}event=workflow_dispatch&head_sha=${commit}&per_page=100`,
	).workflow_runs.filter((record) => record.head_sha === commit);
}

async function recentRun(workflow, branch, commit) {
	return dispatchedRuns(workflow, branch, commit)[0];
}

async function dispatch(workflow, branch, commit, fields) {
	// Match the new run by ID, not by timestamp: GitHub's created_at can lag the local clock by seconds.
	const known = new Set(dispatchedRuns(workflow, branch, commit).map((record) => record.id));
	const nonce = `${workflow.replace(/\.yml$/u, "")} ${commit.slice(0, 12)} ${randomBytes(4).toString("hex")}`;
	// return_run_details makes GitHub answer with the run it created (gh 2.45 cannot ask for it).
	const reply = run(
		"gh",
		["api", `repos/${repository}/actions/workflows/${workflow}/dispatches`, "--method", "POST", "--input", "-"],
		{
			encoding: "utf8",
			stdio: ["pipe", "pipe", "inherit"],
			input: JSON.stringify({
				ref: branch,
				inputs: Object.fromEntries(Object.entries({ ...fields, nonce }).map(([name, value]) => [name, String(value)])),
				return_run_details: true,
			}),
		},
	).trim();
	const id = reply ? JSON.parse(reply).workflow_run_id : undefined;
	if (id) return api(`repos/${repository}/actions/runs/${id}`);
	for (let attempt = 0; attempt < 18; attempt++) {
		const record = dispatchedRuns(workflow, branch, commit).find(
			(candidate) => !known.has(candidate.id) && candidate.display_title === nonce,
		);
		if (record) return record;
		await delay(5000);
	}
	throw new Error(`Dispatch accepted but run "${nonce}" was not visible. Inspect Actions before retrying.`);
}

/** Cancels this command's unfinished runs on a scratch branch, then deletes the branch. */
async function teardown(branch) {
	const runs = api(
		`repos/${repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
	).workflow_runs.filter((record) => record.status !== "completed");
	for (const record of runs)
		try {
			run("gh", ["run", "cancel", String(record.id), "--repo", repository]);
		} catch {
			console.log(`Run ${record.id} could not be cancelled; it ends on its own timeout.`);
		}
	run("git", ["push", "origin", `:refs/heads/${branch}`]);
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
// An accepted publish can stay invisible on npm for many minutes (11 for 0.7.0); a second
// attempt then fails with "cannot publish over". This marker records the acceptance so the
// publish is never offered twice. release.yml waits for npm to serve the version itself.
const acceptedMarker = (receipt) => join(releaseState(), `npm-accepted-${receipt.version}.json`);

async function ownerPublish(receipt, plan, ask, foreground) {
	const published = await registryVersion(receipt.name, receipt.version);
	if (published) {
		requireIntegrity(published, receipt);
		console.log(`npm already contains the qualified bytes of ${plan.package}.`);
		return;
	}
	const marker = acceptedMarker(receipt);
	const sha256 = receipt.files[basename(receipt.tarball)];
	if (existsSync(marker)) {
		const accepted = JSON.parse(readFileSync(marker, "utf8"));
		if (accepted.sha256 !== sha256)
			throw new Error(`${marker} records a publish of different bytes; inspect npm before continuing.`);
		console.log(
			`npm accepted ${plan.package} at ${accepted.at} and has not served it yet. Not publishing again; the release job waits for npm.`,
		);
		return;
	}
	const args = ["publish", receipt.tarball, "--access", "public", "--tag", plan.channel];
	await ask(
		`npm has no ${plan.package}. Publish the qualified tarball as the owner:\n  npm ${args.join(" ")}\nnpm may ask for browser two-factor approval in this terminal.`,
		`publish ${plan.package}`,
	);
	foreground("npm", args);
	mkdirSync(releaseState(), { recursive: true });
	writeFileSync(marker, `${JSON.stringify({ version: receipt.version, sha256, at: new Date().toISOString() })}\n`);
	console.log(`npm accepted ${plan.package}. The release job waits up to 40 minutes for npm to serve it.`);
}

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((argument) => argument !== "--"),
		options: { rehearse: { type: "boolean" }, platforms: { type: "boolean" }, help: { type: "boolean" } },
	});
	if (values.help) {
		console.log(
			"pnpm run release [-- --platforms]\npnpm run release:rehearse [-- --platforms]\nInteractive qualification, owner npm publication, and release dispatch. The release environment requires the owner's final approval.\nRehearsal uses a temporary rehearse/* branch and makes no package, tag, main, or site changes.",
		);
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Run this interactive command in a visible terminal.");
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	// Remote writes need the typed phrase, so a stray "y" in a busy terminal cannot publish.
	const ask = async (description, phrase) => {
		const reply = await prompt.question(
			phrase ? `${description}\nType "${phrase}" to continue: ` : `${description}\nContinue? [y/N] `,
		);
		if (phrase ? reply.trim() !== phrase : !/^y(?:es)?$/iu.test(reply.trim()))
			throw new Error("Stopped at your request. No later step was executed.");
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
	let lock;
	try {
		const problem = tmpdirProblem(tmpdir());
		if (problem) throw new Error(problem);
		try {
			lock = acquireLock(releaseState(), `release${values.rehearse ? " --rehearse" : ""}`);
		} catch (error) {
			if (!(error instanceof LockHeld)) throw error;
			const { user, host, pid, command, startedAt } = error.holder;
			throw new Error(
				`${user}@${host} pid ${pid} has run "${command}" since ${startedAt}. One release command at a time.`,
			);
		}
		if (lock.takeover) console.log(`Taking over from dead pid ${lock.takeover.pid} (${lock.takeover.command}).`);
		process.env.CLIO_RELEASE_LOCK_PID = String(process.pid);
		const commit = source();
		const branch = git("branch", "--show-current");
		if (!isVersionBranch(branch)) throw new Error("Start from the clean version branch, such as v062.");
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
				const rehearsal = `rehearse/${branch}-${randomBytes(3).toString("hex")}`;
				await ask(
					`Push ${commit} to temporary ${rehearsal} and run one non-public qualification/rehearsal.`,
					`push ${rehearsal}`,
				);
				run("git", ["push", "origin", `${commit}:refs/heads/${rehearsal}`]);
				scratchBranch = rehearsal;
			} else {
				await ask(
					`Synchronize ${branch} with origin and dispatch its package qualification. This publishes nothing.`,
					`push ${branch}`,
				);
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
			for (const name of [`candidate-${commit}`, `results-${commit}`, `results24-${commit}`])
				if (!artifacts.some((artifact) => artifact.name === name && !artifact.expired))
					throw new Error("Qualification artifact expired; run qualification again before publishing.");
			// A rehearsal qualifies on a scratch branch, so origin's version branch can still lack
			// the candidate that release.yml is dispatched against (#442). A plain push refuses
			// to move a diverged remote branch.
			await ask(
				`Synchronize ${branch} with origin by fast-forward before publishing. This publishes nothing.`,
				`push ${branch}`,
			);
			run("git", ["push", "--set-upstream", "origin", branch]);
		}
		if (values.rehearse) {
			console.log("Non-public rehearsal passed. No release was published.");
			return;
		}
		mkdirSync(releaseState(), { recursive: true });
		scratchDirectory = mkdtempSync(join(releaseState(), "review-"));
		for (const name of [`candidate-${commit}`, `results-${commit}`, `results24-${commit}`])
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
			`release ${plan.tag}`,
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
			await ask(
				`Forward the npm tags as the owner:\n${commands.map((args) => `  npm ${args.join(" ")}`).join("\n")}`,
				`forward ${tags.join(" ")}`,
			);
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
		// A kept branch whose upstream the release deleted would report "gone" forever (item 12).
		else if (git("for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`) === "[gone]")
			run("git", ["branch", "--unset-upstream", branch]);
		rmSync(acceptedMarker(candidate), { force: true });
	} finally {
		prompt.close();
		if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
		if (scratchBranch) await teardown(scratchBranch);
		lock?.release();
	}
}

main().catch((error) => {
	console.error(`release: ${error.message}`);
	process.exitCode = 1;
});
