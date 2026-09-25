import { spawn } from "node:child_process";
import { initializeClioHome } from "../core/init.js";
import { resolveClioDirs } from "../core/xdg.js";
import {
	type Installation,
	inspectInstallation,
	installationCommand,
	npmInstallArgs,
} from "../domains/lifecycle/install-method.js";
import { listMigrations, readMigrationManifest, runPending } from "../domains/lifecycle/migrations/index.js";
import { compareReleaseVersions, fetchReleaseVersion } from "../domains/lifecycle/release-version.js";
import { readStateInfo } from "../domains/lifecycle/state.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { createLifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { printError } from "./shared.js";

const CHANNELS = ["latest", "beta", "dev"] as const;
type Channel = (typeof CHANNELS)[number];

const HELP = `clio-coder upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations] [--restart] [--json]

Upgrade Clio Coder and apply pending state migrations. An npm-installed
binary is updated in its existing prefix. Other package managers and source
checkouts receive update instructions for their installation method.

Flags:
  --dry-run             print planned actions without changing anything
  --channel=<chan>      npm dist-tag to install (latest|beta|dev). npm installs only.
  --skip-migrations     skip migrations after the install step
  --post-install        apply local checks after a package-manager update; skip reinstall
  --restart             after success, launch the installed CLI in this project; type /resume there
                        to pick up the last session
  --json                emit machine-readable JSON output
  --help, -h            show this message
`;

/** One wording for the source-update advice. Three paths print it; they used to disagree. */
const SOURCE_UPGRADE_LEAD = "To update the checkout itself (choose a release tag after fetching):";

/**
 * Sessions are resumed from inside the app (#191): the startup parser refuses
 * `--continue`, so every hint names the picker and the relaunch is bare.
 */
const RESUME_HINT = "start clio-coder in this project and type /resume";
const RELAUNCH_PREVIEW =
	"Would relaunch the installed CLI in this project after success; type /resume there to pick up the last session.";

interface UpgradeOptions {
	dryRun: boolean;
	channel: Channel;
	skipMigrations: boolean;
	help: boolean;
	postInstall: boolean;
	json: boolean;
	restart: boolean;
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
	let restart = false;

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
		else if (arg === "--restart") restart = true;
		else if (arg.startsWith("--channel=")) channel = toChannel(arg.slice("--channel=".length));
		else if (arg === "--channel") {
			channel = toChannel(argv[i + 1]);
			i += 1;
		} else throw new Error(`unknown upgrade argument: ${arg}`);
	}
	if (!help && restart && (json || postInstall))
		throw new Error("--restart cannot be combined with --json or --post-install");
	return { dryRun, channel, skipMigrations, help, postInstall, json, restart };
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
	| { asked: false; reason: "source checkout" | "post-install checks" }
	| { asked: true; version: string | null };

async function lookUpAvailableVersion(channel: Channel, method: Installation["kind"]): Promise<RegistryLookup> {
	if (method === "source") return { asked: false, reason: "source checkout" };
	return { asked: true, version: await fetchReleaseVersion(channel) };
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

async function runNpmInstall(channel: Channel, installation: Installation): Promise<void> {
	await runChild("npm", npmInstallArgs(installation, channel), "npm install");
}

async function runDoctorFixAfterInstall(installation: Installation): Promise<void> {
	await runChild(process.execPath, [installation.entry, "doctor", "--fix"], "clio-coder doctor --fix");
}

async function runPostInstallUpgrade(opts: UpgradeOptions, installation: Installation): Promise<void> {
	const args = [installation.entry, "upgrade", "--post-install", `--channel=${opts.channel}`];
	if (opts.skipMigrations) args.push("--skip-migrations");
	await runChild(process.execPath, args, "clio-coder upgrade --post-install");
}

async function runRestart(installation: Installation): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [installation.entry], { stdio: "inherit" });
		// Both share the foreground process group. Let the new CLI own Ctrl+C.
		const interrupt = () => {};
		const terminate = () => {
			child.kill("SIGTERM");
		};
		const cleanup = () => {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code, signal) => {
			cleanup();
			resolve(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	});
}

export interface UpgradeDependencies {
	inspectInstallation: typeof inspectInstallation;
	lookUpAvailableVersion: typeof lookUpAvailableVersion;
	runNpmInstall: typeof runNpmInstall;
	runDoctorFixAfterInstall: typeof runDoctorFixAfterInstall;
	runPostInstallUpgrade: typeof runPostInstallUpgrade;
	runPending: typeof runPending;
	runRestart: typeof runRestart;
	isInteractive: () => boolean;
}

const DEFAULT_DEPENDENCIES: UpgradeDependencies = {
	inspectInstallation,
	lookUpAvailableVersion,
	runNpmInstall,
	runDoctorFixAfterInstall,
	runPostInstallUpgrade,
	runPending,
	runRestart,
	isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

export async function runUpgradeCommand(
	argv: ReadonlyArray<string>,
	dependencies: Partial<UpgradeDependencies> = {},
): Promise<number> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
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
	if (opts.restart && !opts.dryRun && !deps.isInteractive()) {
		printError(`--restart requires an interactive terminal; after upgrading, ${RESUME_HINT}`);
		return 2;
	}

	const presenter = createLifecyclePresenter({ json: opts.json });
	presenter.header("Upgrade", "upgrade");

	const before = getVersionInfo().clio;
	const stateDir = resolveClioDirs().state;
	const installation = deps.inspectInstallation();
	const method = installation.kind;
	const methodLabel =
		method === "source"
			? "source checkout"
			: opts.postInstall
				? "package install"
				: method === "npm"
					? "npm global"
					: method;
	const updateCommand = installationCommand(installation, "upgrade", opts.channel);
	const sourceAdvice = () => presenter.commandAdvice(SOURCE_UPGRADE_LEAD, updateCommand);
	const finish = async (): Promise<number> => {
		presenter.done("Done");
		if (!opts.restart || opts.dryRun) return 0;
		try {
			return await deps.runRestart(installation);
		} catch (error) {
			printError(
				`Upgrade complete, but relaunch failed: ${error instanceof Error ? error.message : String(error)}. To continue, ${RESUME_HINT}.`,
			);
			return 1;
		}
	};
	presenter.setMethod(methodLabel);
	if (!opts.postInstall && method !== "npm" && method !== "source") {
		presenter.note(`Installation method: ${methodLabel}`);
		presenter.note(`Package: ${installation.root}`);
		presenter.commandAdvice("Update with the original package manager and its original global directory:", updateCommand);
		presenter.commandAdvice(
			"Then apply migrations, start clio-coder, and type /resume to pick up the last session:",
			"clio-coder upgrade --post-install\nclio-coder",
		);
		if (opts.dryRun) presenter.warn("Dry run: no changes made");
		else presenter.fail("This installation needs a package-manager update; no package was replaced.");
		presenter.finish();
		return opts.dryRun ? 0 : 1;
	}

	const lookup: RegistryLookup = opts.postInstall
		? { asked: false, reason: "post-install checks" }
		: await deps.lookUpAvailableVersion(opts.channel, method);
	const availableVersion = lookup.asked ? lookup.version : null;

	presenter.step(`Installation method: ${methodLabel}`);
	presenter.step(`Current version: ${before}`);
	if (installation.prefix) presenter.step(`Install prefix: ${installation.prefix}`);
	// A source checkout is not upgraded from the registry, so the registry is
	// never asked. Reporting that as "registry check failed" told the operator a
	// lookup had gone wrong when none was owed.
	if (availableVersion !== null) presenter.step(`Available version: ${availableVersion}`);
	else if (!lookup.asked) presenter.step(`Available version: not checked (${lookup.reason})`);
	else presenter.step("Available version: unknown (the registry could not be reached)");
	if (method === "npm" && !opts.postInstall) presenter.step(`Channel: ${opts.channel}`);
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
	// the operator asked for. A lookup that was never owed for a checkout or
	// post-install checks leaves the recorded state version to decide.
	const comparison = availableVersion === null ? null : compareReleaseVersions(availableVersion, before);
	const versionIsCurrent = (lookup.asked ? comparison !== null && comparison <= 0 : true) && recorded === before;
	const hasPendingMigrations = pendingMigrationIds.length > 0;
	if (comparison !== null && comparison < 0)
		presenter.note(`Installed ${before} is newer than ${opts.channel} (${availableVersion}); keeping it.`);

	if (!opts.postInstall && versionIsCurrent && !hasPendingMigrations) {
		presenter.warn(`Already on ${before}, with no pending migrations. Nothing to do.`);
		if (method === "source") sourceAdvice();
		if (opts.dryRun && opts.restart) presenter.note(RELAUNCH_PREVIEW);
		if (opts.dryRun) presenter.warn("Dry run: no changes made");
		return finish();
	}

	if (opts.dryRun) {
		if (method === "source" && !opts.postInstall) sourceAdvice();
		else if (!opts.postInstall && (comparison === null || comparison > 0)) presenter.note(`Would run: ${updateCommand}`);
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
		if (opts.restart) presenter.note(RELAUNCH_PREVIEW);
		presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		return 0;
	}

	if (opts.postInstall) {
		presenter.note("Running post-install checks with the active clio-coder binary.");
	} else if (method === "source") {
		presenter.note("Source checkout: no npm install to run.");
	} else if (comparison === null || comparison > 0) {
		try {
			presenter.note(`Installing with: ${updateCommand}`);
			await deps.runNpmInstall(opts.channel, installation);
			presenter.completedStep(`Installed @iowarp/clio-coder@${opts.channel}`);
		} catch (err) {
			presenter.fail("npm install failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To upgrade by hand, run:", `${updateCommand}\nclio-coder upgrade --post-install`);
			presenter.finish();
			return 1;
		}
		try {
			await deps.runPostInstallUpgrade(opts, installation);
			return finish();
		} catch (err) {
			presenter.fail("post-install checks failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To finish the upgrade by hand, run:", "clio-coder upgrade --post-install");
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
			result = await deps.runPending(stateDir);
		} catch (err) {
			presenter.fail("migration failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice(
				"Resolve the migration error and retry. To explicitly defer migrations, run:",
				"clio-coder upgrade --post-install --skip-migrations",
			);
			presenter.finish();
			return 1;
		}
		const applied = [...result.applied];
		appliedCount = applied.length;
		if (appliedCount === 0) presenter.note("No pending migrations.");
		else for (const id of applied) presenter.completedStep(`Applied migration ${id}`);
	}

	if (method === "source") {
		const refresh = describeRefresh();
		initializeClioHome();
		presenter.completedStep(`Refreshed ${refresh}`);
	} else {
		try {
			await deps.runDoctorFixAfterInstall(installation);
			presenter.completedStep("Checked the install with clio-coder doctor --fix");
		} catch (err) {
			presenter.fail("doctor fix failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To resolve the findings by hand, run:", "clio-coder doctor --fix");
			presenter.finish();
			return 1;
		}
	}

	if (method === "source" && !opts.postInstall) sourceAdvice();

	const after = getVersionInfo().clio;
	// One closing word on every path, with the outcome above it as steps. The
	// summary used to carry the version arrow, so three exits printed three
	// different shapes of last line.
	if (appliedCount > 0 || (recorded ?? before) !== after) {
		presenter.note(
			`Now on ${after}${appliedCount > 0 ? `, ${appliedCount} migration${appliedCount === 1 ? "" : "s"} applied` : ""}.`,
		);
	}
	return finish();
}
