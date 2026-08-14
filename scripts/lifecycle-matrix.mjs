#!/usr/bin/env node
/**
 * The v0.3.0 lifecycle matrix, run against the package a user would receive.
 *
 * A source checkout answers a different question than a tarball does. `npm
 * pack` produces the artifact, it is installed into a throwaway prefix, and
 * every case below drives that launcher rather than `dist/cli/index.js`. Each
 * case records its command, exit status, the filesystem before and after, and
 * the output, so a claim in the handoff can be checked against a file instead
 * of taken on trust.
 *
 * Everything lives under one `mktemp -d` root. Nothing outside it is read for
 * state or written at all, no CLIO_* variable from the caller's environment
 * survives into a case, and every destructive command is aimed at a path that
 * is re-validated as a descendant of that root immediately before it runs.
 *
 * Run it with `npm run test:lifecycle`. It imports the pty harness from
 * `tests/`, so it needs the tsx loader the npm script supplies.
 *
 * Usage:
 *   npm run test:lifecycle -- [--keep] [--only <id>[,<id>...]] [--live]
 *
 *   --keep   leave the temporary root in place for inspection
 *   --only   run a subset by case id, e.g. --only 12,13,14
 *   --live   run case 9, the real main-agent turn, which needs a reachable
 *            target whose model is already loaded. Off by default: loading a
 *            model as a side effect of a test is not this script's business.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = "clio-lifecycle-";

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const LIVE = argv.includes("--live");
const ONLY = (() => {
	const index = argv.indexOf("--only");
	if (index === -1) return null;
	const value = argv[index + 1];
	return value ? new Set(value.split(",").map((part) => part.trim())) : null;
})();

/* ------------------------------------------------------------------ safety */

const ROOT = mkdtempSync(join(tmpdir(), ROOT_PREFIX));

/**
 * Re-validate before every mutation rather than trusting a path built earlier.
 * A destructive command in this script is only ever aimed at a real descendant
 * of the temporary root, never at the root's parent, never at `/`, and never at
 * a path assembled from a variable that could have come back empty.
 */
function inRoot(path) {
	const target = resolve(path);
	if (target === ROOT) return true;
	const rel = relative(ROOT, target);
	// `relative` returns an absolute path when the two are on different roots,
	// and a `..` prefix when the target escapes upward. Both are rejections.
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertInRoot(path, what) {
	if (typeof path !== "string" || path.trim().length === 0) {
		throw new Error(`${what}: refusing to act on an empty path`);
	}
	if (!inRoot(path)) {
		throw new Error(`${what}: ${path} is outside the temporary root ${ROOT}`);
	}
	return path;
}

function child(...parts) {
	if (parts.some((part) => typeof part !== "string" || part.length === 0)) {
		throw new Error(`refusing to build a path from ${JSON.stringify(parts)}`);
	}
	return assertInRoot(join(ROOT, ...parts), "child");
}

function removeUnderRoot(path, what) {
	assertInRoot(path, what);
	rmSync(path, { recursive: true, force: true });
}

/* ------------------------------------------------------------- environment */

/** A shell environment with every CLIO_* and XDG_* inherited value removed. */
function isolatedEnv(home, extra = {}) {
	assertInRoot(home, "isolatedEnv home");
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("CLIO_")) continue;
		if (key.startsWith("XDG_")) continue;
		if (value !== undefined) env[key] = value;
	}
	return {
		...env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		// Never manage residency on any node from a lifecycle test.
		CLIO_CODER_RESIDENCY: "observe",
		npm_config_update_notifier: "false",
		...extra,
	};
}

/* --------------------------------------------------------------- snapshots */

const SNAPSHOT_LIMIT = 400;

/** Type, mode, and link target for every path under `root`, sorted and bounded. */
function snapshot(root) {
	if (!existsSync(root)) return { root, exists: false, entries: [] };
	const entries = [];
	const walk = (dir) => {
		if (entries.length >= SNAPSHOT_LIMIT) return;
		let names;
		try {
			names = readdirSync(dir).sort();
		} catch (error) {
			entries.push({ path: relative(root, dir) || ".", type: "unreadable", detail: String(error.code ?? error) });
			return;
		}
		for (const name of names) {
			if (entries.length >= SNAPSHOT_LIMIT) return;
			const full = join(dir, name);
			let stat;
			try {
				stat = lstatSync(full);
			} catch {
				continue;
			}
			const rel = relative(root, full);
			const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
			if (stat.isSymbolicLink()) {
				let target = "?";
				try {
					target = readlinkSync(full);
				} catch {
					// A dangling link still has a name worth recording.
				}
				entries.push({ path: rel, type: "symlink", mode, target, dangling: !existsSync(full) });
				continue;
			}
			if (stat.isDirectory()) {
				entries.push({ path: rel, type: "dir", mode });
				walk(full);
				continue;
			}
			entries.push({ path: rel, type: "file", mode, size: stat.size });
		}
	};
	walk(root);
	return { root, exists: true, entries, truncated: entries.length >= SNAPSHOT_LIMIT };
}

function paths(snap) {
	return new Set(snap.entries.map((entry) => entry.path));
}

/* ------------------------------------------------------------------ runner */

const OUTPUT_LIMIT = 4000;

function clip(text) {
	if (typeof text !== "string") return "";
	return text.length <= OUTPUT_LIMIT
		? text
		: `${text.slice(0, OUTPUT_LIMIT)}\n… ${text.length - OUTPUT_LIMIT} more bytes`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120_000,
		cwd: options.cwd ?? ROOT,
		env: options.env ?? process.env,
		input: options.input,
		shell: false,
	});
	return {
		command: `${command} ${args.join(" ")}`,
		exitCode: result.status,
		signal: result.signal ?? null,
		stdout: clip(result.stdout ?? ""),
		stderr: clip(result.stderr ?? ""),
	};
}

const cases = [];

function testCase(id, title, body) {
	cases.push({ id: String(id), title, body });
}

/* ------------------------------------------------------------------ shared */

const PACK = { tarball: null, files: [] };

function freshHome(name) {
	const home = child("homes", name);
	mkdirSync(home, { recursive: true });
	return home;
}

/**
 * One prefix, reused by every case. A packaged install is roughly 490MB and
 * `/tmp` is commonly a tmpfs a few gigabytes wide, so a prefix per case did not
 * fit. Reinstalling into the prefix that already holds an installation is also
 * what a user upgrading actually does, which is what cases 10, 11, and 17 mean
 * to exercise.
 */
const PREFIX = () => child("prefix");
const LAUNCHER = () => join(PREFIX(), "bin", "clio-coder");

function installPackage(env) {
	mkdirSync(PREFIX(), { recursive: true });
	return run(
		"npm",
		["install", "--global", "--prefix", PREFIX(), "--no-audit", "--no-fund", "--loglevel=error", PACK.tarball],
		{ env, timeoutMs: 300_000 },
	);
}

/* ------------------------------------------------------------------- cases */

testCase(1, "package creation and inspection", () => {
	const out = child("pack");
	mkdirSync(out, { recursive: true });
	const packed = run("npm", ["pack", "--pack-destination", out, "--loglevel=error"], {
		cwd: REPO_ROOT,
		timeoutMs: 300_000,
	});
	const name = (packed.stdout.trim().split("\n").pop() ?? "").trim();
	PACK.tarball = join(out, name);
	// Read outside `run`, whose output clip would truncate a 198-file listing
	// to 118 lines and fail five contents checks on a complete package.
	const listing = spawnSync("tar", ["-tzf", PACK.tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	PACK.files = (listing.stdout ?? "")
		.split("\n")
		.map((line) => line.replace(/^package\//, "").trim())
		.filter((line) => line.length > 0 && !line.endsWith("/"));
	writeFileSync(child("pack", "files.txt"), `${PACK.files.join("\n")}\n`, "utf8");

	const checks = [
		["pack succeeded", packed.exitCode === 0],
		["tarball exists", existsSync(PACK.tarball)],
		["carries the built entry", PACK.files.includes("dist/cli/index.js")],
		["carries no source maps", !PACK.files.some((f) => f.endsWith(".map"))],
		["carries no repo scripts", !PACK.files.some((f) => f.startsWith("scripts/"))],
		["carries no tests", !PACK.files.some((f) => f.startsWith("tests/"))],
		["carries no trace viewer", !PACK.files.some((f) => f.startsWith("apps/"))],
		["carries bundled skills", PACK.files.some((f) => f.startsWith("skills/"))],
		["carries builtin agents", PACK.files.some((f) => f.startsWith("src/domains/agents/builtins/"))],
		["carries the model catalog", PACK.files.some((f) => f.startsWith("src/domains/providers/models/"))],
		["carries docs", PACK.files.some((f) => f.startsWith("docs/") && f.endsWith(".md"))],
		["carries the damage-control rules", PACK.files.includes("damage-control-rules.yaml")],
	];
	return {
		command: packed.command,
		exitCode: packed.exitCode,
		stdout: packed.stdout,
		stderr: packed.stderr,
		notes: `${PACK.files.length} files`,
		checks,
	};
});

testCase(2, "clean install into a temporary prefix", () => {
	const home = freshHome("main");
	const env = isolatedEnv(home);
	const before = snapshot(child("prefix"));
	const install = installPackage(env);
	const prefix = PREFIX();
	const launcher = LAUNCHER();
	const after = snapshot(join(prefix, "bin"));
	const stat = existsSync(launcher) ? lstatSync(launcher) : null;
	return {
		command: install.command,
		exitCode: install.exitCode,
		stdout: install.stdout,
		stderr: install.stderr,
		before,
		after,
		checks: [
			["install succeeded", install.exitCode === 0],
			["launcher exists", existsSync(launcher)],
			["launcher is executable", stat !== null && (stat.mode & 0o111) !== 0],
			[
				"entry has an ESM shebang",
				readFileSync(join(prefix, "lib", "node_modules", "@iowarp", "clio-coder", "dist", "cli", "index.js"), "utf8")
					.split("\n", 1)[0]
					.startsWith("#!"),
			],
		],
	};
});

testCase(3, "first --version and --help from the packaged launcher", () => {
	const home = freshHome("main");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	const version = run(launcher, ["--version"], { env });
	const help = run(launcher, ["--help"], { env });
	const declared = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
	return {
		command: `${version.command} ; ${help.command}`,
		exitCode: version.exitCode,
		stdout: `${version.stdout}\n---\n${help.stdout}`,
		stderr: `${version.stderr}${help.stderr}`,
		checks: [
			["--version exits 0", version.exitCode === 0],
			["--version prints the packaged version", version.stdout.includes(declared)],
			["--version prints no v0.2.x string", !/\b0\.2\.\d+/.test(version.stdout)],
			["--help exits 0", help.exitCode === 0],
			["--help lists configure", help.stdout.includes("configure")],
			["--help states global-flag position", help.stdout.includes("clio-coder --no-context-files")],
		],
	};
});

testCase(4, "empty-state non-TTY launch", () => {
	const home = freshHome("empty-nontty");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	const before = snapshot(home);
	const result = run(launcher, [], { env });
	const after = snapshot(home);
	return {
		...result,
		before,
		after,
		checks: [
			["exits 0 without a TTY", result.exitCode === 0],
			["does not open a prompt", !result.stdout.includes("Selection [")],
			["says no target is configured", /no model target configured/i.test(result.stdout)],
			["names the command that fixes it", result.stdout.includes("clio-coder configure")],
			["does not claim to be ready", !/·\s*ready/.test(result.stdout)],
			["creates its config root", existsSync(join(home, ".config", "clio-coder"))],
		],
	};
});

testCase(5, "empty-state interactive onboarding, cancel, and completion", async () => {
	const launcher = LAUNCHER();
	const { runInPty, stripAnsi } = await import("../tests/harness/pty.ts");

	const cancelHome = freshHome("onboard-cancel");
	const cancelled = await runInPty(launcher, ["configure"], {
		cols: 80,
		rows: 24,
		cwd: ROOT,
		env: isolatedEnv(cancelHome),
		timeoutMs: 30_000,
		readyWhen: /Selection \[/,
		// Pick the local-HTTP bucket before cancelling, so the runtime list this
		// case asserts on is actually on screen.
		input: [
			{ afterMs: 300, data: "2\r" },
			{ afterMs: 900, data: String.fromCharCode(3) },
		],
	});
	const cancelledText = stripAnsi(cancelled.output);
	const cancelledSettings = join(cancelHome, ".config", "clio-coder", "settings.yaml");
	const cancelledWroteTarget = existsSync(cancelledSettings)
		? /targets:\s*\n\s+- /.test(readFileSync(cancelledSettings, "utf8"))
		: false;

	const doneHome = freshHome("onboard-done");
	const doneEnv = isolatedEnv(doneHome);
	// Non-interactive completion, which is the same writer the wizard commits
	// through. The wizard's own happy path needs a reachable endpoint to probe.
	const completed = run(
		launcher,
		[
			"configure",
			"--id",
			"onboarded",
			"--runtime",
			"openai-compat",
			"--url",
			"http://127.0.0.1:9",
			"--model",
			"onboarded-model",
			"--force",
			"--set-orchestrator",
		],
		{ env: doneEnv },
	);
	const doneSettings = join(doneHome, ".config", "clio-coder", "settings.yaml");
	const doneText = existsSync(doneSettings) ? readFileSync(doneSettings, "utf8") : "";

	return {
		command: "clio-coder configure (pty, Ctrl-C) ; clio-coder configure --id onboarded …",
		exitCode: completed.exitCode,
		stdout: `${cancelledText}\n---\n${completed.stdout}`,
		stderr: completed.stderr,
		after: snapshot(doneHome),
		checks: [
			["the wizard offers a numbered menu", /1\. Local app/.test(cancelledText)],
			["the menu fits 80 columns", cancelledText.split("\n").every((line) => line.length <= 80)],
			["the local-HTTP bucket lists llama.cpp", /llamacpp/.test(cancelledText)],
			// The default was whatever sorted first by label, so the bucket that
			// advertises llama.cpp, vLLM, and SGLang offered Antigravity CLI to
			// anyone who pressed Enter.
			["the runtime list offers no alphabetical default", !/Selection \(number or runtime id\) \[/.test(cancelledText)],
			[
				"the runtime list prints one heading, not two",
				!cancelledText.split("\n").some((line) => line.trim() === "Local HTTP:"),
			],
			["cancel is reported, not swallowed", /cancel/i.test(cancelledText)],
			["cancel writes no target", !cancelledWroteTarget],
			["completion exits 0", completed.exitCode === 0],
			["completion persists the target", doneText.includes("onboarded")],
			["completion sets the orchestrator", /orchestrator:[\s\S]*target: onboarded/.test(doneText)],
		],
	};
});

testCase(6, "scripted non-interactive configuration", () => {
	const home = freshHome("scripted");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	const before = snapshot(join(home, ".config"));
	const result = run(
		launcher,
		[
			"configure",
			"--id",
			"scripted",
			"--runtime",
			"openai-compat",
			"--url",
			"http://127.0.0.1:9",
			"--model",
			"scripted-model",
			"--force",
			"--set-orchestrator",
		],
		{ env, input: "" },
	);
	const settingsPath = join(home, ".config", "clio-coder", "settings.yaml");
	const settings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
	const targets = run(launcher, ["targets"], { env });
	return {
		...result,
		before,
		after: snapshot(join(home, ".config")),
		checks: [
			["exits 0", result.exitCode === 0],
			["opened no prompt", !result.stdout.includes("Selection")],
			["wrote the target", settings.includes("id: scripted")],
			["clio-coder targets lists it", targets.stdout.includes("scripted")],
			["settings.yaml is owner-writable", (lstatSync(settingsPath).mode & 0o200) !== 0],
		],
	};
});

testCase(7, "invalid settings and permission failures", () => {
	const home = freshHome("broken");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });
	const settingsPath = join(home, ".config", "clio-coder", "settings.yaml");

	writeFileSync(settingsPath, "version: 1\nidentity: clio\ntypoKey: 3\n", "utf8");
	const unknownKey = run(launcher, ["doctor"], { env });
	const loader = run(launcher, ["targets"], { env });

	writeFileSync(settingsPath, "version: 1\n  bad: [unclosed\n", "utf8");
	const parseError = run(launcher, ["doctor"], { env });
	const parseRows = parseError.stdout.trimEnd().split("\n");

	// An unwritable config root, restored before the case returns.
	const configRoot = assertInRoot(join(home, ".config", "clio-coder"), "unwritable config root");
	const originalMode = lstatSync(configRoot).mode & 0o777;
	let unwritable = { exitCode: null, stdout: "", stderr: "", command: "" };
	try {
		chmodSync(configRoot, 0o500);
		unwritable = run(launcher, ["doctor", "--fix"], { env });
	} finally {
		chmodSync(configRoot, originalMode);
	}

	const recovered = run(launcher, ["reset", "--config", "--force"], { env });
	const afterRecovery = run(launcher, ["doctor"], { env });

	return {
		command: "clio-coder doctor / targets against an invalid settings.yaml, then an unwritable config root",
		exitCode: unknownKey.exitCode,
		stdout: `${unknownKey.stdout}\n---\n${parseError.stdout}\n---\n${unwritable.stdout}`,
		stderr: `${loader.stderr}\n---\n${unwritable.stderr}`,
		checks: [
			["an unknown key fails doctor", unknownKey.exitCode === 1],
			["the unknown key is named", unknownKey.stdout.includes("typoKey")],
			["the remedy is a command that works", unknownKey.stdout.includes("clio-coder reset --config --force")],
			["the loader names the file", /settings\.yaml/.test(loader.stderr)],
			["the loader says --fix never rewrites settings", /never rewrites settings/.test(loader.stderr)],
			["the loader names the remedy that works", /clio-coder reset --config --force/.test(loader.stderr)],
			["a YAML parse error stays one row per finding", parseRows.every((row) => /^(OK|WARN|!!)/.test(row))],
			["an unwritable config root fails rather than half-succeeding", unwritable.exitCode !== 0],
			["the unwritable failure names a path", /clio/.test(`${unwritable.stdout}${unwritable.stderr}`)],
			["the documented remedy recovers", recovered.exitCode === 0 && afterRecovery.exitCode === 0],
		],
	};
});

testCase(8, "local target discovery and doctor verification", () => {
	const home = freshHome("doctor");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	const fixed = run(launcher, ["doctor", "--fix"], { env });
	const report = run(launcher, ["doctor"], { env });
	const list = run(launcher, ["configure", "--list"], { env });
	const models = run(launcher, ["models"], { env });
	return {
		command: `${fixed.command} ; ${report.command} ; ${list.command}`,
		exitCode: report.exitCode,
		stdout: `${report.stdout}\n---\n${list.stdout}\n---\n${models.stdout}`,
		stderr: `${report.stderr}${models.stderr}`,
		after: snapshot(join(home, ".config", "clio-coder")),
		checks: [
			["doctor --fix exits 0 on a fresh install", fixed.exitCode === 0],
			["doctor exits 0 on a fresh install", report.exitCode === 0],
			[
				"every doctor row is a finding",
				report.stdout
					.trimEnd()
					.split("\n")
					.every((r) => /^(OK|WARN|!!)/.test(r)),
			],
			["configure --list exits 0", list.exitCode === 0],
			["configure --list respects 80 columns", list.stdout.split("\n").every((line) => line.length <= 80)],
			["configure --list groups runtimes", list.stdout.includes("Cloud APIs:")],
			[
				"an unconfigured models call reports that, not a fake catalog",
				models.exitCode !== 0 || /no .*target|not configured/i.test(`${models.stdout}${models.stderr}`),
			],
		],
	};
});

testCase(9, "a first useful main-agent turn from the packaged install", () => {
	if (!LIVE) {
		return {
			command: 'clio-coder run "…"  (not run)',
			exitCode: null,
			status: "not-run",
			notes:
				"Requires a reachable target whose model is already loaded. Every target in the operator's " +
				"settings names a model that is not currently resident, and loading one is out of scope for " +
				"this script. Re-run with --live and CLIO_CODER_LIFECYCLE_TARGET / CLIO_CODER_LIFECYCLE_MODEL once a " +
				"suitable target is resident.",
			checks: [],
		};
	}
	const targetUrl = process.env.CLIO_CODER_LIFECYCLE_URL;
	const model = process.env.CLIO_CODER_LIFECYCLE_MODEL;
	const runtime = process.env.CLIO_CODER_LIFECYCLE_RUNTIME ?? "openai-compat";
	if (!targetUrl || !model) {
		throw new Error("--live needs CLIO_CODER_LIFECYCLE_URL and CLIO_CODER_LIFECYCLE_MODEL");
	}
	const home = freshHome("live-turn");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	const configured = run(
		launcher,
		[
			"configure",
			"--id",
			"live",
			"--runtime",
			runtime,
			"--url",
			targetUrl,
			"--model",
			model,
			"--force",
			"--set-orchestrator",
		],
		{ env },
	);
	const workspace = child("live-workspace");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, "answer.txt"), "the file already exists\n", "utf8");
	const turn = run(launcher, ["run", "--autonomy", "read-only", "Read answer.txt and reply with its contents."], {
		env,
		cwd: workspace,
		timeoutMs: 300_000,
	});
	return {
		command: turn.command,
		exitCode: turn.exitCode,
		stdout: turn.stdout,
		stderr: turn.stderr,
		checks: [
			["configuration succeeded", configured.exitCode === 0],
			["the turn exits 0", turn.exitCode === 0],
			["the turn read the file", /already exists/.test(turn.stdout)],
		],
	};
});

testCase(10, "reinstall over healthy state", () => {
	const home = freshHome("reinstall-healthy");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });
	run(
		launcher,
		[
			"configure",
			"--id",
			"kept",
			"--runtime",
			"openai-compat",
			"--url",
			"http://127.0.0.1:9",
			"--model",
			"kept-model",
			"--force",
		],
		{ env },
	);
	const credentials = join(home, ".config", "clio-coder", "credentials.yaml");
	writeFileSync(credentials, "version: 1\nentries: {}\n# sentinel-preserved\n", "utf8");
	chmodSync(credentials, 0o600);
	const before = snapshot(join(home, ".config", "clio-coder"));

	const second = installPackage(env);
	const after = snapshot(join(home, ".config", "clio-coder"));
	const settings = readFileSync(join(home, ".config", "clio-coder", "settings.yaml"), "utf8");
	const creds = readFileSync(credentials, "utf8");
	const doctor = run(launcher, ["doctor"], { env });
	return {
		...second,
		before,
		after,
		checks: [
			["reinstall succeeds", second.exitCode === 0],
			["the configured target survives", settings.includes("id: kept")],
			["credentials are untouched", creds.includes("sentinel-preserved")],
			["credentials keep owner-only mode", (lstatSync(credentials).mode & 0o777) === 0o600],
			["doctor is clean afterwards", doctor.exitCode === 0],
		],
	};
});

testCase(11, "reinstall over partial state", () => {
	const home = freshHome("reinstall-partial");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	const pkgRoot = child("prefix", "lib", "node_modules", "@iowarp", "clio-coder");
	run(launcher, ["doctor", "--fix"], { env });

	// An install interrupted after the entry landed and before the rest did.
	const distDir = assertInRoot(join(pkgRoot, "dist"), "partial dist");
	const chunk = readdirSync(distDir).find((name) => /^reset-.*\.js$/.test(name));
	const brokenBefore = { chunkRemoved: chunk ?? null };
	if (chunk) removeUnderRoot(join(distDir, chunk), "partial chunk");
	const broken = run(launcher, ["reset", "--dry-run"], { env });

	const repaired = installPackage(env);
	const afterRepair = run(launcher, ["reset", "--dry-run"], { env });
	return {
		command: `${broken.command}  (chunk ${chunk} removed)`,
		exitCode: broken.exitCode,
		stdout: `${broken.stdout}\n---\n${afterRepair.stdout}`,
		stderr: `${broken.stderr}\n---\n${repaired.stderr}`,
		notes: JSON.stringify(brokenBefore),
		checks: [
			["a code-split chunk exists to remove", chunk !== undefined],
			["the broken install fails rather than half-running", broken.exitCode === 1],
			["the failure says the installation is incomplete", /installation is incomplete/.test(broken.stderr)],
			["the failure names a reinstall command", /npm install -g @iowarp\/clio-coder/.test(broken.stderr)],
			["reinstall repairs it", repaired.exitCode === 0 && afterRepair.exitCode === 0],
		],
	};
});

testCase(12, "dry-run reset and dry-run uninstall", () => {
	const home = freshHome("dry-run");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });
	const before = snapshot(home);
	const resetDry = run(launcher, ["reset", "--all", "--dry-run"], { env });
	const uninstallDry = run(launcher, ["uninstall", "--dry-run"], { env });
	const after = snapshot(home);
	const unchanged = JSON.stringify(before.entries) === JSON.stringify(after.entries);
	return {
		command: `${resetDry.command} ; ${uninstallDry.command}`,
		exitCode: resetDry.exitCode,
		stdout: `${resetDry.stdout}\n---\n${uninstallDry.stdout}`,
		stderr: `${resetDry.stderr}${uninstallDry.stderr}`,
		before,
		after,
		checks: [
			["reset --dry-run exits 0", resetDry.exitCode === 0],
			["uninstall --dry-run exits 0", uninstallDry.exitCode === 0],
			["neither changes the filesystem", unchanged],
			["reset names resolved absolute paths", resetDry.stdout.includes(home)],
			["uninstall names resolved absolute paths", uninstallDry.stdout.includes(home)],
			["reset enumerates all four roots", ["config", "data", "state", "cache"].every((r) => resetDry.stdout.includes(r))],
		],
	};
});

testCase(13, "selective reset", () => {
	const home = freshHome("selective");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });
	const dataRoot = join(home, ".local", "share", "clio-coder");
	const stateRoot = join(home, ".local", "state", "clio-coder");
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(stateRoot, { recursive: true });
	writeFileSync(join(dataRoot, "durable.txt"), "durable product\n", "utf8");
	writeFileSync(join(stateRoot, "ephemeral.txt"), "session state\n", "utf8");
	const before = snapshot(home);
	const result = run(launcher, ["reset", "--state", "--force"], { env });
	const after = snapshot(home);
	return {
		...result,
		before,
		after,
		checks: [
			["exits 0", result.exitCode === 0],
			["the state file is gone", !existsSync(join(stateRoot, "ephemeral.txt"))],
			["the data file survives", existsSync(join(dataRoot, "durable.txt"))],
			["settings.yaml survives", existsSync(join(home, ".config", "clio-coder", "settings.yaml"))],
			["the state root is rebuilt", existsSync(stateRoot)],
		],
	};
});

testCase(14, "uninstall preserving the binary", () => {
	const home = freshHome("uninstall-keep-bin");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });
	const before = snapshot(home);
	const result = run(launcher, ["uninstall", "--force"], { env });
	const after = snapshot(home);
	const stillRuns = run(launcher, ["--version"], { env });
	return {
		...result,
		before,
		after,
		checks: [
			["exits 0", result.exitCode === 0],
			["the config root is gone", !existsSync(join(home, ".config", "clio-coder", "settings.yaml"))],
			["the launcher is untouched", existsSync(launcher)],
			["the launcher still runs", stillRuns.exitCode === 0],
		],
	};
});

testCase(15, "uninstall including an owned launcher symlink", () => {
	const home = freshHome("uninstall-with-bin");
	const binDir = child("bin-owned");
	mkdirSync(binDir, { recursive: true });
	const env = isolatedEnv(home, { CLIO_CODER_BIN_DIR: binDir });
	const launcher = LAUNCHER();
	const link = join(binDir, "clio-coder");
	symlinkSync(join(PREFIX(), "lib", "node_modules", "@iowarp", "clio-coder", "dist", "cli", "index.js"), link);
	run(launcher, ["doctor", "--fix"], { env });
	const before = snapshot(binDir);
	const result = run(launcher, ["uninstall", "--remove-binary", "--force"], { env });
	const after = snapshot(binDir);
	return {
		...result,
		before,
		after,
		checks: [
			["exits 0", result.exitCode === 0],
			["the owned link is removed", !existsSync(link) && !after.entries.some((e) => e.path === "clio-coder")],
			["the removal is reported", /clio/.test(result.stdout)],
			["the config root is gone", !existsSync(join(home, ".config", "clio-coder", "settings.yaml"))],
		],
	};
});

testCase(16, "refusal to delete an unowned real file or a link elsewhere", () => {
	const home = freshHome("unowned");
	const binDir = child("bin-unowned");
	mkdirSync(binDir, { recursive: true });
	const env = isolatedEnv(home, { CLIO_CODER_BIN_DIR: binDir });
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });

	// A real file called clio that Clio did not create.
	const realFile = join(binDir, "clio-coder");
	writeFileSync(realFile, "#!/bin/sh\necho not clio-coder\n", "utf8");
	chmodSync(realFile, 0o755);
	const keptFile = run(launcher, ["uninstall", "--remove-binary", "--force"], { env });
	const fileSurvived = existsSync(realFile) && readFileSync(realFile, "utf8").includes("not clio-coder");

	// A link into a different clio installation.
	removeUnderRoot(realFile, "unowned real file");
	const otherInstall = child("other-clio-coder", "dist", "cli");
	mkdirSync(otherInstall, { recursive: true });
	writeFileSync(join(otherInstall, "index.js"), "// a different clio-coder installation\n", "utf8");
	symlinkSync(join(otherInstall, "index.js"), realFile);
	run(launcher, ["doctor", "--fix"], { env });
	const keptLink = run(launcher, ["uninstall", "--remove-binary", "--force"], { env });
	const linkSurvived = existsSync(realFile);

	// A dangling link naming a clio entry is still Clio's to remove.
	removeUnderRoot(realFile, "foreign link");
	symlinkSync(child("gone", "dist", "cli", "index.js"), realFile);
	run(launcher, ["doctor", "--fix"], { env });
	const dangling = run(launcher, ["uninstall", "--remove-binary", "--force"], { env });
	const danglingRemoved = !lstatSyncSafe(realFile);

	return {
		command: "clio-coder uninstall --remove-binary --force against a real file, a foreign link, and a dangling link",
		exitCode: keptFile.exitCode,
		stdout: `${keptFile.stdout}\n---\n${keptLink.stdout}\n---\n${dangling.stdout}`,
		stderr: `${keptFile.stderr}\n---\n${keptLink.stderr}\n---\n${dangling.stderr}`,
		checks: [
			["a real file is preserved", fileSurvived],
			["preserving it is reported, not silent", /clio/.test(`${keptFile.stdout}${keptFile.stderr}`)],
			["a link into another installation is preserved", linkSurvived],
			["preserving that is reported too", /clio/.test(`${keptLink.stdout}${keptLink.stderr}`)],
			["a dangling clio-coder link is removed", danglingRemoved],
		],
	};
});

function lstatSyncSafe(path) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

testCase(17, "reinstall after uninstall", () => {
	const home = freshHome("reinstall-after");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });
	const removed = run(launcher, ["uninstall", "--force"], { env });
	const gone = !existsSync(join(home, ".config", "clio-coder", "settings.yaml"));
	const again = installPackage(env);
	const rebuilt = run(launcher, ["doctor", "--fix"], { env });
	const doctor = run(launcher, ["doctor"], { env });
	return {
		command: `${removed.command} ; npm install ; ${rebuilt.command}`,
		exitCode: doctor.exitCode,
		stdout: `${removed.stdout}\n---\n${doctor.stdout}`,
		stderr: `${removed.stderr}${again.stderr}`,
		after: snapshot(join(home, ".config", "clio-coder")),
		checks: [
			["uninstall exits 0", removed.exitCode === 0],
			["state is actually gone", gone],
			["reinstall succeeds", again.exitCode === 0],
			["the fresh install rebuilds its state", rebuilt.exitCode === 0],
			["doctor is clean", doctor.exitCode === 0],
		],
	};
});

testCase(18, "TUI task journeys at narrow, normal, and wide sizes", async () => {
	const { runInPty, visibleLines } = await import("../tests/harness/pty.ts");
	const launcher = LAUNCHER();
	const home = freshHome("tui-sizes");
	const env = isolatedEnv(home);
	run(
		launcher,
		[
			"configure",
			"--id",
			"declared",
			"--runtime",
			"openai-compat",
			"--url",
			"http://127.0.0.1:9",
			"--model",
			"declared-model",
			"--force",
			"--set-orchestrator",
		],
		{ env },
	);
	const checks = [];
	const transcripts = [];
	for (const [cols, rows] of [
		[40, 12],
		[80, 24],
		[160, 50],
	]) {
		const result = await runInPty(launcher, [], {
			cols,
			rows,
			cwd: ROOT,
			env,
			timeoutMs: 40_000,
			readyWhen: /idle/,
			input: [
				{ afterMs: 500, data: "/help\r" },
				{ afterMs: 1_500, data: String.fromCharCode(27) },
				{ afterMs: 2_200, data: String.fromCharCode(3) },
				{ afterMs: 2_350, data: String.fromCharCode(3) },
			],
		});
		const lines = visibleLines(result.output);
		const widest = Math.max(...lines.map((line) => line.length));
		transcripts.push(`--- ${cols}x${rows} exit=${result.exitCode} widest=${widest}\n${lines.join("\n")}`);
		checks.push([`${cols}x${rows} exits 0`, result.exitCode === 0]);
		checks.push([`${cols}x${rows} stays inside the frame`, widest <= cols]);
		checks.push([`${cols}x${rows} shows the banner`, lines.some((line) => line.includes("Clio Coder"))]);
		checks.push([`${cols}x${rows} opens /help`, /help|command/i.test(lines.join("\n"))]);
	}
	return {
		command: "clio-coder (pty) at 40x12, 80x24, 160x50 with /help and Escape",
		exitCode: 0,
		stdout: clip(transcripts.join("\n\n")),
		stderr: "",
		checks,
	};
});

testCase(19, "NO_COLOR, non-TTY, SIGINT, and terminal teardown", async () => {
	const { runInPty, colorSequences } = await import("../tests/harness/pty.ts");
	const launcher = LAUNCHER();
	const home = freshHome("teardown");
	const env = isolatedEnv(home);
	run(
		launcher,
		[
			"configure",
			"--id",
			"declared",
			"--runtime",
			"openai-compat",
			"--url",
			"http://127.0.0.1:9",
			"--model",
			"declared-model",
			"--force",
			"--set-orchestrator",
		],
		{ env },
	);

	const colored = await runInPty(launcher, [], {
		cols: 80,
		rows: 24,
		cwd: ROOT,
		env,
		timeoutMs: 40_000,
		readyWhen: /idle/,
		input: [
			{ afterMs: 500, data: String.fromCharCode(3) },
			{ afterMs: 650, data: String.fromCharCode(3) },
		],
	});
	const plain = await runInPty(launcher, [], {
		cols: 80,
		rows: 24,
		cwd: ROOT,
		env: { ...env, NO_COLOR: "1" },
		timeoutMs: 40_000,
		readyWhen: /idle/,
		input: [
			{ afterMs: 500, data: String.fromCharCode(3) },
			{ afterMs: 650, data: String.fromCharCode(3) },
		],
	});
	const nonTty = run(launcher, [], { env });
	const count = (text, needle) => text.split(needle).length - 1;

	return {
		command: "clio-coder (pty) with and without NO_COLOR, then piped",
		exitCode: colored.exitCode,
		stdout: clip(`non-tty:\n${nonTty.stdout}`),
		stderr: nonTty.stderr,
		checks: [
			["a double Ctrl-C exits 0", colored.exitCode === 0],
			["color is present by default", colorSequences(colored.output).length > 0],
			["NO_COLOR removes every color sequence", colorSequences(plain.output).length === 0],
			["NO_COLOR still exits 0", plain.exitCode === 0],
			["bracketed paste is disabled last", colored.output.trimEnd().endsWith("[?2004l")],
			["the cursor is restored", count(colored.output, "[?25h") > 0],
			["the keyboard protocol stack is popped", count(colored.output, "[>") === count(colored.output, "[<u")],
			["the alternate screen is never entered", count(colored.output, "[?1049h") === 0],
			["a piped launch exits 0 without a prompt", nonTty.exitCode === 0 && !nonTty.stdout.includes("Selection [")],
		],
	};
});

testCase(20, "docs and help commands executed exactly as written", () => {
	const home = freshHome("docs");
	const env = isolatedEnv(home);
	const launcher = LAUNCHER();
	run(launcher, ["doctor", "--fix"], { env });

	// Every fenced `clio-coder …` invocation in the README and the lifecycle doc that
	// is safe to execute: no network, no destructive flag, no placeholder.
	const sources = ["README.md", join("docs", "installation-and-lifecycle.md"), join("docs", "commands-and-modes.md")];
	const commands = new Set();
	for (const source of sources) {
		const text = readFileSync(join(REPO_ROOT, source), "utf8");
		for (const match of text.matchAll(/^\s*(?:\$\s*)?(clio-coder [^\n`|>&$]*)$/gm)) {
			const raw = (match[1] ?? "").trim().replace(/\s+#.*$/, "");
			if (raw.length === 0) continue;
			if (/[<>[\]{}]|\.\.\.|YOUR|PATH|\.\.\./.test(raw)) continue;
			if (/(reset|uninstall|upgrade|auth|login|run|configure|context|dispatch|eval)\b/.test(raw)) continue;
			commands.add(raw);
		}
	}
	const results = [];
	for (const command of [...commands].sort()) {
		const args = command.split(/\s+/).slice(1);
		if (args.length === 0) continue;
		const result = run(launcher, args, { env, timeoutMs: 60_000 });
		results.push({ command, exitCode: result.exitCode, stderr: clip(result.stderr).slice(0, 400) });
	}
	// A documented example may name a target the reader was told to create
	// first. That cannot exit 0 here, and requiring it to would only push the
	// docs toward examples with no arguments. What must hold is that the
	// command parses: it fails on missing user state, never on an unknown
	// command or an unknown flag.
	const parseFailure = /unknown (command|option|flag)|usage:/i;
	const failed = results.filter((entry) => entry.exitCode !== 0 && parseFailure.test(entry.stderr));
	const needingState = results.filter((entry) => entry.exitCode !== 0);
	const helpTopics = ["configure", "targets", "doctor", "reset", "uninstall", "trace", "models"].map((topic) => {
		const result = run(launcher, [topic, "--help"], { env });
		return {
			topic,
			exitCode: result.exitCode,
			// Some print a `usage:` line and some open with the invocation form.
			// Either is help; what matters is that it lands on stdout, names the
			// subcommand, and does not go out as an error.
			onStdout: result.stdout.includes(`clio-coder ${topic}`),
			quiet: result.stderr.trim().length === 0,
		};
	});
	return {
		command: `${results.length} documented commands from README and lifecycle docs`,
		exitCode: failed.length === 0 ? 0 : 1,
		stdout: clip(JSON.stringify({ results, needingState: needingState.length, helpTopics }, null, 1)),
		stderr: "",
		checks: [
			["documented commands were found to run", results.length > 0],
			[`every documented command parses (${failed.length} rejected)`, failed.length === 0],
			[
				`commands needing user state fail on that, not on syntax (${needingState.length})`,
				needingState.every((entry) => /no target with id|not configured|no such/i.test(entry.stderr)),
			],
			["every subcommand --help exits 0", helpTopics.every((entry) => entry.exitCode === 0)],
			["every subcommand --help writes to stdout", helpTopics.every((entry) => entry.onStdout)],
			["no subcommand --help writes to stderr", helpTopics.every((entry) => entry.quiet)],
		],
	};
});

/* ------------------------------------------------------------------- drive */

async function main() {
	process.stdout.write(`lifecycle matrix root: ${ROOT}\n\n`);
	const records = [];
	let failures = 0;

	for (const entry of cases) {
		// Cases 1 and 2 build the artifact and the prefix every other case uses.
		if (ONLY && !ONLY.has(entry.id) && entry.id !== "1" && entry.id !== "2") continue;
		const startedAt = Date.now();
		let record;
		try {
			const result = await entry.body();
			const checks = (result.checks ?? []).map(([name, passed]) => ({ name, passed: passed === true }));
			const failed = checks.filter((check) => !check.passed);
			record = {
				id: entry.id,
				title: entry.title,
				status: result.status ?? (failed.length === 0 ? "pass" : "fail"),
				durationMs: Date.now() - startedAt,
				...result,
				checks,
			};
			if (record.status === "fail") failures += 1;
		} catch (error) {
			failures += 1;
			record = {
				id: entry.id,
				title: entry.title,
				status: "error",
				durationMs: Date.now() - startedAt,
				error: String(error?.stack ?? error),
				checks: [],
			};
		}
		records.push(record);
		const glyph = record.status === "pass" ? "ok  " : record.status === "not-run" ? "skip" : "FAIL";
		const detail =
			record.status === "error"
				? ` ${String(record.error).split("\n")[0]}`
				: record.checks.length > 0
					? ` (${record.checks.filter((c) => c.passed).length}/${record.checks.length} checks)`
					: "";
		process.stdout.write(`${glyph} ${entry.id.padStart(2)}. ${entry.title}${detail}\n`);
		for (const check of record.checks.filter((c) => !c.passed)) {
			process.stdout.write(`       failed: ${check.name}\n`);
		}
	}

	const reportDir = child("report");
	mkdirSync(reportDir, { recursive: true });
	writeFileSync(join(reportDir, "matrix.json"), `${JSON.stringify({ root: ROOT, records }, null, 2)}\n`, "utf8");
	writeFileSync(join(reportDir, "matrix.md"), renderMarkdown(records), "utf8");

	// The report is the artifact, so it is copied out before the root goes.
	const kept = join(tmpdir(), `clio-lifecycle-report-${process.pid}`);
	mkdirSync(kept, { recursive: true });
	cpSync(reportDir, kept, { recursive: true });

	process.stdout.write(`\nreport: ${kept}/matrix.md\n`);
	if (KEEP) {
		process.stdout.write(`kept root: ${ROOT}\n`);
	} else {
		removeUnderRoot(ROOT, "temporary root");
	}
	process.exit(failures === 0 ? 0 : 1);
}

function renderMarkdown(records) {
	const lines = ["# Lifecycle matrix", "", `Root: \`${ROOT}\``, ""];
	lines.push("| # | Case | Status | Checks |", "| --- | --- | --- | --- |");
	for (const record of records) {
		const passed = record.checks.filter((check) => check.passed).length;
		lines.push(`| ${record.id} | ${record.title} | ${record.status} | ${passed}/${record.checks.length} |`);
	}
	lines.push("");
	for (const record of records) {
		lines.push(`## ${record.id}. ${record.title}`, "");
		lines.push(`- status: **${record.status}**`);
		if (record.command) lines.push(`- command: \`${record.command}\``);
		if (record.exitCode !== undefined) lines.push(`- exit: \`${record.exitCode}\``);
		if (record.notes) lines.push(`- notes: ${record.notes}`);
		if (record.before)
			lines.push(`- filesystem before: ${record.before.entries.length} entries under \`${record.before.root}\``);
		if (record.after)
			lines.push(`- filesystem after: ${record.after.entries.length} entries under \`${record.after.root}\``);
		if (record.before && record.after) {
			const removed = [...paths(record.before)].filter((path) => !paths(record.after).has(path));
			const added = [...paths(record.after)].filter((path) => !paths(record.before).has(path));
			if (removed.length > 0)
				lines.push(`- removed: ${removed.slice(0, 12).join(", ")}${removed.length > 12 ? " …" : ""}`);
			if (added.length > 0) lines.push(`- added: ${added.slice(0, 12).join(", ")}${added.length > 12 ? " …" : ""}`);
		}
		lines.push("");
		for (const check of record.checks) lines.push(`  - ${check.passed ? "pass" : "FAIL"}: ${check.name}`);
		if (record.error) lines.push("", "```", record.error, "```");
		if (record.stdout) lines.push("", "stdout:", "", "```", record.stdout, "```");
		if (record.stderr) lines.push("", "stderr:", "", "```", record.stderr, "```");
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

process.on("uncaughtException", (error) => {
	process.stderr.write(`${String(error?.stack ?? error)}\n`);
	if (!KEEP) {
		try {
			removeUnderRoot(ROOT, "temporary root");
		} catch {
			// The root is under /tmp; leaving it is safe.
		}
	}
	process.exit(1);
});

await main();
