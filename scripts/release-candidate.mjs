#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runTests } from "./ci-tests.mjs";
import { releaseVersionErrors } from "./release-version-policy.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const installers = ["install.sh", "install.ps1", "install.cmd", "native-install.cjs"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: root,
		stdio: "inherit",
		...options,
		shell: process.platform === "win32" && /^(?:npm|pnpm)$/u.test(command),
	});
}
export const git = (...args) => run("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export function source() {
	if (git("status", "--porcelain", "--untracked-files=normal"))
		throw new Error("Commit the candidate first; the source tree must be clean.");
	return git("rev-parse", "HEAD");
}

// Qualification comes from successful checks on the receipt's Actions run.
// The publisher verifies these files instead of comparing independent builds.
export function verifyCandidate(directory, commit) {
	const receipt = json(join(directory, "candidate.json"));
	if (receipt.schema !== 2 || !/^[a-f0-9]{40}$/u.test(commit) || receipt.commit !== commit)
		throw new Error("Candidate receipt does not match the requested source commit.");
	if (receipt.name !== "@iowarp/clio-coder" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(receipt.version))
		throw new Error("Invalid candidate package identity.");
	const filename = `iowarp-clio-coder-${receipt.version}.tgz`;
	const expected = [filename, "website.tgz", "release-notes.md", "metafile-esm.json", ...installers].sort();
	if (JSON.stringify(Object.keys(receipt.files ?? {}).sort()) !== JSON.stringify(expected))
		throw new Error("Candidate receipt has an unexpected file inventory.");
	for (const [name, checksum] of Object.entries(receipt.files)) {
		if (!/^[a-f0-9]{64}$/u.test(checksum) || sha256(readFileSync(join(directory, name))) !== checksum)
			throw new Error(`Candidate checksum mismatch: ${name}`);
	}
	const tarball = join(directory, filename);
	const pkg = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], { stdio: "pipe", encoding: "utf8" }));
	if (pkg.name !== receipt.name || pkg.version !== receipt.version)
		throw new Error("Tarball version differs from its receipt.");
	const site = JSON.parse(
		run("tar", ["-xzOf", join(directory, "website.tgz"), "./version.json"], { stdio: "pipe", encoding: "utf8" }),
	);
	if (site.publishedVersion !== receipt.version || site.docsCommit !== commit || site.revision !== commit)
		throw new Error("Website metadata differs from the candidate.");
	return { ...receipt, tarball };
}

function prepareWebsite(directory, commit, version) {
	const scratch = mkdtempSync(join(tmpdir(), "clio-release-site-"));
	const checkout = join(scratch, "source");
	try {
		run("git", ["worktree", "add", "--detach", checkout, commit]);
		const site = join(checkout, "site");
		const product = json(join(site, "product.json"));
		if (product.version !== version)
			throw new Error("Set site/product.json to the release version before qualification.");
		product.publishedVersion = version;
		writeFileSync(join(site, "product.json"), `${JSON.stringify(product, null, "\t")}\n`);
		// Commit snapshots are immutable and available before the public tag.
		// Site generation stays outside the package checkout and its artifact.
		run("python3", ["site/sync-docs.py", "--snapshot-ref", commit], { cwd: checkout });
		run(process.execPath, ["site/deployment-check.mjs"], { cwd: checkout });
		run("python3", ["site/sync-docs.py", "--check"], { cwd: checkout });
		run(process.execPath, ["site/policy.mjs"], { cwd: checkout });
		const output = join(scratch, "public");
		run(process.execPath, ["site/build.mjs", "--out", output, "--revision", commit], { cwd: checkout });
		run("python3", ["site/check.py", output], { cwd: checkout });
		run("tar", ["-czf", join(directory, "website.tgz"), "-C", output, "."]);
	} finally {
		if (existsSync(checkout)) run("git", ["worktree", "remove", "--force", checkout]);
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function prepare(directory) {
	const commit = source();
	const pkg = json(join(root, "package.json"));
	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	const errors = releaseVersionErrors({ version: pkg.version, changelog, releaseContext: true });
	if (
		json(join(root, "assets/acp-registry/agent.json")).version !== pkg.version ||
		json(join(root, "apps/clio-coder-gui/package.json")).version !== pkg.version
	)
		errors.push("CLI, GUI, and ACP registry versions must agree.");
	if (errors.length) throw new Error(errors.join("\n"));
	mkdirSync(directory, { recursive: true });
	rmSync(join(directory, "candidate.json"), { force: true });
	for (const step of ["typecheck", "lint", "check:gui", "build"]) run("pnpm", ["run", step]);
	// Build metadata is qualification evidence, excluded from the npm package.
	// It lets the Stage 0 budget check inspect the chunks extracted from the archive.
	writeFileSync(join(directory, "metafile-esm.json"), readFileSync(join(root, "dist/metafile-esm.json")));
	const [report] = JSON.parse(
		run("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8", stdio: "pipe" }),
	);
	const reportPath = join(directory, "pack-report.json");
	writeFileSync(reportPath, JSON.stringify(report));
	run(
		process.execPath,
		["scripts/check-release.mjs", "--tarball", join(directory, report.filename), "--report", reportPath],
		{ env: { ...process.env, CLIO_CODER_RELEASE_CONTEXT: "publish" } },
	);
	rmSync(reportPath);
	for (const name of installers)
		writeFileSync(
			join(directory, name),
			run("tar", ["-xzOf", join(directory, report.filename), `package/scripts/${name}`], { stdio: "pipe" }),
		);
	const section = changelog.split(/^## /mu).find((text) => text.startsWith(`${pkg.version} - `));
	const notes = section?.slice(section.indexOf("\n") + 1).trim();
	if (!notes) throw new Error("Release notes must not be empty.");
	writeFileSync(join(directory, "release-notes.md"), `${notes}\n`);
	prepareWebsite(directory, commit, pkg.version);
	if (source() !== commit) throw new Error("Source changed during candidate preparation.");
	const files = Object.fromEntries(
		[report.filename, "website.tgz", "release-notes.md", "metafile-esm.json", ...installers].map((name) => [
			name,
			sha256(readFileSync(join(directory, name))),
		]),
	);
	const receipt = {
		schema: 2,
		name: pkg.name,
		version: pkg.version,
		commit,
		run: process.env.GITHUB_RUN_ID ?? null,
		files,
	};
	writeFileSync(join(directory, "candidate.json"), `${JSON.stringify(receipt, null, 2)}\n`);
	if (process.env.GITHUB_OUTPUT)
		appendFileSync(process.env.GITHUB_OUTPUT, `directory=${directory}\nversion=${pkg.version}\n`);
	console.log(`Prepared ${pkg.name}@${pkg.version} from ${commit}; SHA-256 ${files[report.filename]}`);
	return receipt;
}

export async function testCandidate(directory, commit) {
	const receipt = verifyCandidate(directory, commit);
	rmSync(join(root, "dist"), { recursive: true, force: true });
	run("tar", ["-xzf", receipt.tarball, "--strip-components=1", "-C", root, "package/dist"]);
	writeFileSync(join(root, "dist/metafile-esm.json"), readFileSync(join(directory, "metafile-esm.json")));
	process.env.CLIO_CODER_RELEASE_TARBALL = receipt.tarball;
	const counts = {};
	for (const tier of ["core", "gui", "package"]) counts[tier] = await runTests(tier);
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	if (total + 3 > 2000) throw new Error(`Default qualification exceeds its 2000-test budget: ${total + 3}`);
	verifyCandidate(directory, commit);
	if (source() !== commit) throw new Error("Source changed while testing the candidate.");
	writeFileSync(
		join(directory, "test-results.json"),
		`${JSON.stringify({ commit, sha256: receipt.files[basename(receipt.tarball)], counts, total }, null, 2)}\n`,
	);
	console.log(`Qualification tests: ${total} (${JSON.stringify(counts)})`);
}

export function smokeCandidate(directory, commit) {
	const receipt = verifyCandidate(directory, commit);
	const scratch = mkdtempSync(join(tmpdir(), "clio-release-boot-"));
	try {
		const prefix = join(scratch, "install");
		const home = join(scratch, "home");
		mkdirSync(home);
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CLIO_CODER_HOME: home,
			CLIO_CODER_CONFIG_DIR: join(home, "config"),
			CLIO_CODER_DATA_DIR: join(home, "data"),
			CLIO_CODER_STATE_DIR: join(home, "state"),
			CLIO_CODER_CACHE_DIR: join(home, "cache"),
			XDG_CONFIG_HOME: join(home, "xdg-config"),
			XDG_DATA_HOME: join(home, "xdg-data"),
			XDG_STATE_HOME: join(home, "xdg-state"),
			XDG_CACHE_HOME: join(home, "xdg-cache"),
		};
		run(
			"npm",
			["install", "--prefix", prefix, "--no-save", "--omit=optional", "--no-audit", "--no-fund", receipt.tarball],
			{ env },
		);
		const entry = join(prefix, "node_modules", "@iowarp", "clio-coder", "bin", "clio-coder.cjs");
		const label = run(process.execPath, [entry, "--version"], { cwd: home, env, stdio: "pipe", encoding: "utf8" });
		if (!label.includes(receipt.version)) throw new Error(`Installed version differs: ${label.trim()}`);
		run(process.execPath, [entry, "--help"], { cwd: home, env, stdio: "pipe" });
		console.log(
			`BOOT_OK ${process.platform} ${process.version} ${receipt.version} ${receipt.files[basename(receipt.tarball)]}`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({
			options: { directory: { type: "string" }, sha: { type: "string" } },
			allowPositionals: true,
		});
		const commit = values.sha ?? git("rev-parse", "HEAD");
		const directory = resolve(values.directory ?? join(tmpdir(), `clio-coder-candidate-${commit}`));
		const mode = positionals[0];
		if (mode === "prepare") prepare(directory);
		else if (mode === "test") await testCandidate(directory, commit);
		else if (mode === "smoke") smokeCandidate(directory, commit);
		else if (mode === "verify" || mode === "preflight")
			console.log(JSON.stringify(verifyCandidate(directory, commit), null, 2));
		else if (mode === "qualify") {
			if (existsSync(join(directory, "test-results.json"))) {
				const receipt = verifyCandidate(directory, commit);
				const results = json(join(directory, "test-results.json"));
				if (results.commit !== commit || results.sha256 !== receipt.files[basename(receipt.tarball)])
					throw new Error("Existing qualification differs from the candidate.");
				console.log(`Reusing tested ${commit} from ${directory}`);
			} else {
				prepare(directory);
				await testCandidate(directory, commit);
			}
			if (!existsSync(join(directory, "boot-passed"))) {
				smokeCandidate(directory, commit);
				writeFileSync(join(directory, "boot-passed"), commit);
			}
		} else
			throw new Error(
				"Usage: release-candidate.mjs prepare|test|smoke|verify|qualify --directory <path> [--sha <commit>]",
			);
	} catch (error) {
		console.error(`release-candidate: ${error.message}`);
		process.exitCode = 1;
	}
}
