import { spawn } from "node:child_process";
import { loadDomains } from "../core/domain-loader.js";
import { clioDataDir } from "../core/xdg.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { LifecycleContract } from "../domains/lifecycle/contract.js";
import { LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { listMigrations } from "../domains/lifecycle/migrations/index.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { printError, printHeader, printOk } from "./shared.js";

const CHANNELS = ["latest", "beta", "dev"] as const;
type Channel = (typeof CHANNELS)[number];

const HELP = `clio upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations]

Reinstall Clio Coder via npm and apply any pending data-dir migrations.

Flags:
  --dry-run             print planned actions without changing anything
  --channel=<chan>      npm dist-tag to install (latest|beta|dev). Defaults to latest.
  --skip-migrations     skip migrations after the npm install step
`;

interface UpgradeOptions {
	dryRun: boolean;
	channel: Channel;
	skipMigrations: boolean;
	help: boolean;
}

function parseUpgradeArgs(argv: ReadonlyArray<string>): UpgradeOptions {
	let dryRun = false;
	let channel: Channel = "latest";
	let skipMigrations = false;
	let help = false;
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
	return { dryRun, channel, skipMigrations, help };
}

function streamPrefixed(source: NodeJS.ReadableStream, sink: NodeJS.WritableStream): void {
	let buffered = "";
	source.on("data", (chunk: Buffer | string) => {
		buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let idx = buffered.indexOf("\n");
		while (idx !== -1) {
			const line = buffered.slice(0, idx);
			buffered = buffered.slice(idx + 1);
			sink.write(`[upgrade] ${line}\n`);
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
	const dataDir = clioDataDir();
	printHeader("Clio Coder upgrade");
	process.stdout.write(`channel     ${opts.channel}\n`);
	process.stdout.write(`current     ${before}\n`);
	process.stdout.write(`data dir    ${dataDir}\n`);

	const noNetwork = Boolean(process.env.CLIO_TEST_UPGRADE_NO_NETWORK);
	const migrations = listMigrations();
	const migrationIds = migrations.map((m) => m.id);

	if (opts.dryRun) {
		process.stdout.write(`[upgrade] would run: npm install -g @iowarp/clio-coder@${opts.channel}\n`);
		if (opts.skipMigrations) {
			process.stdout.write("[upgrade] would skip migrations (--skip-migrations)\n");
		} else {
			process.stdout.write(`[upgrade] would consider ${migrationIds.length} migration(s):\n`);
			for (const id of migrationIds) process.stdout.write(`  - ${id}\n`);
		}
		printOk("dry run complete, no changes made");
		return 0;
	}

	if (noNetwork) {
		process.stdout.write("[upgrade] CLIO_TEST_UPGRADE_NO_NETWORK set, skipping npm install\n");
	} else {
		try {
			await runNpmInstall(opts.channel);
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
			const result = await lifecycle.runMigrations(dataDir);
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

	const after = getVersionInfo().clio;
	printOk(`${before} -> ${after} (migrations: ${appliedCount})`);
	return 0;
}
