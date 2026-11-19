#!/usr/bin/env node
/**
 * pnpm run preflight [-- --release]
 *
 * Every release check that needs no build, in about ten seconds: version agreement, changelog and
 * release-notes shape, website and documentation pins, the docs snapshot, media and launcher pins,
 * the size budgets the source tree already decides, and the tools qualification will reach for.
 * Qualification (local and CI) and `pnpm run release` run it before anything slow, so a candidate
 * that cannot be released is refused before a build, a push or a CI run is spent on it. The 0.8.4
 * docs budget failed only after a full build and pack; this reports it from the source tree.
 *
 * `--release` holds the tree to what a publish needs: a clean version branch, a release version,
 * a dated changelog heading and non-empty notes.
 */
import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { pnpmCommand } from "./pnpm.mjs";
import { nodeBinary, QUALIFIED_MAJORS } from "./release/node-majors.mjs";
import { isVersionBranch, RELEASE_BODY_LIMIT, tmpdirProblem } from "./release/plan.mjs";
import { classifySizes } from "./release-budgets.mjs";
import { DEV_VERSION, publishTagErrors, releaseVersionErrors } from "./release-version-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** Room the credits section may take after the changelog notes. */
const CREDITS_ALLOWANCE = 5_000;
/** Classes whose every file is tracked source, so their size is final before any build. */
export const SOURCE_SIZE_CLASSES = ["docs", "library+examples+models+root files"];

/** The first changelog section's body: the text a release publishes as its notes. */
export function releaseNotes(changelog) {
	const section = changelog.split(/^## /mu)[1];
	return section?.slice(section.indexOf("\n") + 1).trim() ?? "";
}

/** Pure text checks of the version files, the changelog heading and the notes. */
export function versionProblems({ version, guiVersion, registryVersion, changelog, release }) {
	const problems = [];
	if (guiVersion !== version || registryVersion !== version)
		problems.push(
			`versions disagree: package.json ${version}, apps/clio-coder-gui/package.json ${guiVersion}, assets/acp-registry/agent.json ${registryVersion}`,
		);
	problems.push(...releaseVersionErrors({ version, changelog, releaseContext: release }));
	const notes = releaseNotes(changelog);
	if (release && !notes) problems.push("the first CHANGELOG.md section has no notes; a release publishes them");
	if (notes.length > RELEASE_BODY_LIMIT - CREDITS_ALLOWANCE)
		problems.push(
			`release notes are ${notes.length} characters; GitHub accepts ${RELEASE_BODY_LIMIT} and the credits need ${CREDITS_ALLOWANCE}`,
		);
	return problems;
}

async function readiness(strict) {
	try {
		await exec(process.execPath, [join(root, "scripts/release-readiness.mjs"), ...(strict ? ["--release"] : [])], {
			cwd: root,
		});
		return [];
	} catch (error) {
		const lines = `${error.stderr ?? ""}`.trim().split("\n").filter(Boolean);
		return lines.length
			? lines.map((line) => line.replace(/^release-readiness: /u, ""))
			: [`release readiness: ${error.message}`];
	}
}

async function sourceSizes() {
	let report;
	try {
		const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
			cwd: root,
			maxBuffer: 64 * 1024 * 1024,
			shell: process.platform === "win32",
		});
		report = JSON.parse(stdout)[0];
	} catch (error) {
		return {
			errors: [`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`],
			warnings: [],
			note: "",
		};
	}
	const { totals, errors, warnings } = classifySizes(report.files, { only: SOURCE_SIZE_CLASSES });
	const note = totals
		.filter((budget) => SOURCE_SIZE_CLASSES.includes(budget.class))
		.map((budget) => `${budget.class} ${budget.bytes}/${budget.maxBytes}`)
		.join(", ");
	return { errors, warnings, note };
}

const starts = (command, args = ["--version"]) => {
	const probe = spawnSync(command, args, { stdio: "ignore" });
	return probe.error === undefined && probe.status === 0;
};

/** What qualification and the release command start, checked before either does. */
async function toolProblems({ release }) {
	const problems = [];
	const temp = tmpdirProblem(tmpdir());
	if (temp) problems.push(temp);
	for (const tool of ["git", "tar", "python3", "npm", ...(release ? ["gh"] : [])])
		if (!starts(tool)) problems.push(`${tool} is not on PATH`);
	if (pnpmCommand()[0] === "corepack" && !starts("corepack"))
		problems.push("neither pnpm nor corepack is on PATH; run `corepack enable` or install pnpm");
	for (const major of QUALIFIED_MAJORS)
		try {
			nodeBinary(major);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	return problems;
}

function treeProblems() {
	const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
	const problems = [];
	if (git("status", "--porcelain", "--untracked-files=normal"))
		problems.push("the tree has uncommitted or untracked files; commit the candidate first");
	const branch = git("branch", "--show-current");
	if (!isVersionBranch(branch))
		problems.push(`on ${branch || "a detached head"}; release from the version branch, such as v084`);
	return problems;
}

/**
 * Returns `{ problems, warnings, notes }`. `release` applies the publish rules; `tools` also checks the
 * machine (TMPDIR, Node 22 and 24, git, tar, python3, npm, pnpm), which a CI job has by construction.
 */
export async function preflight({ release = false, tools = true } = {}) {
	const version = json("package.json").version;
	const stable = /^\d+\.\d+\.\d+$/u.test(version);
	const problems = [];
	if (release) {
		// What release.yml's preflight refuses after qualification and a CI run, refused here first.
		const channel = version.includes("-") ? "beta" : "latest";
		if (DEV_VERSION.test(version))
			problems.push(`package.json is ${version}, a development version; set the release version first`);
		else problems.push(...publishTagErrors({ version, tag: channel }));
		const site = json("site/product.json");
		if (stable && (site.version !== version || site.publishedVersion !== version))
			problems.push(
				`site/product.json names ${site.version} (published ${site.publishedVersion}); a stable release sets both to ${version}`,
			);
	}
	problems.push(
		...versionProblems({
			version,
			guiVersion: json("apps/clio-coder-gui/package.json").version,
			registryVersion: json("assets/acp-registry/agent.json").version,
			changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
			release,
		}),
	);
	if (release) problems.push(...treeProblems());
	// A release candidate (-rc.N) leaves the website on the last stable, so only a stable release is held to --release.
	const [ready, sizes, machine] = await Promise.all([
		readiness(release && stable),
		sourceSizes(),
		tools ? toolProblems({ release }) : [],
	]);
	problems.push(...ready, ...sizes.errors, ...machine);
	return {
		problems: [...new Set(problems)],
		warnings: sizes.warnings,
		notes: [`${version}${release ? " release" : ""}`, ...(sizes.note ? [`source sizes ${sizes.note}`] : [])],
	};
}

/** Runs the preflight, prints its findings and throws when anything is not ready. */
export async function requirePreflight(options) {
	const started = Date.now();
	const { problems, warnings, notes } = await preflight(options);
	for (const warning of warnings) console.log(`preflight: warning: ${warning}`);
	if (problems.length)
		throw new Error(
			`Preflight found ${problems.length} problem(s):\n${problems.map((line) => `  - ${line}`).join("\n")}`,
		);
	console.log(`preflight: ok in ${((Date.now() - started) / 1000).toFixed(1)} s (${notes.join("; ")})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values } = parseArgs({
			args: process.argv.slice(2).filter((argument) => argument !== "--"),
			options: { release: { type: "boolean", default: false } },
		});
		await requirePreflight({ release: values.release });
	} catch (error) {
		console.error(`preflight: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
