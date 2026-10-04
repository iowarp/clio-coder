#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { git, installers, root, run, verifyCandidate } from "./release-candidate.mjs";
import { releaseVersionErrors } from "./release-version-policy.mjs";

const repository = "iowarp/clio-coder";
export function publicationPlan(receipt, branch) {
	if (!/^v\d{3}$/u.test(branch)) throw new Error("Public releases must come from a version branch such as v062.");
	const channel = receipt.version.includes("-") ? "beta" : "latest";
	return {
		commit: receipt.commit,
		version: receipt.version,
		branch,
		channel,
		tag: `v${receipt.version}`,
		package: `${receipt.name}@${receipt.version}`,
		tarball: basename(receipt.tarball),
		sha256: receipt.files[basename(receipt.tarball)],
		websiteSha256: receipt.files["website.tgz"],
	};
}

export function api(path, method = "GET", body) {
	return JSON.parse(
		run("gh", ["api", path, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], {
			encoding: "utf8",
			stdio: "pipe",
			...(body === undefined ? {} : { input: JSON.stringify(body) }),
		}),
	);
}

export async function qualification(runId, commit, { inProgress = false } = {}) {
	if (!/^\d+$/u.test(String(runId))) throw new Error("A qualification run ID is required.");
	const record = api(`repos/${repository}/actions/runs/${runId}`);
	const jobs = api(`repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`).jobs;
	verifyQualificationRecord(record, jobs, commit, inProgress);
	return record;
}

export function verifyQualificationRecord(record, jobs, commit, inProgress = false) {
	if (
		record.head_sha !== commit ||
		record.path !== ".github/workflows/ci.yml" ||
		record.event !== "workflow_dispatch" ||
		(!inProgress && (record.status !== "completed" || record.conclusion !== "success"))
	)
		throw new Error("Qualification must be a successful manual ci.yml run on this exact commit.");
	for (const name of ["prepare", "ci (22)", "ci (24)"]) {
		if ([...jobs].sort((a, b) => b.id - a.id).find((job) => job.name === name)?.conclusion !== "success")
			throw new Error(`Qualification gate did not pass: ${name}`);
	}
}

export async function rehearseBytes(directory, commit, branch) {
	const receipt = verifyCandidate(directory, commit);
	const plan = publicationPlan(receipt, branch);
	let dryRun;
	try {
		dryRun = JSON.parse(
			run("npm", ["publish", receipt.tarball, "--dry-run", "--json", "--access", "public", "--tag", plan.channel], {
				encoding: "utf8",
				stdio: "pipe",
				maxBuffer: 64 * 1024 * 1024,
			}),
		);
	} catch (error) {
		if (
			!String(error.stderr).includes(`You cannot publish over the previously published versions: ${receipt.version}.`) ||
			!(await registryVersion(receipt.name, receipt.version))
		)
			throw error;
		console.log(
			`npm dry-run correctly refuses the already published ${receipt.version}; no version bump or public write was made.`,
		);
	}
	if (
		dryRun &&
		(dryRun.name !== receipt.name ||
			dryRun.version !== receipt.version ||
			dryRun.integrity !== integrity(receipt.tarball))
	)
		throw new Error("npm dry-run differs from the qualified archive.");
	verifyCandidate(directory, commit);
	console.log(
		`Publication payload verified: ${plan.package}, ${plan.tag}, five GitHub assets, prepared website. npm authorization remains unverified until a real publish.`,
	);
	return plan;
}

async function registryVersion(name, version) {
	const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
	return response.json();
}

function integrity(tarball) {
	return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

function requireIntegrity(published, receipt) {
	if (
		published.name !== receipt.name ||
		published.version !== receipt.version ||
		published.dist?.integrity !== integrity(receipt.tarball)
	)
		throw new Error("npm already contains different bytes for this version; published versions are immutable.");
}

function requireFastForward(commit) {
	run("git", ["fetch", "origin", "main", "gh-pages"]);
	run("git", ["merge-base", "--is-ancestor", "origin/main", commit], { stdio: "pipe" });
}

function existingRelease(tag) {
	try {
		return api(`repos/${repository}/releases/tags/${tag}`);
	} catch (error) {
		if (String(error.stderr).includes("404")) return null;
		throw error;
	}
}

function tagCommit(tag) {
	let object;
	try {
		object = api(`repos/${repository}/git/ref/tags/${tag}`).object;
	} catch (error) {
		if (String(error.stderr).includes("404")) return null;
		throw error;
	}
	for (let depth = 0; object.type === "tag" && depth < 5; depth++)
		object = api(`repos/${repository}/git/tags/${object.sha}`).object;
	if (object.type !== "commit") throw new Error("Release tag does not resolve to a commit.");
	return object.sha;
}

export async function preflight(directory, commit, runId, branch, rehearse = false) {
	const receipt = verifyCandidate(directory, commit);
	await qualification(runId, commit, { inProgress: rehearse });
	if (String(receipt.run) !== String(runId)) throw new Error("Artifact belongs to another qualification run.");
	const results = JSON.parse(readFileSync(join(directory, "test-results.json"), "utf8"));
	if (
		results.commit !== commit ||
		results.sha256 !== receipt.files[basename(receipt.tarball)] ||
		!Number.isSafeInteger(results.total) ||
		results.total < 1 ||
		results.total + 3 > 2000 ||
		!["core", "gui", "package"].every(
			(tier) => Number.isSafeInteger(results.counts?.[tier]) && results.counts[tier] > 0,
		) ||
		Object.values(results.counts).reduce((sum, count) => sum + count, 0) !== results.total
	)
		throw new Error("Test results do not describe this candidate or exceed the test budget.");
	const plan = publicationPlan(receipt, branch);
	requireFastForward(commit);
	if (!rehearse) {
		const changelog = run("tar", ["-xzOf", receipt.tarball, "package/CHANGELOG.md"], { encoding: "utf8", stdio: "pipe" });
		const errors = releaseVersionErrors({ version: receipt.version, changelog, releaseContext: true });
		const section = changelog.split(/^## /mu)[1];
		if (!section?.slice(section.indexOf("\n") + 1).trim()) errors.push("Release notes must not be empty.");
		const site = JSON.parse(readFileSync(join(root, "site/product.json"), "utf8"));
		if (site.version !== receipt.version || site.publishedVersion !== receipt.version)
			errors.push("Set site/product.json version and publishedVersion to the final release version before qualification.");
		if (errors.length) throw new Error(errors.join("\n"));
		const remote = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/u)[0];
		if (remote !== commit) throw new Error("Version branch moved; prepare a release from its current head.");
		const tag = tagCommit(plan.tag);
		if (tag !== null && tag !== commit) throw new Error("Existing release tag points to another commit.");
		const published = await registryVersion(receipt.name, receipt.version);
		if (published) requireIntegrity(published, receipt);
		else if (tag !== null || existingRelease(plan.tag))
			throw new Error("An existing GitHub release has no matching npm version; resolve it explicitly.");
	}
	const summary = `Clio Coder ${plan.version}\nSource: ${commit}\nQualification: https://github.com/${repository}/actions/runs/${runId}\nPackage: ${plan.tarball}\nSHA-256: ${plan.sha256}\nTests: ${results.total} plus runtime/platform boot checks\n\nApproval authorizes npm publication, GitHub release/tag creation, main fast-forward, gh-pages deployment, and version-branch cleanup.\n`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	return { receipt, plan };
}

function verifyAssets(release, receipt) {
	for (const name of [basename(receipt.tarball), ...installers]) {
		const asset = release.assets.find((item) => item.name === name);
		if (asset?.digest !== `sha256:${receipt.files[name]}`) throw new Error(`GitHub release asset differs: ${name}`);
	}
}

function publishWebsite(directory, receipt) {
	const scratch = mkdtempSync(join(tmpdir(), "clio-release-pages-"));
	const checkout = join(scratch, "branch");
	try {
		run("git", ["fetch", "origin", "gh-pages"]);
		run("git", ["worktree", "add", "--detach", checkout, "origin/gh-pages"]);
		for (const name of readdirSync(checkout))
			if (name !== ".git") rmSync(join(checkout, name), { recursive: true, force: true });
		run("tar", ["-xzf", join(directory, "website.tgz"), "-C", checkout]);
		const version = JSON.parse(readFileSync(join(checkout, "version.json"), "utf8"));
		if (
			version.publishedVersion !== receipt.version ||
			version.docsCommit !== receipt.commit ||
			version.revision !== receipt.commit
		)
			throw new Error("Prepared website differs from the candidate.");
		run("git", ["-C", checkout, "add", "-A"]);
		if (git("-C", checkout, "diff", "--cached", "--name-only")) {
			const slug = process.env.RELEASE_APP_SLUG;
			if (!slug || !/^[a-z0-9-]+$/u.test(slug)) throw new Error("Release GitHub App identity is missing.");
			const user = api(`users/${slug}[bot]`);
			run("git", [
				"-C",
				checkout,
				"-c",
				`user.name=${slug}[bot]`,
				"-c",
				`user.email=${user.id}+${slug}[bot]@users.noreply.github.com`,
				"commit",
				"-m",
				`deploy: Clio Coder ${receipt.version} from ${receipt.commit.slice(0, 12)}`,
			]);
			run("git", ["-C", checkout, "push", "origin", "HEAD:refs/heads/gh-pages"]);
		}
	} finally {
		if (existsSync(checkout)) run("git", ["worktree", "remove", "--force", checkout]);
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function verifyPublic(receipt, plan) {
	const published = await registryVersion(receipt.name, receipt.version);
	if (!published) throw new Error("Published npm version is missing.");
	requireIntegrity(published, receipt);
	const tags = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(receipt.name)}/dist-tags`, {
		signal: AbortSignal.timeout(30_000),
	}).then((response) => response.json());
	if (tags[plan.channel] !== receipt.version) throw new Error(`npm ${plan.channel} points to another version.`);
	const release = existingRelease(plan.tag);
	if (!release || release.draft || tagCommit(plan.tag) !== receipt.commit)
		throw new Error("GitHub release/tag is not public at the qualified commit.");
	verifyAssets(release, receipt);
	if (release.prerelease !== (plan.channel === "beta")) throw new Error("GitHub release channel differs from npm.");
	if (plan.channel === "latest" && api(`repos/${repository}/releases/latest`).tag_name !== plan.tag)
		throw new Error("GitHub Latest points to another release.");
	if (plan.channel === "latest") {
		if (api(`repos/${repository}/git/ref/heads/main`).object.sha !== receipt.commit)
			throw new Error("main differs from the release.");
		for (let attempt = 0; attempt < 18; attempt++) {
			const response = await fetch(`https://coder.iowarp.ai/version.json?release=${receipt.commit}`, {
				signal: AbortSignal.timeout(15_000),
			});
			if (response.ok) {
				const site = await response.json();
				if (
					site.publishedVersion === receipt.version &&
					site.docsCommit === receipt.commit &&
					site.revision === receipt.commit
				)
					return;
			}
			console.log("Waiting for the prepared gh-pages deployment...");
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
		throw new Error("Website has not reached the qualified release; resume publication without rebuilding.");
	}
}

export async function publish(directory, commit, runId, branch) {
	if (
		process.env.GITHUB_ACTIONS !== "true" ||
		process.env.GITHUB_WORKFLOW !== "release" ||
		process.env.GITHUB_SHA !== commit
	)
		throw new Error("Publication is restricted to the approved release.yml job on the exact candidate commit.");
	const { receipt, plan } = await preflight(directory, commit, runId, branch);
	const published = await registryVersion(receipt.name, receipt.version);
	if (!published) run("npm", ["publish", receipt.tarball, "--access", "public", "--provenance", "--tag", plan.channel]);
	else {
		requireIntegrity(published, receipt);
		console.log("npm already contains the qualified bytes; continuing publication.");
	}
	const onNpm = await registryVersion(receipt.name, receipt.version);
	if (!onNpm) throw new Error("npm publication is not visible yet; resume the release job.");
	requireIntegrity(onNpm, receipt);
	let release = existingRelease(plan.tag);
	if (!release) {
		run("gh", [
			"release",
			"create",
			plan.tag,
			"--repo",
			repository,
			"--draft",
			"--target",
			commit,
			"--title",
			`Clio Coder ${receipt.version}`,
			"--notes-file",
			join(directory, "release-notes.md"),
			receipt.tarball,
			...installers.map((name) => join(directory, name)),
		]);
		release = existingRelease(plan.tag);
	} else if (release.draft) {
		run("gh", [
			"release",
			"upload",
			plan.tag,
			"--repo",
			repository,
			"--clobber",
			receipt.tarball,
			...installers.map((name) => join(directory, name)),
		]);
		release = existingRelease(plan.tag);
	}
	verifyAssets(release, receipt);
	if (release.draft)
		run("gh", [
			"release",
			"edit",
			plan.tag,
			"--repo",
			repository,
			"--draft=false",
			...(plan.channel === "beta" ? ["--prerelease", "--latest=false"] : ["--latest"]),
		]);
	if (tagCommit(plan.tag) !== commit) throw new Error("Published tag differs from the qualified commit.");
	if (plan.channel === "latest") {
		requireFastForward(commit);
		run("git", ["push", "origin", `${commit}:refs/heads/main`]);
		publishWebsite(directory, receipt);
		await verifyPublic(receipt, plan);
		// A lease makes cleanup a compare-and-delete operation. A concurrent
		// development commit is preserved instead of being deleted with the branch.
		run("git", ["push", `--force-with-lease=refs/heads/${branch}:${commit}`, "origin", `:refs/heads/${branch}`]);
	} else await verifyPublic(receipt, plan);
	console.log(`RELEASE_COMPLETE ${receipt.version} ${commit}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({
			options: {
				directory: { type: "string" },
				sha: { type: "string" },
				run: { type: "string" },
				branch: { type: "string" },
			},
			allowPositionals: true,
		});
		const directory = resolve(values.directory ?? "");
		if (!values.sha || !values.run || !values.branch) throw new Error("Supply --sha, --run, and --branch.");
		if (positionals[0] === "publish") await publish(directory, values.sha, values.run, values.branch);
		else if (positionals[0] === "verify") await preflight(directory, values.sha, values.run, values.branch);
		else if (positionals[0] === "rehearse-preflight")
			await preflight(directory, values.sha, values.run, values.branch, true);
		else if (positionals[0] === "rehearse") {
			const started = performance.now();
			const result = await preflight(directory, values.sha, values.run, values.branch, true);
			await rehearseBytes(directory, values.sha, values.branch);
			console.log(`REHEARSAL_OK ${JSON.stringify(result.plan)} elapsedMs=${Math.round(performance.now() - started)}`);
		} else
			throw new Error(
				"Usage: release-publish.mjs verify|publish|rehearse --directory <path> --sha <commit> --run <id> --branch <version branch>",
			);
	} catch (error) {
		console.error(`release-publish: ${error.message}`);
		process.exitCode = 1;
	}
}
