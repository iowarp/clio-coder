import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishTagErrors, releaseVersionErrors } from "./release-version-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directory = join(homedir(), ".cache", "clio-coder", "qualification", digest(root).slice(0, 16));
const receiptPath = join(directory, "qualification.json");
const artifact = join(directory, "candidate.tgz");
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const git = (...args) => run("git", args, { encoding: "utf8", stdio: "pipe" }).trim();

function source() {
	if (git("status", "--porcelain", "--untracked-files=normal"))
		throw new Error("Commit the candidate before qualification; the source tree must be clean.");
	return git("rev-parse", "HEAD");
}

function pack(destination) {
	const [report] = JSON.parse(
		run("npm", ["pack", "--json", "--pack-destination", destination], { encoding: "utf8", stdio: "pipe" }),
	);
	return join(destination, report.filename);
}

function releaseVersion() {
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const errors = releaseVersionErrors({
		version,
		changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
		releaseContext: true,
	});
	if (errors.length) throw new Error(errors.join("\n"));
	return version;
}

const scratch = mkdtempSync(join(tmpdir(), "clio-candidate-"));
try {
	const mode = process.argv[2];
	if (mode === "qualify" || mode === "qualify-after-ci") {
		mkdirSync(directory, { recursive: true });
		// Invalidate old evidence before starting: cancellation/failure cannot
		// leave an earlier success available for publication.
		rmSync(receiptPath, { force: true });
		const commit = source();
		// The release workflow has already run the reusable CI workflow against
		// this commit, so it starts from a fresh build. A local qualification runs
		// the static gates itself.
		// The full tiers run in the local qualification only. On a hosted runner
		// their timing-sensitive extended tests failed a release that passed them
		// locally, so the workflow relies on the CI gates it has just run.
		// test:full is a superset of test and test:maintenance.
		const steps =
			mode === "qualify" ? ["typecheck", "lint", "build", "check:gui", "test:full", "test:gui:full"] : ["build"];
		for (const step of steps) run("pnpm", ["run", step]);
		run(process.execPath, ["scripts/check-release.mjs"]);
		const packed = pack(scratch);
		run("pnpm", ["run", "test:package"], { env: { ...process.env, CLIO_CODER_RELEASE_TARBALL: packed } });
		if (source() !== commit) throw new Error("Candidate changed during qualification.");
		// Repacking proves the installed artifact still matches all publication
		// inputs, including ignored dist output. npm produces deterministic packs.
		const sha256 = digest(readFileSync(packed));
		const check = join(scratch, "check");
		mkdirSync(check);
		if (digest(readFileSync(pack(check))) !== sha256) throw new Error("Package changed during qualification.");
		copyFileSync(packed, artifact);
		writeFileSync(`${artifact}.sha256`, `${sha256}  candidate.tgz\n`);
		// Local publication preflight accepts only a receipt from full qualification.
		// CI's split gate passes through Actions dependencies instead of this cache.
		if (mode === "qualify") {
			writeFileSync(
				receiptPath,
				`${JSON.stringify({ schema: 1, commit, sha256, node: process.version, qualifiedAt: Date.now() })}\n`,
				{ mode: 0o600 },
			);
		}
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `artifact=${artifact}\n`);
		console.log(`Qualified ${commit}\nArtifact: ${artifact}\nSHA-256: ${sha256}`);
	} else if (mode === "preflight") {
		// Checked first: requalifying never fixes a wrong dist-tag.
		const tagErrors = publishTagErrors({
			version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
			tag: process.env.npm_config_tag,
		});
		if (tagErrors.length) throw new Error(tagErrors.join("\n"));
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		const age = Date.now() - receipt.qualifiedAt;
		if (
			receipt.schema !== 1 ||
			receipt.commit !== source() ||
			receipt.node !== process.version ||
			!Number.isFinite(age) ||
			age < 0 ||
			age > 24 * 60 * 60 * 1000
		) {
			throw new Error("Qualification is stale or belongs to different source/Node inputs. Run pnpm run ci:release.");
		}
		releaseVersion();
		if (digest(readFileSync(artifact)) !== receipt.sha256 || digest(readFileSync(pack(scratch))) !== receipt.sha256) {
			throw new Error("Qualified artifact or current package bytes changed. Run pnpm run ci:release.");
		}
		console.log(`Publication preflight passed for ${receipt.commit}\nArtifact: ${artifact}`);
	} else {
		throw new Error("Usage: node scripts/release-candidate.mjs qualify|qualify-after-ci|preflight");
	}
} catch (error) {
	console.error(`release-candidate: ${error.message}`);
	process.exitCode = 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
