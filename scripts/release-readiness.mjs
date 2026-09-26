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
	if (docs.source?.ref !== `v${product.version}`)
		errors.push(`website docs ref ${docs.source?.ref ?? "<missing>"} must be v${product.version}`);
	try {
		const commit = execFileSync("git", ["rev-parse", "--verify", `${docs.source.ref}^{commit}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (commit !== docs.source.commit)
			errors.push(`website docs commit ${docs.source.commit} differs from ${docs.source.ref} at ${commit}`);
	} catch (error) {
		errors.push(`cannot resolve website docs ref ${docs.source?.ref ?? "<missing>"}: ${error.message}`);
	}
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
