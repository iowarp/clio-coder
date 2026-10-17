#!/usr/bin/env node
/** Read-only local readiness across package, website, docs, and media surfaces. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readmeInstallVersion, releaseVersionErrors } from "./release-version-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { release: { type: "boolean", default: false } } });
const releaseContext = values.release;
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const errors = [];
const notes = [];

function run(label, command, args) {
	try {
		execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		notes.push(`${label}: ok`);
	} catch (error) {
		const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
		errors.push(`${label}: ${output || error.message}`);
	}
}

const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A stable docs pin is committed before its tag exists and cannot name its own commit,
 * so the release flow pins the release commit in "repository" mode (3a59f1946 pins 7699f23a9).
 * A tag-based "release" pin stays valid once the tag resolves to the pinned commit.
 */
function docsPinErrors(source, version) {
	const pin = `website docs pin ${source.mode ?? "<no mode>"} ${source.ref ?? "<missing>"}`;
	if (source.mode === "release") {
		if (source.ref !== `v${version}`) return [`${pin}: a release pin must name ref v${version}`];
		try {
			const commit = git("rev-parse", "--verify", `${source.ref}^{commit}`);
			return commit === source.commit ? [] : [`${pin}: commit ${source.commit} differs from ${source.ref} at ${commit}`];
		} catch (error) {
			return [`${pin}: cannot resolve ${source.ref}: ${error instanceof Error ? error.message : String(error)}`];
		}
	}
	if (source.mode === "repository") {
		if (!/^[0-9a-f]{40}$/u.test(source.commit ?? "") || source.ref !== source.commit)
			return [`${pin}: a repository pin must name the full commit ${source.commit ?? "<missing>"} as its ref`];
		try {
			git("merge-base", "--is-ancestor", source.commit, "HEAD");
		} catch {
			return [`${pin}: commit ${source.commit} is not an ancestor of HEAD`];
		}
		try {
			const pinned = JSON.parse(git("show", `${source.commit}:package.json`)).version;
			return pinned === version ? [] : [`${pin}: package.json at ${source.commit} is ${pinned}, not ${version}`];
		} catch (error) {
			return [
				`${pin}: cannot read package.json at ${source.commit}: ${error instanceof Error ? error.message : String(error)}`,
			];
		}
	}
	return [`${pin}: mode must be release or repository`];
}

function checkVersions() {
	const pkg = json("package.json");
	const registry = json("assets/acp-registry/agent.json");
	const product = json("site/product.json");
	const docs = json("site/content/docs-manifest.json");
	const changelog = read("CHANGELOG.md");
	const readme = read("README.md");
	if (registry.version !== pkg.version)
		errors.push(`ACP registry version ${registry.version} differs from package version ${pkg.version}`);
	errors.push(...releaseVersionErrors({ version: pkg.version, changelog, releaseContext }));
	let stable;
	try {
		stable = readmeInstallVersion({ version: pkg.version, changelog });
	} catch (error) {
		errors.push(error.message);
		return;
	}
	const installPin = /git clone --branch v(\d+\.\d+\.\d+)\b/.exec(readme)?.[1];
	if (installPin !== stable)
		errors.push(`README source-install pin ${installPin ?? "<missing>"} differs from ${stable}`);
	if (product.version !== stable)
		errors.push(`website version ${product.version} differs from the latest dated stable release ${stable}`);
	if (docs.source?.version !== product.version)
		errors.push(`website docs version ${docs.source?.version ?? "<missing>"} differs from website ${product.version}`);
	errors.push(...docsPinErrors(docs.source ?? {}, product.version));
	const literals = [];
	for (const name of readdirSync(join(root, "site"))
		.filter((entry) => entry.endsWith(".html"))
		.sort()) {
		for (const match of read(`site/${name}`).matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)) {
			literals.push({ path: `site/${name}`, version: match[1] });
		}
	}
	if (literals.length === 0) errors.push("website HTML contains no visible product-version literal");
	for (const literal of literals) {
		if (literal.version !== product.version)
			errors.push(`${literal.path} names v${literal.version}; product.json names v${product.version}`);
	}
	if (releaseContext && pkg.version !== product.version)
		errors.push(`release package ${pkg.version} differs from website ${product.version}`);
	notes.push(
		releaseContext
			? `release state: checking immutable v${pkg.version} inputs`
			: `release state: development tree; public surfaces remain pinned to v${stable}`,
	);
}

let scratch;
try {
	checkVersions();
	run("documentation snapshot", "python3", ["site/sync-docs.py", "--check"]);
	run("media assets", "python3", ["scripts/media-assets.py", "--check"]);
	scratch = mkdtempSync(join(tmpdir(), "clio-release-readiness-"));
	const output = join(scratch, "public");
	run("isolated website build", process.execPath, ["site/build.mjs", "--out", output]);
	run("isolated website check", "python3", ["site/check.py", output]);
} catch (error) {
	errors.push(error instanceof Error ? error.message : String(error));
} finally {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
}
for (const note of notes) process.stdout.write(`release-readiness: ${note}\n`);
if (errors.length) {
	for (const error of errors) process.stderr.write(`release-readiness: ${error}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(
		"release-readiness: local inputs are consistent; npm, tags, GitHub, website, Wiki, and social publication still require explicit human approval\n",
	);
}
