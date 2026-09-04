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

interface UpgradeOptions {
	dryRun: boolean;
	channel: Channel;
	skipMigrations: boolean;
	help: boolean;
	postInstall: boolean;
	json: boolean;
}

function parseUpgradeArgs(argv: ReadonlyArray<string>): UpgradeOptions {
	let dryRun = false;
	let channel: Channel = "latest";
	let skipMigrations = false;
	let help = false;
	let postInstall = false;
	let json = false;
	for (const arg of argv) {
		if (arg === "upgrade") continue;
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--skip-migrations") {
			skipMigrations = true;
			continue;
		}
		if (arg === "--post-install") {
			postInstall = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg.startsWith("--channel=")) {
			const value = arg.slice("--channel=".length);
			if (!(CHANNELS as ReadonlyArray<string>).includes(value)) {
				throw new Error(`--channel must be one of ${CHANNELS.join("|")}, got '${value}'`);
			}
			channel = value as Channel;
			continue;
		}
		if (arg === "--channel") {
			const nextIdx = argv.indexOf(arg) + 1;
			const value = argv[nextIdx];
			if (!value || !(CHANNELS as ReadonlyArray<string>).includes(value)) {
				throw new Error(`--channel must be one of ${CHANNELS.join("|")}, got '${value ?? ""}'`);
			}
			channel = value as Channel;
			continue;
		}
		// If previous arg was --channel, skip this value
		const prevIdx = argv.indexOf(arg) - 1;
		if (prevIdx >= 0 && argv[prevIdx] === "--channel") {
			continue;
		}
		throw new Error(`unknown upgrade argument: ${arg}`);
	}
	return { dryRun, channel, skipMigrations, help, postInstall, json };
}

async function fetchAvailableVersion(channel: Channel, noNetwork: boolean): Promise<string | null> {
	if (process.env.CLIO_CODER_TEST_UPGRADE_AVAILABLE) {
		return process.env.CLIO_CODER_TEST_UPGRADE_AVAILABLE;
	}
	if (noNetwork) return null;
	try {
		const res = await fetch(`https://registry.npmjs.org/@iowarp/clio-coder/${channel}`, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: unknown };
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
	}
}

async function runNpmInstall(channel: Channel): Promise<void> {
	if (process.env.CLIO_CODER_TEST_UPGRADE_FAIL === "npm") {
		throw new Error("npm ERR! 404 Not Found - mock failure");
	}
	const args = ["install", "-g", `@iowarp/clio-coder@${channel}`];
	await new Promise<void>((resolve, reject) => {
		const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`npm exited with code ${code ?? -1}`));
		});
	});
}

async function runDoctorFixAfterInstall(): Promise<void> {
	if (process.env.CLIO_CODER_TEST_UPGRADE_FAIL === "doctor") {
		throw new Error("mock doctor fix failure");
	}
	const args = ["doctor", "--fix"];
	await new Promise<void>((resolve, reject) => {
		const child = spawn("clio-coder", args, { stdio: ["ignore", "pipe", "pipe"] });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`clio-coder doctor --fix exited with code ${code ?? -1}`));
		});
	});
}

async function runPostInstallUpgrade(opts: UpgradeOptions): Promise<void> {
	const args = ["upgrade", "--post-install", `--channel=${opts.channel}`];
	if (opts.skipMigrations) args.push("--skip-migrations");
	await new Promise<void>((resolve, reject) => {
		const child = spawn("clio-coder", args, { stdio: ["ignore", "pipe", "pipe"] });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`clio-coder upgrade --post-install exited with code ${code ?? -1}`));
		});
	});
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
	const availableVersion = await fetchAvailableVersion(opts.channel, noNetwork || method === "source");

	presenter.step(`Installation method: ${methodLabel}`);
	presenter.step(`Current version: ${before}`);
	if (availableVersion !== null) {
		presenter.step(`Available version: ${availableVersion}`);
	} else if (noNetwork) {
		presenter.step("Available version: (network check skipped)");
	} else {
		presenter.step("Available version: unknown (registry check failed)");
	}

	if (method === "npm") {
		presenter.rail(`Channel: ${opts.channel}`);
	}
	presenter.rail(`State dir: ${shortenPath(stateDir)}`);
	presenter.rail();

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

	const isAlreadyCurrentVersion =
		(availableVersion === null || availableVersion === before) && (recorded === null || recorded === before);
	const hasPendingMigrations = pendingMigrationIds.length > 0;

	// Already current path
	if (isAlreadyCurrentVersion && !hasPendingMigrations) {
		presenter.warn(`clio-coder upgrade skipped: ${before} is already installed (no pending migrations)`);
		if (method === "source") {
			presenter.commandAdvice("To update source code, run:", SOURCE_UPGRADE_STEPS.join("\n"));
		}
		if (opts.dryRun) {
			presenter.warn("Dry run - no changes made");
		}
		presenter.done("Done");
		return 0;
	}

	if (opts.dryRun) {
		if (method === "source") {
			presenter.commandAdvice("Source checkout install: update the code with:", SOURCE_UPGRADE_STEPS.join("\n"));
		} else {
			presenter.rail(`would run: npm install -g @iowarp/clio-coder@${opts.channel}`);
		}
		if (opts.skipMigrations) {
			presenter.rail("would skip migrations (--skip-migrations)");
		} else if (pendingMigrationIds.length === 0) {
			presenter.rail("no pending migrations; the manifest would be written as is");
		} else {
			presenter.rail(`would consider ${pendingMigrationIds.length} migration(s):`);
			for (const id of pendingMigrationIds) presenter.rail(`  - ${id}`);
		}
		presenter.rail(`would refresh ${describeRefresh()}`);
		presenter.warn("Dry run - no changes made");
		presenter.done("upgrade preview complete");
		return 0;
	}

	if (opts.postInstall) {
		presenter.rail("running post-install checks with the active clio binary");
	} else if (method === "source") {
		presenter.rail("source checkout install detected; skipping npm install");
	} else if (noNetwork) {
		presenter.rail("CLIO_CODER_TEST_UPGRADE_NO_NETWORK set, skipping npm install");
	} else {
		try {
			await runNpmInstall(opts.channel);
			presenter.completedStep(`Installed @iowarp/clio-coder@${opts.channel}`);
		} catch (err) {
			presenter.fail("npm install failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice(
				"To upgrade manually, run:",
				`npm install -g @iowarp/clio-coder@${opts.channel}\nclio-coder doctor --fix`,
			);
			return 1;
		}
		try {
			await runPostInstallUpgrade(opts);
			presenter.done(`${before} -> post-install checks complete`);
			return 0;
		} catch (err) {
			presenter.fail("post-install checks failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To complete upgrade manually, run:", "clio-coder doctor --fix");
			return 1;
		}
	}

	let appliedCount = 0;
	if (opts.skipMigrations) {
		presenter.rail("skipping migrations (--skip-migrations)");
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
			return 1;
		}
		const applied = [...result.applied];
		appliedCount = applied.length;
		if (appliedCount === 0) {
			presenter.rail("no pending migrations");
		} else {
			for (const id of applied) {
				presenter.completedStep(`applied migration ${id}`);
			}
		}
	}

	if (method === "source" || noNetwork) {
		const refresh = describeRefresh();
		initializeClioHome();
		presenter.completedStep(`refreshed ${refresh}`);
	} else {
		try {
			await runDoctorFixAfterInstall();
		} catch (err) {
			presenter.fail("doctor fix failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To resolve issues manually, run:", "clio-coder doctor --fix");
			return 1;
		}
	}

	if (method === "source") {
		presenter.commandAdvice("To update source checkout code, run:", SOURCE_UPGRADE_STEPS.join("\n"));
	}

	const after = getVersionInfo().clio;
	presenter.done(`${recorded ?? before} -> ${after} (migrations: ${appliedCount})`);
	return 0;
}
