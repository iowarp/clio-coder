#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { draftAction, toolingOnly } from "./release/plan.mjs";
import { git, installers, root, run, verifyCandidate } from "./release-candidate.mjs";
import { DEV_VERSION, publishTagErrors, releaseVersionErrors, snapshotVersion } from "./release-version-policy.mjs";

const repository = "iowarp/clio-coder";
// GitHub refuses a release body longer than this many characters.
const RELEASE_BODY_LIMIT = 125_000;
const NPM_WAIT_MINUTES = 40;
export function publicationPlan(receipt, branch, mode = "release") {
	if (!/^v\d{3}$/u.test(branch)) throw new Error("Public releases must come from a version branch such as v062.");
	const channel = mode === "dev" ? "dev" : receipt.version.includes("-") ? "beta" : "latest";
	const errors = publishTagErrors({ version: receipt.version, tag: channel });
	if (errors.length) throw new Error(errors.join("\n"));
	return {
		commit: receipt.commit,
		version: receipt.version,
		branch,
		channel,
		tag: mode === "dev" ? null : `v${receipt.version}`,
		package: `${receipt.name}@${receipt.version}`,
		tarball: basename(receipt.tarball),
		sha256: receipt.files[basename(receipt.tarball)],
		websiteSha256: receipt.files["website.tgz"],
	};
}

/** Stamp only version metadata. All qualified runtime and resource bytes are preserved. */
export function snapshotPayload(receipt, directory) {
	const timestamp = git("show", "-s", "--format=%cI", receipt.commit);
	const version = snapshotVersion(receipt.version, receipt.commit, timestamp);
	const scratch = mkdtempSync(join(tmpdir(), "clio-snapshot-"));
	const inventory = (base) =>
		Object.fromEntries(
			readdirSync(base, { recursive: true })
				.sort()
				.map((path) => {
					const file = join(base, path),
						stat = statSync(file);
					return [
						path,
						{
							mode: stat.mode & 0o777,
							digest: stat.isDirectory() ? "directory" : createHash("sha256").update(readFileSync(file)).digest("hex"),
						},
					];
				}),
		);
	try {
		const entries = run("tar", ["-tzf", receipt.tarball], { encoding: "utf8", stdio: "pipe" }).trim().split("\n");
		const types = run("tar", ["-tvzf", receipt.tarball], { encoding: "utf8", stdio: "pipe" }).trim().split("\n");
		if (
			entries.some((path) => !path.startsWith("package/") || path.split("/").includes("..") || path.includes("\\")) ||
			types.some((line) => !["-", "d"].includes(line[0]))
		)
			throw new Error("Unsafe snapshot source archive.");
		run("tar", ["-xzf", receipt.tarball, "-C", scratch]);
		const before = inventory(join(scratch, "package"));
		for (const path of ["package.json"]) {
			const file = join(scratch, "package", path);
			const original = JSON.parse(readFileSync(file, "utf8"));
			if (original.version !== receipt.version) throw new Error(`Qualified version differs: ${path}`);
			writeFileSync(file, `${JSON.stringify({ ...original, version }, null, "\t")}\n`);
		}
		const expected = inventory(join(scratch, "package"));
		for (const path of Object.keys(before))
			if (!["package.json"].includes(path) && JSON.stringify(before[path]) !== JSON.stringify(expected[path]))
				throw new Error(`Unqualified snapshot change: ${path}`);
		const output = join(directory, "dev-snapshot");
		mkdirSync(output, { recursive: true });
		const tarball = join(output, `iowarp-clio-coder-${version}.tgz`);
		const fileList = join(scratch, "files.txt");
		writeFileSync(
			fileList,
			`${Object.keys(expected)
				.filter((path) => expected[path].digest !== "directory")
				.map((path) => `package/${path}`)
				.join("\n")}\n`,
		);
		run("tar", [
			"--sort=name",
			`--mtime=@${Math.floor(new Date(timestamp).getTime() / 1000)}`,
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"-czf",
			tarball,
			"-C",
			scratch,
			"--no-recursion",
			"-T",
			fileList,
		]);
		const check = join(scratch, "verify");
		mkdirSync(check);
		run("tar", ["-xzf", tarball, "-C", check]);
		if (JSON.stringify(inventory(join(check, "package"))) !== JSON.stringify(expected))
			throw new Error("Snapshot archive differs from the verified version stamp.");
		const checksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
		return { ...receipt, version, tarball, files: { ...receipt.files, [basename(tarball)]: checksum } };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function releaseMode(receipt, rehearse = false) {
	// A check run is a release preflight that never reaches the protected job.
	const requested = process.env.CLIO_CODER_RELEASE_MODE === "check" ? "release" : process.env.CLIO_CODER_RELEASE_MODE;
	const mode = requested ?? (rehearse && DEV_VERSION.test(receipt.version) ? "dev" : "release");
	if (!["release", "dev"].includes(mode)) throw new Error("Release mode must be release or dev.");
	return mode;
}

function payload(receipt, directory, mode) {
	return mode === "dev" ? snapshotPayload(receipt, directory) : receipt;
}

/** Strict SemVer ordering for npm dist-tag forwarding; build metadata is ignored. */
export function compareVersions(left, right) {
	const parse = (value) =>
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/.exec(value);
	const a = parse(left),
		b = parse(right);
	if (!a || !b) throw new Error("Invalid registry version for tag forwarding.");
	for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Math.sign(Number(a[i]) - Number(b[i]));
	const x = a[4]?.split(".") ?? [],
		y = b[4]?.split(".") ?? [];
	if (!x.length || !y.length) return x.length === y.length ? 0 : x.length ? -1 : 1;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const l = x[i],
			r = y[i];
		if (l === r) continue;
		if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
		const ln = /^\d+$/.test(l),
			rn = /^\d+$/.test(r);
		if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : l.length < r.length ? -1 : 1;
		if (ln !== rn) return ln ? -1 : 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

export function forwardedTags(tags, version, channel) {
	const follow = channel === "latest" ? ["beta", "dev"] : channel === "beta" ? ["dev"] : [];
	return follow.filter((tag) => tags[tag] && compareVersions(tags[tag], version) < 0);
}

export async function registryTags(name) {
	const response = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`npm dist-tags returned HTTP ${response.status}`);
	return response.json();
}

export function api(path, method = "GET", body) {
	return JSON.parse(
		run("gh", ["api", path, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], {
			encoding: "utf8",
			stdio: "pipe",
			// List endpoints grow with release history; the 1 MiB default killed the 0.7.0 release.
			maxBuffer: 64 * 1024 * 1024,
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
	const qualified = verifyCandidate(directory, commit);
	const mode = releaseMode(qualified, true);
	const receipt = payload(qualified, directory, mode);
	const plan = publicationPlan(receipt, branch, mode);
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
	if (dryRun) dryRun = dryRun[receipt.name] ?? dryRun;
	if (
		dryRun &&
		(dryRun.name !== receipt.name ||
			dryRun.version !== receipt.version ||
			dryRun.integrity !== integrity(receipt.tarball))
	)
		throw new Error("npm dry-run differs from the qualified archive.");
	verifyCandidate(directory, commit);
	console.log(
		`Publication payload verified: ${plan.package}, ${plan.tag ?? "no git tag"}, ${plan.channel === "dev" ? "verified snapshot stamp; no GitHub release or site publish" : "five GitHub assets, prepared website"}. npm authorization remains unverified until a real publish.`,
	);
	return plan;
}

export async function registryVersion(name, version) {
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

export function requireIntegrity(published, receipt) {
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

// A published release resolves by tag in one call. The by-tag endpoint never
// returns a draft (the 0.6.2-rc.1 run crashed on that null), and a draft this job
// creates is the newest release, so only the first page is searched for it. No
// lookup scales with release history: the 0.7.0 list call outgrew its buffer.
function existingRelease(tag) {
	try {
		return api(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
	} catch (error) {
		if (!String(error.stderr).includes("404")) throw error;
	}
	return (
		api(`repos/${repository}/releases?per_page=10`).find((release) => release.draft && release.tag_name === tag) ?? null
	);
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

/**
 * The commit release.yml finishes from. It is the candidate, except that once npm serves the
 * candidate's bytes a version-branch head that only adds release-tooling commits may finish it
 * (item 3 of the 0.7.0 release): published npm bytes cannot change, so a tooling bug found after
 * publish is fixed by commit while the tag, tarball and website still come from the candidate.
 */
async function finishingHead(commit, receipt) {
	const head = process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_SHA : commit;
	if (head === commit) return head;
	if (!/^[a-f0-9]{40}$/u.test(head ?? "")) throw new Error("The workflow's source commit is unknown.");
	try {
		run("git", ["merge-base", "--is-ancestor", commit, head], { stdio: "pipe" });
	} catch {
		throw new Error(`The dispatched head ${head} does not descend from the candidate ${commit}.`);
	}
	const paths = git("diff", "--name-only", commit, head).split("\n").filter(Boolean);
	if (!toolingOnly(paths))
		throw new Error(`Only release-tooling commits may follow the candidate; ${head} also changes:\n${paths.join("\n")}`);
	const published = await registryVersion(receipt.name, receipt.version);
	if (!published)
		throw new Error(
			"A release-tooling fix may finish a release only after npm serves the candidate; release the candidate itself.",
		);
	requireIntegrity(published, receipt);
	console.log(`Finishing ${receipt.version} from ${head}, which adds only release-tooling changes to ${commit}.`);
	return head;
}

/**
 * Every finishing step in its read or plan form, run by the release preflight before the owner
 * publishes to npm and by the rehearsal (items 3 and 6), so a finishing bug surfaces while
 * nothing irreversible has happened.
 */
function finishCheck(directory, receipt, plan, head) {
	if (plan.tag === null) return;
	const notes = readFileSync(join(directory, "release-notes.md"), "utf8");
	if (notes.length > RELEASE_BODY_LIMIT)
		throw new Error(`Release notes are ${notes.length} characters; GitHub accepts at most ${RELEASE_BODY_LIMIT}.`);
	const decision = draftAction({ release: existingRelease(plan.tag), tagCommit: tagCommit(plan.tag) }, receipt.commit);
	if (decision.action === "stop") throw new Error(`GitHub release ${plan.tag}: ${decision.reason}.`);
	let site = "unchanged";
	if (plan.channel === "latest") {
		requireFastForward(head);
		site = publishWebsite(directory, receipt, { push: false });
	}
	console.log(
		`FINISH_CHECK_OK ${plan.tag} release=${decision.action} main=${plan.channel === "latest" ? `fast-forward to ${head}` : "unchanged"} site=${site}`,
	);
}

export async function preflight(directory, commit, runId, branch, rehearse = false, { check = true } = {}) {
	// The snapshot code stays for when CI can publish again; rehearsal still exercises it.
	if (!rehearse && process.env.CLIO_CODER_RELEASE_MODE === "dev")
		throw new Error(
			"Dev snapshots need working CI trusted publishing. The release job's npm OIDC exchange returns 404, and a snapshot's bytes exist only inside CI, so the owner cannot publish them.",
		);
	const receipt = verifyCandidate(directory, commit);
	await qualification(runId, commit, { inProgress: rehearse });
	if (String(receipt.run) !== String(runId)) throw new Error("Artifact belongs to another qualification run.");
	// ci (22) writes test-results.json and ci (24) test-results-24.json; both run the same tiers.
	const totals = [];
	for (const name of ["test-results.json", "test-results-24.json"]) {
		const path = join(directory, name);
		if (!existsSync(path)) throw new Error(`Qualification artifact lacks ${name}.`);
		const results = JSON.parse(readFileSync(path, "utf8"));
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
			throw new Error(`${name} does not describe this candidate or exceeds the test budget.`);
		totals.push(results.total);
	}
	const mode = releaseMode(receipt, rehearse);
	const publishedReceipt = payload(receipt, directory, mode);
	const plan = publicationPlan(publishedReceipt, branch, mode);
	const head = rehearse ? commit : await finishingHead(commit, publishedReceipt);
	if (mode === "release") requireFastForward(head);
	if (!rehearse) {
		const changelog = run("tar", ["-xzOf", receipt.tarball, "package/CHANGELOG.md"], { encoding: "utf8", stdio: "pipe" });
		const errors = releaseVersionErrors({ version: publishedReceipt.version, changelog, releaseContext: true });
		const section = changelog.split(/^## /mu)[1];
		if (!section?.slice(section.indexOf("\n") + 1).trim()) errors.push("Release notes must not be empty.");
		const site = JSON.parse(readFileSync(join(root, "site/product.json"), "utf8"));
		if (plan.channel === "latest" && (site.version !== receipt.version || site.publishedVersion !== receipt.version))
			errors.push("Set site/product.json version and publishedVersion to the final release version before qualification.");
		if (errors.length) throw new Error(errors.join("\n"));
		// A check run comes from a rehearsal before the version branch is pushed.
		const remote = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/u)[0];
		if (remote !== head && process.env.CLIO_CODER_RELEASE_MODE !== "check")
			throw new Error("Version branch moved; prepare a release from its current head.");
		const tag = plan.tag === null ? null : tagCommit(plan.tag);
		if (tag !== null && tag !== commit) throw new Error("Existing release tag points to another commit.");
		const published = await registryVersion(publishedReceipt.name, publishedReceipt.version);
		if (published) requireIntegrity(published, publishedReceipt);
		else if (tag !== null || (plan.tag !== null && existingRelease(plan.tag)))
			throw new Error("An existing GitHub release has no matching npm version; resolve it explicitly.");
	}
	const summary = `Clio Coder ${plan.version}\nSource: ${commit}\nQualification: https://github.com/${repository}/actions/runs/${runId}\nPackage: ${plan.tarball}\nSHA-256: ${plan.sha256}\nTests: ${totals.join(" on Node 22, ")} on Node 24, plus runtime/platform boot checks\n\n${plan.channel === "dev" ? "Approval verifies the owner-published npm dev snapshot only; no git tag, GitHub release, website or branch writes." : plan.channel === "beta" ? "Approval authorizes GitHub prerelease/tag creation for the owner-published npm beta version." : "Approval authorizes GitHub release/tag creation, main fast-forward, gh-pages deployment, and version-branch cleanup for the owner-published npm version."}\n`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	if (check && mode === "release") finishCheck(directory, publishedReceipt, plan, head);
	return { receipt: publishedReceipt, plan, head };
}

function verifyAssets(release, receipt) {
	for (const name of [basename(receipt.tarball), ...installers]) {
		const asset = release.assets.find((item) => item.name === name);
		if (asset?.digest !== `sha256:${receipt.files[name]}`) throw new Error(`GitHub release asset differs: ${name}`);
	}
}

function publishWebsite(directory, receipt, { push = true } = {}) {
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
		const changed = git("-C", checkout, "diff", "--cached", "--name-only");
		if (!push) return changed ? `${changed.split("\n").length} files to deploy` : "unchanged";
		if (changed) {
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

async function verifyPublic(receipt, plan, head = receipt.commit) {
	const published = await registryVersion(receipt.name, receipt.version);
	if (!published) throw new Error("Published npm version is missing.");
	requireIntegrity(published, receipt);
	const tags = await registryTags(receipt.name);
	if (tags[plan.channel] !== receipt.version) throw new Error(`npm ${plan.channel} points to another version.`);
	if (plan.channel === "dev") return;
	const release = existingRelease(plan.tag);
	if (!release || release.draft || tagCommit(plan.tag) !== receipt.commit)
		throw new Error("GitHub release/tag is not public at the qualified commit.");
	verifyAssets(release, receipt);
	if (release.prerelease !== (plan.channel === "beta")) throw new Error("GitHub release channel differs from npm.");
	if (plan.channel === "latest" && api(`repos/${repository}/releases/latest`).tag_name !== plan.tag)
		throw new Error("GitHub Latest points to another release.");
	if (plan.channel === "latest") {
		if (api(`repos/${repository}/git/ref/heads/main`).object.sha !== head)
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
	if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_WORKFLOW !== "release")
		throw new Error("Publication is restricted to the approved release.yml job.");
	if (process.env.CLIO_CODER_RELEASE_MODE === "check") throw new Error("A check run never publishes.");
	const { receipt, plan, head } = await preflight(directory, commit, runId, branch, false, { check: false });
	// The job's OIDC exchange has never authorized a publish (HTTP 404, then
	// ENEEDAUTH), so the owner publishes before this job writes anything to GitHub.
	// An approval given before npm serves the version waits here instead of failing;
	// npm took 11 minutes to serve 0.7.0 after accepting it.
	let published = await registryVersion(receipt.name, receipt.version);
	for (let minute = 0; !published && minute < NPM_WAIT_MINUTES; minute++) {
		console.log(`Waiting for npm to serve ${plan.package} (${minute} of ${NPM_WAIT_MINUTES} minutes)...`);
		await new Promise((resolve) => setTimeout(resolve, 60_000));
		published = await registryVersion(receipt.name, receipt.version);
	}
	if (!published)
		throw new Error(
			`npm has no ${plan.package}. The owner publishes the qualified tarball through \`pnpm run release\`, then reruns this job.`,
		);
	requireIntegrity(published, receipt);
	console.log("npm contains the qualified bytes; continuing publication.");
	if (plan.channel === "dev") {
		await verifyPublic(receipt, plan);
		console.log(`SNAPSHOT_COMPLETE ${receipt.version} ${commit}`);
		return;
	}
	const assets = [receipt.tarball, ...installers.map((name) => join(directory, name))];
	let release = existingRelease(plan.tag);
	const decision = draftAction({ release, tagCommit: tagCommit(plan.tag) }, commit);
	if (decision.action === "stop") throw new Error(`GitHub release ${plan.tag}: ${decision.reason}.`);
	if (decision.action === "create") {
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
			...assets,
		]);
		release = existingRelease(plan.tag);
	} else if (release.draft) {
		// A draft keeps the target it was created with, and publishing it creates the
		// immutable tag there, so an earlier attempt's draft is pinned first (item 5).
		if (decision.action === "retarget") {
			api(`repos/${repository}/releases/${release.id}`, "PATCH", { target_commitish: commit });
			release = api(`repos/${repository}/releases/${release.id}`);
		}
		run("gh", ["release", "upload", plan.tag, "--repo", repository, "--clobber", ...assets]);
		release = api(`repos/${repository}/releases/${release.id}`);
	}
	if (!release) throw new Error(`GitHub release ${plan.tag} was not found after creating it.`);
	console.log(
		`GitHub release ${plan.tag}: id ${release.id}, draft ${release.draft}, target ${release.target_commitish}`,
	);
	verifyAssets(release, receipt);
	if (release.draft) {
		if (release.target_commitish !== commit)
			throw new Error(`Draft ${plan.tag} targets ${release.target_commitish}, not ${commit}.`);
		run("gh", [
			"release",
			"edit",
			plan.tag,
			"--repo",
			repository,
			"--draft=false",
			...(plan.channel === "beta" ? ["--prerelease", "--latest=false"] : ["--latest"]),
		]);
	}
	if (tagCommit(plan.tag) !== commit) throw new Error("Published tag differs from the qualified commit.");
	if (plan.channel === "latest") {
		requireFastForward(head);
		run("git", ["push", "origin", `${head}:refs/heads/main`]);
		publishWebsite(directory, receipt);
		await verifyPublic(receipt, plan, head);
		// A lease makes cleanup a compare-and-delete operation. A concurrent
		// development commit is preserved instead of being deleted with the branch.
		run("git", ["push", `--force-with-lease=refs/heads/${branch}:${head}`, "origin", `:refs/heads/${branch}`]);
	} else await verifyPublic(receipt, plan);
	console.log(`RELEASE_COMPLETE ${receipt.version} ${commit}${head === commit ? "" : ` finished from ${head}`}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({
			options: {
				directory: { type: "string" },
				sha: { type: "string" },
				run: { type: "string" },
				mode: { type: "string" },
				branch: { type: "string" },
			},
			allowPositionals: true,
		});
		const directory = resolve(values.directory ?? "");
		if (values.mode) process.env.CLIO_CODER_RELEASE_MODE = values.mode;
		if (positionals[0] === "plan" || positionals[0] === "verify-bytes") {
			if (!values.sha || !values.branch) throw new Error("Supply --sha and --branch.");
			if (positionals[0] === "verify-bytes") await rehearseBytes(directory, values.sha, values.branch);
			else {
				const candidate = verifyCandidate(directory, values.sha);
				const mode = releaseMode(candidate, true);
				console.log(JSON.stringify(publicationPlan(payload(candidate, directory, mode), values.branch, mode), null, 2));
			}
			process.exit(0);
		}
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
