import { spawn } from "node:child_process";
import { loadDomains } from "../core/domain-loader.js";
import { initializeClioHome } from "../core/init.js";
import { clioStateDir } from "../core/xdg.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { LifecycleContract } from "../domains/lifecycle/contract.js";
import { LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { detectInstallMethod } from "../domains/lifecycle/install-method.js";
import { listMigrations } from "../domains/lifecycle/migrations/index.js";
import { readStateInfo } from "../domains/lifecycle/state.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { printError, printHeader, printOk } from "./shared.js";

const CHANNELS = ["latest", "beta", "dev"] as const;
type Channel = (typeof CHANNELS)[number];

const HELP = `clio-coder upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations]

Refresh state metadata and apply pending data-dir migrations. An npm-installed
binary is also reinstalled via npm; a source-checkout install instead prints
the git-based update steps and never touches the global npm prefix.

Flags:
  --dry-run             print planned actions without changing anything
  --channel=<chan>      npm dist-tag to install (latest|beta|dev). npm installs only.
  --skip-migrations     skip migrations after the install step
`;

const SOURCE_UPGRADE_STEPS = ["git pull", "npm run install:local", "hash -r"] as const;

function printSourceUpgradeSteps(): void {
	process.stdout.write("[upgrade] source checkout install: update the code with:\n");
	for (const step of SOURCE_UPGRADE_STEPS) process.stdout.write(`  ${step}\n`);
}

interface UpgradeOptions {
	dryRun: boolean;
	channel: Channel;
	skipMigrations: boolean;
	help: boolean;
	postInstall: boolean;
}

function parseUpgradeArgs(argv: ReadonlyArray<string>): UpgradeOptions {
	let dryRun = false;
	let channel: Channel = "latest";
	let skipMigrations = false;
	let help = false;
	let postInstall = false;
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
		if (arg.startsWith("--channel=")) {
			const value = arg.slice("--channel=".length);
			if (!(CHANNELS as ReadonlyArray<string>).includes(value)) {
				throw new Error(`--channel must be one of ${CHANNELS.join("|")}, got '${value}'`);
			}
			channel = value as Channel;
			continue;
		}
		throw new Error(`unknown upgrade argument: ${arg}`);
	}
	return { dryRun, channel, skipMigrations, help, postInstall };
}

function streamPrefixed(source: NodeJS.ReadableStream, sink: NodeJS.WritableStream): void {
	let buffered = "";
	source.on("data", (chunk: Buffer | string) => {
		buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let idx = buffered.indexOf("\n");
		while (idx !== -1) {
			const line = buffered.slice(0, idx);
			buffered = buffered.slice(idx + 1);
			// A spawned `clio-coder upgrade --post-install` prefixes its own lines;
			// wrapping those again printed `[upgrade] [upgrade] ...` for every row.
			sink.write(line.startsWith("[upgrade] ") ? `${line}\n` : `[upgrade] ${line}\n`);
			idx = buffered.indexOf("\n");
		}
	});
	source.on("end", () => {
		if (buffered.length > 0) sink.write(`[upgrade] ${buffered}\n`);
	});
}

async function runNpmInstall(channel: Channel): Promise<void> {
	const args = ["install", "-g", `@iowarp/clio-coder@${channel}`];
	process.stdout.write(`[upgrade] npm ${args.join(" ")}\n`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
		streamPrefixed(child.stdout, process.stdout);
		streamPrefixed(child.stderr, process.stderr);
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`npm exited with code ${code ?? -1}`));
		});
	});
}

async function runDoctorFixAfterInstall(): Promise<void> {
	const args = ["doctor", "--fix"];
	process.stdout.write(`[upgrade] clio-coder ${args.join(" ")}\n`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("clio-coder", args, { stdio: ["ignore", "pipe", "pipe"] });
		streamPrefixed(child.stdout, process.stdout);
		streamPrefixed(child.stderr, process.stderr);
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
	process.stdout.write(`[upgrade] clio-coder ${args.join(" ")}\n`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("clio-coder", args, { stdio: ["ignore", "pipe", "pipe"] });
		streamPrefixed(child.stdout, process.stdout);
		streamPrefixed(child.stderr, process.stderr);
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

	const before = getVersionInfo().clio;
	const stateDir = clioStateDir();
	const method = detectInstallMethod();
	printHeader("Clio Coder upgrade");
	process.stdout.write(`install     ${method === "source" ? "source checkout" : "npm"}\n`);
	if (method === "npm") process.stdout.write(`channel     ${opts.channel}\n`);
	process.stdout.write(`current     ${before}\n`);
	process.stdout.write(`state dir   ${stateDir}\n`);

	const noNetwork = Boolean(process.env.CLIO_CODER_TEST_UPGRADE_NO_NETWORK);
	const migrations = listMigrations();
	const migrationIds = migrations.map((m) => m.id);
	// What the state root says it is on, as distinct from the binary answering.
	// After `npm install -g` the two differ until the refresh below, and that
	// difference is the upgrade this command reports.
	const recorded = readStateInfo()?.version ?? null;
	// Both the dry run and the real run print this, so it stays in the mood the
	// call site sets with "would refresh" or "refreshed". The null branch used to
	// bake in "would write it", which a real upgrade printed after writing it.
	const describeRefresh = (): string =>
		recorded === null
			? "state metadata (none recorded)"
			: recorded === before
				? `state metadata (already ${before})`
				: `state metadata ${recorded} -> ${before}`;

	if (opts.dryRun) {
		if (method === "source") {
			printSourceUpgradeSteps();
		} else {
			process.stdout.write(`[upgrade] would run: npm install -g @iowarp/clio-coder@${opts.channel}\n`);
		}
		if (opts.skipMigrations) {
			process.stdout.write("[upgrade] would skip migrations (--skip-migrations)\n");
		} else if (migrationIds.length === 0) {
			process.stdout.write("[upgrade] no migrations registered; the manifest would be written as is\n");
		} else {
			process.stdout.write(`[upgrade] would consider ${migrationIds.length} migration(s):\n`);
			for (const id of migrationIds) process.stdout.write(`  - ${id}\n`);
		}
		process.stdout.write(`[upgrade] would refresh ${describeRefresh()}\n`);
		printOk("dry run complete, no changes made");
		return 0;
	}

	if (opts.postInstall) {
		process.stdout.write("[upgrade] running post-install checks with the active clio binary\n");
	} else if (method === "source") {
		process.stdout.write("[upgrade] source checkout install detected; skipping npm install\n");
	} else if (noNetwork) {
		process.stdout.write("[upgrade] CLIO_CODER_TEST_UPGRADE_NO_NETWORK set, skipping npm install\n");
	} else {
		try {
			await runNpmInstall(opts.channel);
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 1;
		}
		try {
			await runPostInstallUpgrade(opts);
			printOk(`${before} -> post-install checks complete`);
			return 0;
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 1;
		}
	}

	let appliedCount = 0;
	let appliedIds: string[] = [];
	if (opts.skipMigrations) {
		process.stdout.write("[upgrade] skipping migrations (--skip-migrations)\n");
	} else {
		const loaded = await loadDomains([ConfigDomainModule, LifecycleDomainModule]);
		try {
			const lifecycle = loaded.getContract<LifecycleContract>("lifecycle");
			if (!lifecycle) {
				printError("lifecycle domain unavailable");
				return 1;
			}
			let result: Awaited<ReturnType<LifecycleContract["runMigrations"]>>;
			try {
				result = await lifecycle.runMigrations(stateDir);
			} catch (err) {
				// A migration reports why it could not run, but on its own that reads
				// as the whole upgrade being impossible. It is not: the rest of the
				// upgrade is independent of it, and naming the flag that runs the rest
				// is the difference between a stuck operator and a moved one.
				printError(
					`migration failed: ${err instanceof Error ? err.message : String(err)}`,
					"the rest of the upgrade does not depend on it; run `clio-coder upgrade --skip-migrations` to continue, then fix the cause and re-run `clio-coder upgrade`.",
				);
				return 1;
			}
			appliedIds = [...result.applied];
			appliedCount = appliedIds.length;
			if (appliedCount === 0) {
				process.stdout.write("[upgrade] no pending migrations\n");
			} else {
				for (const id of appliedIds) process.stdout.write(`[upgrade] applied migration ${id}\n`);
			}
		} finally {
			await loaded.stop();
		}
	}

	if (method === "source" || noNetwork) {
		const refresh = describeRefresh();
		initializeClioHome();
		process.stdout.write(`[upgrade] refreshed ${refresh}\n`);
	} else {
		try {
			await runDoctorFixAfterInstall();
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 1;
		}
	}

	if (method === "source") printSourceUpgradeSteps();

	// `before` is the binary that ran; on the post-install and local paths that
	// is already the new version, and `0.3.1 -> 0.3.1` was a claim about a
	// transition that never happened. The version that moved is the recorded one.
	const after = getVersionInfo().clio;
	printOk(`${recorded ?? before} -> ${after} (migrations: ${appliedCount})`);
	return 0;
}
