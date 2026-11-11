#!/usr/bin/env node
/**
 * pnpm run release:next [-- --rehearse] [-- status]
 *
 * One resumable release command. Each run reads the real state of git, GitHub and npm, prints
 * where the release stands, and performs the next step until it needs the owner, finishes or
 * fails. Interrupting is always safe: the next run derives the position again. Decisions live in
 * plan.mjs; this file only reads facts and performs steps.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	git,
	installers,
	QUALIFIED_MAJORS,
	qualifiedOn,
	releaseState,
	root,
	run,
	verifyCandidate,
} from "../release-candidate.mjs";
import { api, forwardedTags, registryTags, registryVersion, requireIntegrity } from "../release-publish.mjs";
import { releaseVersionErrors } from "../release-version-policy.mjs";
import {
	alreadyPublished,
	ciCandidateDirectory,
	isVersionBranch,
	latestJob,
	nextStep,
	postFailures,
	previousTag,
	publicProven,
	publishArgs,
	QUALIFICATION_JOBS,
	rerunStarted,
	runState,
	startOverCancels,
	tmpdirProblem,
	toolingOnly,
	versionBranch,
} from "./plan.mjs";
import { acquireLock, LockHeld, loadReceipt, newReceipt, recordEvent, saveReceipt } from "./receipt.mjs";

const repository = "iowarp/clio-coder";
const POLL_MS = 20_000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Positions with what proves them and the expected wall time, shown on every status screen. */
const POSITIONS = {
	release: [
		["ready", "clean version branch, versions agree, main is an ancestor", "seconds"],
		["local-qualified", "opt-in (--local): Node 22 and 24 tests and install boot", "~5 min, skipped for green CI"],
		["pushed", "origin version branch at the candidate", "seconds"],
		["ci-qualified", "ci.yml prepare, ci (22), ci (24); reuses any green run", "~8 min, or 0 reused"],
		["finish-checked", "release.yml preflight green, release job awaiting approval", "~1 min"],
		["npm-accepted", "owner's npm publish of the qualified tarball", "~1 min, owner"],
		["published", "release job: tag, GitHub release, main, website", "~2 min after approval; npm may add ~15"],
		["tags-forwarded", "npm beta/dev not behind the release", "seconds, owner"],
		["closed-out", "post-release checklist", "~2 min"],
	],
	rehearse: [
		["ready", "clean version branch, versions agree, main is an ancestor", "seconds"],
		["local-qualified", "opt-in (--local): Node 22 and 24 tests and install boot", "~5 min, skipped for green CI"],
		["pushed", "temporary rehearse/* branch at the candidate", "seconds"],
		["ci-qualified", "ci.yml with rehearsal and macOS boot (Windows with --windows)", "~9 min, reused by the release"],
		["finish-checked", "release.yml check run: real preflight and finish check", "~1 min"],
		["drafted", "draft release rehearse-<nonce> created, verified, deleted", "~1 min"],
		["stubbed", "npm publish --dry-run of the qualified tarball", "seconds"],
		["torn-down", "rehearsal runs cancelled, branch deleted", "seconds"],
	],
};

function proven(mode, facts, receipt) {
	const ci = facts.ci?.state === "success" && facts.ci.artifacts;
	const r = receipt.rehearsal ?? {};
	const tree = facts.tree;
	const branchOk = mode === "rehearse" || isVersionBranch(tree.branch);
	const ready =
		facts.pushed || (branchOk && tree.clean && tree.versionsAgree && tree.mainAncestor && !tree.readiness.length);
	const local = !facts.local.wanted || facts.ci?.state === "success" || (facts.local.node22 && facts.local.node24);
	if (mode === "rehearse")
		return [
			ready,
			local,
			facts.pushed || ci,
			ci,
			r.checked,
			r.drafted,
			r.stubbed,
			r.tornDown && r.checked && r.drafted && r.stubbed,
		].map(Boolean);
	const preflight = facts.releaseRun && latestJob(facts.releaseRun.jobs, "preflight")?.conclusion === "success";
	const accepted = facts.npm.served || receipt.npm?.accepted === true;
	return [
		ready,
		local,
		facts.pushed,
		ci,
		preflight || facts.published,
		accepted,
		facts.published,
		facts.published && !facts.tagsBehind.length,
		facts.published && !facts.postPending.length,
	].map(Boolean);
}

function statusScreen(mode, facts, receipt, step) {
	const done = proven(mode, facts, receipt);
	const lines = [`Clio Coder ${receipt.version} ${mode} of ${receipt.commit.slice(0, 12)} on ${receipt.branch}`];
	let marked = false;
	POSITIONS[mode].forEach(([name, proof, wall], index) => {
		const mark = done[index] ? "x" : marked ? " " : ">";
		if (!done[index]) marked = true;
		lines.push(`  [${mark}] ${name.padEnd(15)} ${proof.padEnd(62)} ${wall}`);
	});
	lines.push(`  next: ${step.step}${step.reason ? `: ${step.reason}` : ""}`);
	return lines.join("\n");
}

// ---------- Remote reads ----------

/** Every read of GitHub and npm passes through here, so `--record` saves them and `--replay` serves them. */
const liveReads = {
	api: (path) => api(path),
	lsRemote: (...refs) => git("ls-remote", "origin", ...refs),
	registryVersion,
	registryTags,
	download: (id, name, directory) =>
		run("gh", ["run", "download", String(id), "--repo", repository, "--name", name, "--dir", directory]),
	postPending: (post, context) => (post ? post.postPending(context) : []),
};
let reads = liveReads;

/** Directs the reads at a recording: `{ record: true }` saves live answers to it, otherwise it replays them. */
export function useRecording(file, { record = false } = {}) {
	const book = existsSync(file) ? json(file) : {};
	const save = () => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(book, null, "\t")}\n`);
	};
	const replay = (key) => {
		if (!(key in book)) throw new Error(`No recorded read for ${key} in ${file}.`);
		const value = book[key];
		if (value?.$error) throw Object.assign(new Error(value.$error), { stderr: value.$error });
		return value;
	};
	const answer = (key, live) => {
		if (!record) return replay(key);
		try {
			const value = live();
			if (value instanceof Promise) return value.then((resolved) => keep(key, resolved));
			return keep(key, value);
		} catch (error) {
			if (String(error.stderr).includes("404")) keep(key, { $error: "HTTP 404" });
			throw error;
		}
	};
	const keep = (key, value) => {
		book[key] = value ?? null;
		save();
		return value;
	};
	reads = {
		api: (path) => answer(`api ${path}`, () => liveReads.api(path)),
		lsRemote: (...refs) => answer(`ls-remote ${refs.join(" ")}`, () => liveReads.lsRemote(...refs)),
		registryVersion: async (name, version) =>
			answer(`npm ${name}@${version}`, () => liveReads.registryVersion(name, version)),
		registryTags: async (name) => answer(`dist-tags ${name}`, () => liveReads.registryTags(name)),
		download: (id, name, directory) => {
			const saved = join(dirname(file), "artifacts", `${id}-${name}`);
			if (record) {
				liveReads.download(id, name, directory);
				cpSync(directory, saved, { recursive: true });
			} else if (existsSync(saved)) cpSync(saved, directory, { recursive: true });
			else throw new Error(`No recorded artifact ${name} of run ${id} in ${saved}.`);
		},
		postPending: (post, context) => answer("post", () => liveReads.postPending(post, context)),
	};
}

// ---------- GitHub ----------

function getRun(id) {
	const record = reads.api(`repos/${repository}/actions/runs/${id}`);
	const jobs = reads.api(`repos/${repository}/actions/runs/${id}/jobs?filter=latest&per_page=100`).jobs;
	return { record, jobs, state: runState(record, jobs) };
}

function runsOn(workflow, commit) {
	return reads
		.api(`repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=20`)
		.workflow_runs.filter((record) => record.head_sha === commit);
}

/** Dispatches and returns the created run's ID; GitHub returns it with return_run_details. */
async function dispatch(workflow, ref, inputs, title) {
	const reply = run(
		"gh",
		["api", `repos/${repository}/actions/workflows/${workflow}/dispatches`, "--method", "POST", "--input", "-"],
		{
			encoding: "utf8",
			stdio: ["pipe", "pipe", "inherit"],
			input: JSON.stringify({
				ref,
				inputs: Object.fromEntries(
					Object.entries({ ...inputs, nonce: title }).map(([name, value]) => [name, String(value)]),
				),
				return_run_details: true,
			}),
		},
	).trim();
	const id = reply ? JSON.parse(reply).workflow_run_id : undefined;
	if (id) return id;
	for (let attempt = 0; attempt < 18; attempt++) {
		const found = runsOn(workflow, inputs.sha).find((record) => record.display_title === title);
		if (found) return found.id;
		await delay(5000);
	}
	throw new Error(`Dispatch accepted but run "${title}" was not visible; inspect Actions before retrying.`);
}

function artifactsPresent(id, commit) {
	const artifacts = reads.api(`repos/${repository}/actions/runs/${id}/artifacts?per_page=100`).artifacts;
	return [`candidate-${commit}`, `results-${commit}`, `results24-${commit}`].every((name) =>
		artifacts.some((artifact) => artifact.name === name && !artifact.expired),
	);
}

/** The GitHub digest (`sha256:...`) of the run's candidate artifact, or null when GitHub has none. */
function candidateDigest(id, commit) {
	const artifacts = reads.api(`repos/${repository}/actions/runs/${id}/artifacts?per_page=100`).artifacts;
	return artifacts.find((artifact) => artifact.name === `candidate-${commit}` && !artifact.expired)?.digest ?? null;
}

function publishedRelease(tag) {
	try {
		return reads.api(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
	} catch (error) {
		if (String(error.stderr).includes("404")) return null;
		throw error;
	}
}

function remoteHead(branch) {
	return reads.lsRemote(`refs/heads/${branch}`).split(/\s/u)[0] || null;
}

/**
 * The ci.yml run's candidate artifact, downloaded once and verified on every use. The local
 * candidate only gates the push; every published, drafted or compared byte comes from here.
 */
function ciCandidate(receipt, context) {
	const directory = ciCandidateDirectory(context.state, receipt.ciRun);
	if (!existsSync(join(directory, "candidate.json"))) {
		const partial = `${directory}.partial`;
		rmSync(partial, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
		reads.download(receipt.ciRun.id, `candidate-${receipt.commit}`, partial);
		renameSync(partial, directory);
	}
	const candidate = verifyCandidate(directory, receipt.commit);
	if (String(candidate.run) !== String(receipt.ciRun.id))
		throw new Error(`The artifact in ${directory} belongs to run ${candidate.run}, not ${receipt.ciRun.id}.`);
	return { ...candidate, directory };
}

/** The commit a remote tag points to, peeling an annotated tag. */
function remoteTagCommit(tag) {
	const lines = reads.lsRemote(`refs/tags/${tag}`, `refs/tags/${tag}^{}`).split("\n").filter(Boolean);
	const peeled = lines.find((line) => line.endsWith("^{}")) ?? lines[0];
	return peeled ? peeled.split(/\s/u)[0] : null;
}

// ---------- Facts ----------

function readTree(commit) {
	const pkg = json(join(root, "package.json"));
	const stable = !pkg.version.includes("-");
	const readiness = releaseVersionErrors({
		version: pkg.version,
		changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
		releaseContext: false,
	});
	const site = json(join(root, "site/product.json"));
	if (stable && (site.version !== pkg.version || site.publishedVersion !== pkg.version))
		readiness.push("site/product.json version and publishedVersion must name the release version.");
	let mainAncestor = true;
	try {
		run("git", ["merge-base", "--is-ancestor", "origin/main", commit], { stdio: "pipe" });
	} catch {
		mainAncestor = false;
	}
	return {
		clean: !git("status", "--porcelain", "--untracked-files=normal"),
		branch: git("branch", "--show-current"),
		versionsAgree: ["apps/clio-coder-gui/package.json", "assets/acp-registry/agent.json"].every(
			(path) => json(join(root, path)).version === pkg.version,
		),
		mainAncestor,
		readiness,
	};
}

export async function readFacts(mode, receipt, context) {
	const { commit } = receipt;
	const candidateReady = context.local && existsSync(join(context.candidate, "candidate.json"));
	const local = {
		wanted: Boolean(context.local),
		...Object.fromEntries(
			QUALIFIED_MAJORS.map((major) => [`node${major}`, candidateReady && qualifiedOn(context.candidate, commit, major)]),
		),
	};
	const head = git("rev-parse", "HEAD");
	const scratch = receipt.rehearsal?.branch;
	const pushed =
		mode === "rehearse" ? Boolean(scratch) && remoteHead(scratch) === commit : remoteHead(receipt.branch) === head;

	const own = new Set([receipt.ciRun?.id, receipt.releaseRun?.id, ...(receipt.rehearsal?.runs ?? [])].filter(Boolean));
	if (!receipt.ciRun) {
		// Any green qualification of this exact commit (a rehearsal's included) is reused: no local runs, no dispatch.
		const reusable = runsOn("ci.yml", commit).find(
			(record) =>
				record.conclusion === "success" &&
				QUALIFICATION_JOBS.every((name) => latestJob(getRun(record.id).jobs, name)?.conclusion === "success") &&
				artifactsPresent(record.id, commit),
		);
		if (reusable) {
			receipt.ciRun = { id: reusable.id, attempt: reusable.run_attempt };
			own.add(reusable.id);
			recordEvent(receipt, "reuse-ci", "done", { id: reusable.id });
		}
	}
	const foreignRuns = ["ci.yml", "release.yml"]
		.flatMap((workflow) => runsOn(workflow, commit))
		.filter((record) => record.status !== "completed" && !own.has(record.id))
		.map((record) => record.id);

	let ci = null;
	if (receipt.ciRun) {
		const found = getRun(receipt.ciRun.id);
		ci = { ...found, artifacts: found.state === "success" && artifactsPresent(receipt.ciRun.id, commit) };
		// The candidate artifact's digest, recorded once, ties the published bytes to the qualified ones:
		// a full re-run of the run replaces the artifact under the same name.
		if (ci.artifacts) {
			ci.artifactDigest = candidateDigest(receipt.ciRun.id, commit);
			if (ci.artifactDigest && !receipt.ciRun.artifactDigest) receipt.ciRun.artifactDigest = ci.artifactDigest;
		}
	}
	let releaseRun = mode === "release" && receipt.releaseRun ? getRun(receipt.releaseRun.id) : null;
	const releaseHead = releaseRun?.record.head_sha ?? null;
	// A failed run on an older head is replaced, not rerun, once a tooling fix moved the branch (design 5b).
	if (releaseRun?.state === "failure" && releaseRun.record.head_sha !== remoteHead(receipt.branch)) releaseRun = null;

	const published = await reads.registryVersion(context.name, receipt.version);
	let integrityMatches = null;
	// npm is compared with the CI artifact that release.yml verifies, never with a local pack.
	if (published && ci?.state === "success" && ci.artifacts) {
		const candidate = ciCandidate(receipt, context);
		try {
			requireIntegrity(published, candidate);
			integrityMatches = true;
		} catch {
			integrityMatches = false;
		}
	}
	const npm = { served: Boolean(published), integrityMatches };

	// After npm accepted, origin's version branch may have moved past the candidate (another session's commit).
	let moved = null;
	const branchHead = mode === "release" ? remoteHead(receipt.branch) : null;
	if (branchHead && branchHead !== commit && (npm.served || receipt.npm?.accepted === true))
		moved = { head: branchHead, ...descent(commit, branchHead, receipt.branch) };

	let isPublished = false;
	let tagsBehind = [];
	let postPending = [];
	if (mode === "release" && npm.served) {
		const release = publishedRelease(context.tag);
		isPublished = publicProven({
			runSucceeded: releaseRun?.state === "success",
			release,
			tagCommit: release ? remoteTagCommit(context.tag) : null,
			commit,
			latest: context.channel === "latest",
			mainHead: remoteHead("main"),
			finishingHeads: [commit, releaseHead].filter(Boolean),
			branchHead: remoteHead(receipt.branch),
		});
		if (isPublished) {
			tagsBehind = forwardedTags(await reads.registryTags(context.name), receipt.version, context.channel);
			postPending = reads.postPending(context.post, postContext(receipt, context));
		}
	}
	return {
		mode,
		tree: readTree(head),
		local,
		pushed,
		ci,
		releaseRun,
		npm,
		published: isPublished,
		tagsBehind,
		postPending,
		foreignRuns,
		moved,
	};
}

/** Whether `head` descends from `commit`, and whether only release tooling differs between them. */
function descent(commit, head, branch) {
	const ancestor = () => {
		try {
			run("git", ["merge-base", "--is-ancestor", commit, head], { stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	};
	try {
		run("git", ["cat-file", "-e", `${head}^{commit}`], { stdio: "pipe" });
	} catch {
		run("git", ["fetch", "--quiet", "origin", branch]);
	}
	if (!ancestor()) return { descends: false, toolingOnly: false };
	return {
		descends: true,
		toolingOnly: toolingOnly(git("diff", "--name-only", commit, head).split("\n").filter(Boolean)),
	};
}

function postContext(receipt, context) {
	return {
		version: receipt.version,
		tag: context.tag,
		previousTag: context.previousTag,
		channel: context.channel,
		commit: receipt.commit,
		branch: receipt.branch,
		root,
		post: receipt.post,
		home: process.env.HOME,
	};
}

// ---------- Steps ----------

function makeAsk() {
	return async (description, phrase) => {
		if (!process.stdin.isTTY) throw new Error(`"${phrase}" needs the owner at a terminal.`);
		const prompt = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const reply = await prompt.question(`${description}\nType "${phrase}" to continue: `);
			return reply.trim() === phrase;
		} finally {
			prompt.close();
		}
	};
}

/** Runs npm in the foreground for its login and two-factor prompts while keeping its stderr. */
function npmForeground(args) {
	return new Promise((done, reject) => {
		const child = spawn("npm", args, { stdio: ["inherit", "inherit", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			process.stderr.write(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => done({ code, stderr }));
	});
}

function teardown(receipt) {
	const branch = receipt.rehearsal?.branch;
	if (!branch || receipt.rehearsal.tornDown) return;
	const open = api(
		`repos/${repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`,
	).workflow_runs.filter((record) => record.status !== "completed");
	for (const record of open)
		try {
			execFileSync("gh", ["run", "cancel", String(record.id), "--repo", repository], { stdio: "pipe" });
		} catch {
			console.log(`  run ${record.id} could not be cancelled; it ends at its timeout`);
		}
	if (remoteHead(branch)) run("git", ["push", "--quiet", "origin", `:refs/heads/${branch}`]);
	// Passed steps stay recorded; the next run pushes a new scratch branch for the rest. A CI run that
	// did not pass cannot be rerun on a deleted branch, so it is dispatched again.
	if (receipt.ciRun && getRun(receipt.ciRun.id).state !== "success") receipt.ciRun = null;
	receipt.rehearsal = { ...receipt.rehearsal, branch: null, tornDown: true };
	recordEvent(receipt, "teardown", "done", { branch, cancelled: open.map((record) => record.id) });
}

async function perform(step, facts, receipt, context) {
	const { commit, version } = receipt;
	const confirm = async (description, phrase) => {
		if (context.mode === "rehearse") return; // authorized once, at the start of the rehearsal
		if (!(await context.ask(description, phrase))) throw new Error("Stopped at your request; nothing was written.");
	};
	switch (step.step) {
		case "qualify": {
			console.log(
				`Qualifying on Node ${step.missing.join(" and ")} (~10 min; log: ${context.candidate}/qualify-node*.log)`,
			);
			run(process.execPath, [
				join(root, "scripts/release-candidate.mjs"),
				"qualify",
				"--directory",
				context.candidate,
				"--state",
				context.state,
			]);
			return recordEvent(receipt, "qualify", "done");
		}
		case "push": {
			if (context.mode === "rehearse") {
				const branch = `rehearse/${version}-${receipt.nonce}-${randomBytes(2).toString("hex")}`;
				run("git", ["push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]);
				receipt.rehearsal = { ...receipt.rehearsal, branch, tornDown: false };
				return recordEvent(receipt, "push", "done", { branch });
			}
			await confirm(`Push ${receipt.branch} to origin. This publishes nothing.`, `push ${receipt.branch}`);
			run("git", ["push", "--quiet", "--set-upstream", "origin", receipt.branch]);
			return recordEvent(receipt, "push", "done", { branch: receipt.branch });
		}
		case "dispatch-ci": {
			await confirm("Dispatch ci.yml to qualify the candidate in CI (~8 min). This publishes nothing.", "dispatch ci");
			const rehearse = context.mode === "rehearse";
			const ref = rehearse ? receipt.rehearsal.branch : receipt.branch;
			const title = `ci ${version} ${receipt.nonce}-${receipt.events.length}`;
			const id = await dispatch(
				"ci.yml",
				ref,
				{ sha: commit, version_branch: receipt.branch, rehearse, platforms: rehearse, windows: context.windows },
				title,
			);
			receipt.ciRun = { id, attempt: 1 };
			if (rehearse) receipt.rehearsal.runs = [...(receipt.rehearsal.runs ?? []), id];
			console.log(`  https://github.com/${repository}/actions/runs/${id}`);
			return recordEvent(receipt, "dispatch-ci", "done", { id, ref });
		}
		case "rerun-ci": {
			const before = facts.ci.record.run_attempt;
			await confirm(`Rerun the failed jobs of ci.yml run ${receipt.ciRun.id}? Passed jobs are kept.`, "rerun ci");
			run("gh", ["run", "rerun", String(receipt.ciRun.id), "--repo", repository, "--failed"]);
			for (let attempt = 0; attempt < 30 && !rerunStarted(before, getRun(receipt.ciRun.id).record); attempt++)
				await delay(2000);
			return recordEvent(receipt, "rerun-ci", "done", { id: receipt.ciRun.id });
		}
		case "check-release": {
			const title = `release check ${version} ${receipt.nonce}-${receipt.events.length}`;
			const id = await dispatch(
				"release.yml",
				receipt.rehearsal.branch,
				{ sha: commit, qualification_run: receipt.ciRun.id, mode: "check", version_branch: receipt.branch },
				title,
			);
			receipt.rehearsal.runs = [...(receipt.rehearsal.runs ?? []), id];
			console.log(`  release.yml check run https://github.com/${repository}/actions/runs/${id}`);
			let found = getRun(id);
			while (found.record.status !== "completed") {
				await delay(10_000);
				found = getRun(id);
			}
			if (found.state !== "success") throw new Error(`The release.yml check run ${id} failed; read its preflight log.`);
			receipt.rehearsal.checked = { run: id };
			return recordEvent(receipt, "check-release", "done", { id });
		}
		case "draft-rehearsal": {
			const tag = `rehearse-${receipt.nonce}`;
			const candidate = ciCandidate(receipt, context);
			const assets = [candidate.tarball, ...installers.map((name) => join(candidate.directory, name))];
			run("gh", [
				"release",
				"create",
				tag,
				"--repo",
				repository,
				"--draft",
				"--target",
				commit,
				"--title",
				`Rehearsal of ${version} (never published)`,
				"--notes",
				`Rehearsal draft for ${commit}; deleted by the rehearsal.`,
				...assets,
			]);
			const draft = api(`repos/${repository}/releases?per_page=10`).find(
				(release) => release.draft && release.tag_name === tag,
			);
			try {
				if (!draft || draft.target_commitish !== commit) throw new Error(`Draft ${tag} was not found at ${commit}.`);
				for (const path of assets) {
					const asset = draft.assets.find((item) => item.name === basename(path));
					const expected = candidate.files[basename(path)];
					if (!asset || (asset.digest && asset.digest !== `sha256:${expected}`))
						throw new Error(`Draft asset ${basename(path)} is missing or differs.`);
				}
			} finally {
				run("gh", ["release", "delete", tag, "--repo", repository, "--yes"]);
			}
			if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) throw new Error(`Tag ${tag} exists; delete it.`);
			receipt.rehearsal.drafted = { id: draft.id, assets: assets.length };
			return recordEvent(receipt, "draft-rehearsal", "done", { id: draft.id, tag });
		}
		case "publish-stub": {
			const args = publishArgs(ciCandidate(receipt, context), { ...context, ciRun: receipt.ciRun });
			const output = run("npm", [...args, "--dry-run"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			console.log(`  the release runs: npm ${args.join(" ")}`);
			receipt.rehearsal.stubbed = { argv: args, dryRun: output.trim().split("\n").at(-1) ?? "" };
			return recordEvent(receipt, "publish-stub", "done");
		}
		case "teardown":
			return teardown(receipt);
		case "dispatch-release": {
			await confirm(
				"Dispatch release.yml: its preflight checks every finishing step, then the release job waits for the owner's approval.",
				"dispatch release",
			);
			const title = `release ${version} ${receipt.nonce}-${receipt.events.length}`;
			const id = await dispatch(
				"release.yml",
				receipt.branch,
				{ sha: commit, qualification_run: receipt.ciRun.id, mode: "release" },
				title,
			);
			receipt.releaseRun = { id, attempt: 1 };
			console.log(`  https://github.com/${repository}/actions/runs/${id}`);
			return recordEvent(receipt, "dispatch-release", "done", { id });
		}
		case "publish-npm": {
			const args = publishArgs(ciCandidate(receipt, context), { ...context, ciRun: receipt.ciRun });
			await confirm(
				`The finishing path passed its check. Publish the qualified tarball to npm as the owner (irreversible):\n  npm ${args.join(" ")}`,
				`publish ${version}`,
			);
			receipt.npm = { publishStartedAt: new Date().toISOString(), accepted: false };
			saveReceipt(context.state, receipt);
			const { code, stderr } = await npmForeground(args);
			// A second publish of the same version is refused; the registry check then compares bytes.
			if (code !== 0 && !alreadyPublished(stderr)) throw new Error(`npm publish exited ${code}; nothing was accepted.`);
			receipt.npm = { ...receipt.npm, accepted: true, acceptedAt: new Date().toISOString(), exitCode: code };
			return recordEvent(receipt, "publish-npm", "accepted", { code });
		}
		case "rerun-release": {
			const before = facts.releaseRun.record.run_attempt;
			await confirm(`Rerun the failed jobs of release.yml run ${receipt.releaseRun.id}?`, "rerun release");
			run("gh", ["run", "rerun", String(receipt.releaseRun.id), "--repo", repository, "--failed"]);
			for (let attempt = 0; attempt < 30 && !rerunStarted(before, getRun(receipt.releaseRun.id).record); attempt++)
				await delay(2000);
			return recordEvent(receipt, "rerun-release", "done", { id: receipt.releaseRun.id });
		}
		case "forward-tags": {
			await confirm(`Point npm ${step.tags.join(", ")} at ${version} as the owner.`, `forward ${step.tags.join(" ")}`);
			for (const tag of step.tags) {
				const { code } = await npmForeground(["dist-tag", "add", `${context.name}@${version}`, tag]);
				if (code !== 0) throw new Error(`npm dist-tag add ${tag} exited ${code}.`);
			}
			return recordEvent(receipt, "forward-tags", "done", { tags: step.tags });
		}
		case "post": {
			const io = {
				run: (command, args, options) => run(command, args, { encoding: "utf8", stdio: "pipe", ...options }),
				confirm: context.ask,
				log: (line) => console.log(`  ${line}`),
			};
			receipt.post = await context.post.postRelease(postContext(receipt, context), io);
			const failed = postFailures(receipt.post);
			recordEvent(receipt, "post", failed.length ? "failed" : "done", { failed });
			if (failed.length)
				throw new Error(
					`The release is public; ${failed.length} post-release item(s) failed. Fix them and run pnpm run release:next again:\n  ${failed.join("\n  ")}`,
				);
			return;
		}
		case "finish-published":
			// release.yml finishes only from the version branch head, and only tooling commits may follow the
			// published candidate, so the owner parks the other commits and restores the branch to it.
			throw new Error(
				[
					`npm serves ${version} from ${commit}, but origin/${receipt.branch} moved to ${step.head} with commits that are not release tooling.`,
					`Finish the published commit: keep the new commits on another branch, put ${receipt.branch} back at ${commit.slice(0, 12)}, then run release:next again; it dispatches release.yml there (tag, release, main, website).`,
					`  git push origin ${step.head}:refs/heads/${receipt.branch}-after-${version}`,
					`  git push --force-with-lease=${receipt.branch}:${step.head} origin ${commit}:refs/heads/${receipt.branch}`,
					`  git switch --detach ${commit}`,
					"  pnpm run release:next",
				].join("\n"),
			);
		default:
			throw new Error(`No action for step ${step.step}.`);
	}
}

/** Steps that wait on CI, the owner's browser approval or npm; the loop polls through them. */
const WAITS = {
	"watch-ci": "CI is running",
	"watch-release": "release.yml is running",
	"wait-npm": "waiting for npm to serve the accepted version (often several minutes)",
	"approve-release": "approve the release environment in the browser as the owner; the job then waits for npm itself",
};

function progress(facts) {
	const current = facts.releaseRun ?? facts.ci;
	if (!current) return "";
	const jobs = current.jobs.map((job) => `${job.name}:${job.conclusion ?? job.status}`).join(" ");
	return `${current.record.html_url} ${jobs}`;
}

export async function main(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv.filter((argument) => argument !== "--"),
		options: {
			rehearse: { type: "boolean" },
			windows: { type: "boolean" },
			local: { type: "boolean" },
			state: { type: "string" },
			record: { type: "string" },
			replay: { type: "string" },
			help: { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(
			"pnpm run release:next            release the version branch's head, resuming where it stands\npnpm run release:next --rehearse  full non-public rehearsal on a temporary rehearse/* branch\npnpm run release:next status      print the positions and exit (read-only)\n  --local                          also qualify on local Node 22 and 24 before the push\n  --record <file>                  save every GitHub and npm read to <file>\n  --replay <file>                  read GitHub and npm from <file> offline; prints the next step, writes nothing",
		);
		return;
	}
	const problem = tmpdirProblem(tmpdir());
	if (problem) throw new Error(problem);
	const mode = values.rehearse ? "rehearse" : "release";
	const state = resolve(values.state ?? releaseState());
	if (values.record && values.replay) throw new Error("--record and --replay exclude each other.");
	if (values.record || values.replay) useRecording(resolve(values.record ?? values.replay), { record: !values.replay });
	const statusOnly = positionals[0] === "status" || Boolean(values.replay);
	const lock = statusOnly ? null : takeLock(state, mode);
	try {
		if (!values.replay) run("git", ["fetch", "--quiet", "origin", "main"]);
		const pkg = json(join(root, "package.json"));
		const head = git("rev-parse", "HEAD");
		let receipt = loadReceipt(state, pkg.version);
		if (receipt && receipt.commit !== head && !receipt.npm?.accepted) {
			console.log(`The candidate moved from ${receipt.commit.slice(0, 12)} to ${head.slice(0, 12)}; starting over.`);
			for (const { id, argv } of startOverCancels(receipt, (id) => getRun(id).record.status)) {
				if (statusOnly) {
					console.log(`  release.yml run ${id} of the old candidate is still open; cancel it: gh ${argv.join(" ")}`);
					continue;
				}
				try {
					run("gh", argv, { stdio: "pipe" });
					console.log(`  cancelled release.yml run ${id} of the old candidate`);
				} catch {
					throw new Error(`Cancel release.yml run ${id} of the old candidate first: gh ${argv.join(" ")}`);
				}
			}
			receipt = null;
		}
		receipt ??= newReceipt({
			version: pkg.version,
			commit: head,
			// The publisher plans for the version branch; a rehearsal may run from a throwaway branch.
			branch: mode === "rehearse" ? versionBranch(pkg.version) : git("branch", "--show-current"),
			nonce: randomBytes(3).toString("hex"),
			owner: process.env.USER ?? "unknown",
		});
		const candidate = join(state, `c-${receipt.commit.slice(0, 12)}`);
		const channel = pkg.version.includes("-") ? "beta" : "latest";
		const postModule = join(fileURLToPath(new URL(".", import.meta.url)), "post.mjs");
		const context = {
			mode,
			state,
			candidate,
			windows: Boolean(values.windows),
			local: Boolean(values.local),
			channel,
			name: pkg.name,
			tag: `v${pkg.version}`,
			previousTag: previousTag(git, `v${pkg.version}`, receipt.commit),
			post: existsSync(postModule) ? await import(postModule) : null,
			ask: makeAsk(),
		};
		let facts = await readFacts(mode, receipt, context);
		let step = nextStep(facts, receipt);
		console.log(statusScreen(mode, facts, receipt, step));
		if (statusOnly) return;
		if (mode === "rehearse" && step.step !== "done") {
			const approved = await context.ask(
				"The rehearsal pushes a temporary rehearse/* branch, dispatches ci.yml and a release.yml check run on it, creates and deletes a never-published draft release, and deletes the branch. Nothing public changes.",
				`rehearse ${pkg.version}`,
			);
			if (!approved) throw new Error("Stopped at your request; nothing was written.");
		}
		const interrupted = () => {
			if (mode === "rehearse") teardown(receipt);
			saveReceipt(state, receipt);
			lock?.release();
			process.exit(130);
		};
		process.once("SIGINT", interrupted);
		process.once("SIGTERM", interrupted);
		const started = Date.now();
		let shown = "";
		try {
			for (;;) {
				if (step.step === "stop") throw new Error(step.reason);
				if (step.step === "done") break;
				if (step.step in WAITS) {
					const line = `${step.step}: ${WAITS[step.step]} ${progress(facts)}`;
					if (line !== shown) console.log(`[${minutes(started)}] ${line}`);
					shown = line;
					await delay(POLL_MS);
				} else {
					console.log(`[${minutes(started)}] ${step.step}`);
					await perform(step, facts, receipt, context);
					saveReceipt(state, receipt);
				}
				facts = await readFacts(mode, receipt, context);
				step = nextStep(facts, receipt);
			}
		} finally {
			if (mode === "rehearse") teardown(receipt);
			saveReceipt(state, receipt);
		}
		console.log(
			mode === "rehearse"
				? `REHEARSAL_OK ${receipt.version} ${receipt.commit} ci=${receipt.ciRun?.id} check=${receipt.rehearsal?.checked?.run} in ${minutes(started)}`
				: `RELEASED ${receipt.version} ${receipt.commit} in ${minutes(started)}`,
		);
	} finally {
		lock?.release();
	}
}

const minutes = (since) => `${Math.round((Date.now() - since) / 60_000)} min`;

function takeLock(state, mode) {
	try {
		const lock = acquireLock(state, `release:next${mode === "rehearse" ? " --rehearse" : ""}`);
		if (lock.takeover) console.log(`Taking over from dead pid ${lock.takeover.pid} (${lock.takeover.command}).`);
		process.env.CLIO_RELEASE_LOCK_PID = String(process.pid);
		return lock;
	} catch (error) {
		if (!(error instanceof LockHeld)) throw error;
		const { user, host, pid, command, startedAt } = error.holder;
		throw new Error(`${user}@${host} pid ${pid} has run "${command}" since ${startedAt}; one release command at a time.`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	main().catch((error) => {
		console.error(`release:next: ${error.message}`);
		process.exitCode = 1;
	});
