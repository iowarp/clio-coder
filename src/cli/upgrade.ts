import { spawn } from "node:child_process";
import { initializeClioHome } from "../core/init.js";
import { clioStateDir } from "../core/xdg.js";
import { detectInstallMethod } from "../domains/lifecycle/install-method.js";
import { listMigrations, readMigrationManifest, runPending } from "../domains/lifecycle/migrations/index.js";
import { readStateInfo } from "../domains/lifecycle/state.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { createLifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { printError } from "./shared.js";

const CHANNELS = ["latest", "beta", "dev"] as const;
type Channel = (typeof CHANNELS)[number];

const HELP = `clio-coder upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations] [--json]

Upgrade Clio Coder and apply pending state migrations. An npm-installed
binary is reinstalled via npm; a source-checkout install instead prints
the git-based update steps and never touches the global npm prefix.

Flags:
  --dry-run             print planned actions without changing anything
  --channel=<chan>      npm dist-tag to install (latest|beta|dev). npm installs only.
  --skip-migrations     skip migrations after the install step
  --json                emit machine-readable JSON output
  --help, -h            show this message
`;

const SOURCE_UPGRADE_STEPS = ["git pull", "npm run install:local", "hash -r"] as const;
/** One wording for the source-update advice. Three paths print it; they used to disagree. */
const SOURCE_UPGRADE_LEAD = "To update the checkout itself, run:";

interface UpgradeOptions {
	dryRun: boolean;
	channel: Channel;
	skipMigrations: boolean;
	help: boolean;
	postInstall: boolean;
	json: boolean;
}

/**
 * Positional scan, not `argv.indexOf`. The previous parser looked each token up
 * by value to find its neighbour, so the second `--channel` in a repeated pair
 * read the first one's value, and a value that happened to equal an earlier
 * token was consumed at the wrong index.
 */
function parseUpgradeArgs(argv: ReadonlyArray<string>): UpgradeOptions {
	let dryRun = false;
	let channel: Channel = "latest";
	let skipMigrations = false;
	let help = false;
	let postInstall = false;
	let json = false;

	const toChannel = (value: string | undefined): Channel => {
		if (value === undefined || !(CHANNELS as ReadonlyArray<string>).includes(value)) {
			throw new Error(`--channel must be one of ${CHANNELS.join("|")}, got '${value ?? ""}'`);
		}
		return value as Channel;
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined || arg === "upgrade") continue;
		if (arg === "--help" || arg === "-h") help = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--skip-migrations") skipMigrations = true;
		else if (arg === "--post-install") postInstall = true;
		else if (arg === "--json") json = true;
		else if (arg.startsWith("--channel=")) channel = toChannel(arg.slice("--channel=".length));
		else if (arg === "--channel") {
			channel = toChannel(argv[i + 1]);
			i += 1;
		} else throw new Error(`unknown upgrade argument: ${arg}`);
	}
	return { dryRun, channel, skipMigrations, help, postInstall, json };
}

/**
 * What the registry said, and whether it was asked at all.
 *
 * "Not asked" and "asked and could not answer" are different facts, and
 * collapsing both into `null` is what let an offline npm install report itself
 * already current: an unanswered lookup compared nothing, so it cannot conclude
 * the installed version is the newest one.
 */
type RegistryLookup =
	| { asked: false; reason: "source checkout" | "network checks are disabled" }
	| { asked: true; version: string | null };

async function lookUpAvailableVersion(
	channel: Channel,
	method: "source" | "npm",
	noNetwork: boolean,
): Promise<RegistryLookup> {
	const seam = process.env.CLIO_CODER_TEST_UPGRADE_AVAILABLE;
	// `unreachable` stands in for a registry that answered nothing, which is the
	// only way to reach that branch without a network in the test.
	if (seam) return { asked: true, version: seam === "unreachable" ? null : seam };
	if (noNetwork) return { asked: false, reason: "network checks are disabled" };
	if (method === "source") return { asked: false, reason: "source checkout" };
	try {
		const res = await fetch(`https://registry.npmjs.org/@iowarp/clio-coder/${channel}`, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return { asked: true, version: null };
		const data = (await res.json()) as { version?: unknown };
		return { asked: true, version: typeof data.version === "string" ? data.version : null };
	} catch {
		return { asked: true, version: null };
	}
}

/**
 * Run one child to completion, keeping its last output for the failure message.
 *
 * The pipes have to be drained. `npm install -g` writes well past a 64 KB pipe
 * buffer, and a child whose stdout nobody reads blocks on the write and never
 * exits, so the upgrade hung with no output and no way to tell it apart from a
 * slow registry. Draining also gives the failure something to say beyond an
 * exit code.
 */
async function runChild(command: string, args: ReadonlyArray<string>, label: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		let tail = "";
		const keepTail = (chunk: Buffer): void => {
			tail = `${tail}${chunk.toString("utf8")}`.slice(-2000);
		};
		child.stdout?.on("data", keepTail);
		child.stderr?.on("data", keepTail);
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			const lastLine = tail.trimEnd().split("\n").at(-1) ?? "";
			reject(new Error(`${label} exited with code ${code ?? -1}${lastLine ? `: ${lastLine}` : ""}`));
		});
	});
}

async function runNpmInstall(channel: Channel): Promise<void> {
	if (process.env.CLIO_CODER_TEST_UPGRADE_FAIL === "npm") {
		throw new Error("npm ERR! 404 Not Found (mock failure)");
	}
	await runChild("npm", ["install", "-g", `@iowarp/clio-coder@${channel}`], "npm install");
}

async function runDoctorFixAfterInstall(): Promise<void> {
	if (process.env.CLIO_CODER_TEST_UPGRADE_FAIL === "doctor") {
		throw new Error("mock doctor fix failure");
	}
	await runChild("clio-coder", ["doctor", "--fix"], "clio-coder doctor --fix");
}

async function runPostInstallUpgrade(opts: UpgradeOptions): Promise<void> {
	const args = ["upgrade", "--post-install", `--channel=${opts.channel}`];
	if (opts.skipMigrations) args.push("--skip-migrations");
	await runChild("clio-coder", args, "clio-coder upgrade --post-install");
}

export async function runUpgradeCommand(argv: ReadonlyArray<string>): Promise<number> {
	let opts: UpgradeOptions;
	try {
		opts = parseUpgradeArgs(argv);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 2;
	}
	if (opts.help) {
		process.stdout.write(HELP);
		return 0;
	}

	const presenter = createLifecyclePresenter({ json: opts.json });
	presenter.header("Upgrade", "upgrade");

	const before = getVersionInfo().clio;
	const stateDir = clioStateDir();
	const method = detectInstallMethod();
	const methodLabel = method === "source" ? "source checkout" : "npm global";
	presenter.setMethod(methodLabel);

	const noNetwork = Boolean(process.env.CLIO_CODER_TEST_UPGRADE_NO_NETWORK);
	const lookup = await lookUpAvailableVersion(opts.channel, method, noNetwork);
	const availableVersion = lookup.asked ? lookup.version : null;

	presenter.step(`Installation method: ${methodLabel}`);
	presenter.step(`Current version: ${before}`);
	// A source checkout is not upgraded from the registry, so the registry is
	// never asked. Reporting that as "registry check failed" told the operator a
	// lookup had gone wrong when none was owed.
	if (availableVersion !== null) presenter.step(`Available version: ${availableVersion}`);
	else if (!lookup.asked) presenter.step(`Available version: not checked (${lookup.reason})`);
	else presenter.step("Available version: unknown (the registry could not be reached)");
	if (method === "npm") presenter.step(`Channel: ${opts.channel}`);
	presenter.step(`State dir: ${shortenPath(stateDir)}`);

	const migrations = listMigrations();
	const migrationIds = migrations.map((m) => m.id);
	const appliedIds = new Set(readMigrationManifest(stateDir).applied);
	const pendingMigrationIds = opts.skipMigrations ? [] : migrationIds.filter((id) => !appliedIds.has(id));

	const recorded = readStateInfo()?.version ?? null;
	const describeRefresh = (): string =>
		recorded === null
			? "state metadata (none recorded)"
			: recorded === before
				? `state metadata (already ${before})`
				: `state metadata ${recorded} -> ${before}`;

	// "Already current" is a claim about a version that was compared. A lookup
	// that was made and came back empty has compared nothing, so it does not get
	// to make it: the run falls through and attempts the install, which is what
	// the operator asked for. A lookup that was never owed (a checkout, or the
	// network seam) leaves the recorded state version to decide.
	const versionIsCurrent =
		(lookup.asked ? lookup.version === before : true) && (recorded === null || recorded === before);
	const hasPendingMigrations = pendingMigrationIds.length > 0;

	if (versionIsCurrent && !hasPendingMigrations) {
		presenter.warn(`Already on ${before}, with no pending migrations. Nothing to do.`);
		if (method === "source") presenter.commandAdvice(SOURCE_UPGRADE_LEAD, SOURCE_UPGRADE_STEPS.join("\n"));
		if (opts.dryRun) presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		return 0;
	}

	if (opts.dryRun) {
		if (method === "source") presenter.commandAdvice(SOURCE_UPGRADE_LEAD, SOURCE_UPGRADE_STEPS.join("\n"));
		else presenter.note(`Would run: npm install -g @iowarp/clio-coder@${opts.channel}`);
		if (opts.skipMigrations) presenter.note("Would skip migrations (--skip-migrations).");
		else if (pendingMigrationIds.length === 0) presenter.note("No pending migrations.");
		else {
			presenter.note(
				`Would apply ${pendingMigrationIds.length} pending migration${pendingMigrationIds.length === 1 ? "" : "s"}:`,
			);
			// As substeps, so a --json consumer sees the plan instead of only the
			// three detected facts the old dry run recorded.
			for (const id of pendingMigrationIds) presenter.substep(id, "–");
		}
		presenter.note(`Would refresh ${describeRefresh()}.`);
		presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		return 0;
	}

	if (opts.postInstall) {
		presenter.note("Running post-install checks with the active clio-coder binary.");
	} else if (method === "source") {
		presenter.note("Source checkout: no npm install to run.");
	} else if (noNetwork) {
		presenter.note("CLIO_CODER_TEST_UPGRADE_NO_NETWORK is set; skipping npm install.");
	} else {
		try {
			await runNpmInstall(opts.channel);
			presenter.completedStep(`Installed @iowarp/clio-coder@${opts.channel}`);
		} catch (err) {
			presenter.fail("npm install failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice(
				"To upgrade by hand, run:",
				`npm install -g @iowarp/clio-coder@${opts.channel}\nclio-coder doctor --fix`,
			);
			presenter.finish();
			return 1;
		}
		try {
			await runPostInstallUpgrade(opts);
			presenter.done("Done");
			return 0;
		} catch (err) {
			presenter.fail("post-install checks failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To finish the upgrade by hand, run:", "clio-coder doctor --fix");
			presenter.finish();
			return 1;
		}
	}

	let appliedCount = 0;
	if (opts.skipMigrations) {
		presenter.note("Skipping migrations (--skip-migrations).");
	} else {
		let result: Awaited<ReturnType<typeof runPending>>;
		try {
			if (process.env.CLIO_CODER_TEST_UPGRADE_FAIL === "migration") {
				throw new Error("mock migration failure in 2026-09-01-settings-v2");
			}
			result = await runPending(stateDir);
		} catch (err) {
			presenter.fail("migration failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice(
				"The rest of the upgrade does not depend on it. To continue, run:",
				"clio-coder upgrade --skip-migrations",
			);
			presenter.finish();
			return 1;
		}
		const applied = [...result.applied];
		appliedCount = applied.length;
		if (appliedCount === 0) presenter.note("No pending migrations.");
		else for (const id of applied) presenter.completedStep(`Applied migration ${id}`);
	}

	if (method === "source" || noNetwork) {
		const refresh = describeRefresh();
		initializeClioHome();
		presenter.completedStep(`Refreshed ${refresh}`);
	} else {
		try {
			await runDoctorFixAfterInstall();
			presenter.completedStep("Checked the install with clio-coder doctor --fix");
		} catch (err) {
			presenter.fail("doctor fix failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To resolve the findings by hand, run:", "clio-coder doctor --fix");
			presenter.finish();
			return 1;
		}
	}

	if (method === "source") presenter.commandAdvice(SOURCE_UPGRADE_LEAD, SOURCE_UPGRADE_STEPS.join("\n"));

	const after = getVersionInfo().clio;
	// One closing word on every path, with the outcome above it as steps. The
	// summary used to carry the version arrow, so three exits printed three
	// different shapes of last line.
	if (appliedCount > 0 || (recorded ?? before) !== after) {
		presenter.note(
			`Now on ${after}${appliedCount > 0 ? `, ${appliedCount} migration${appliedCount === 1 ? "" : "s"} applied` : ""}.`,
		);
	}
	presenter.done("Done");
	return 0;
}
