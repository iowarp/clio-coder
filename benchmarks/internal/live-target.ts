/**
 * The one way a live driver picks a model.
 *
 * `--target <id>` names a target in the operator's own settings.yaml, found
 * through the same resolver the binary uses. That target is copied verbatim
 * into a throwaway Clio home, so the run sees exactly the runtime, URL, auth,
 * and model list the operator configured and nothing else. Credentials travel
 * with it for the duration of the run and are removed afterwards even when the
 * scratch tree is kept. Nothing here writes to the operator's real
 * config, data, state, or cache.
 *
 * A child of the run that makes its own temporary directories (the eval runner
 * gives each item a state dir and each temp-copy workspace a tree under
 * `os.tmpdir()`) lands inside the home as well, because the home's environment
 * sets `TMPDIR` beneath it. That keeps `CLIO_CODER_REQUIRE_HOME_PREFIX` honest
 * for every process in the run, not only the first one.
 *
 * The binary runs in the home's own empty `workspace/` unless a driver passes
 * a cwd, so a prompt that writes files (the delegation smoke asks the agent to
 * create one) writes into the scratch tree and never into this checkout.
 *
 * Every driver under benchmarks/internal takes the same flags:
 *
 *   --target <id>        required; a configured target id
 *   --model <wireId>     override the target's defaultModel
 *   --thinking <level>   off|minimal|low|medium|high|xhigh|max (driver sets the default)
 *   --keep               retain the scratch tree on success
 *
 * A failed run always retains its scratch tree and prints the path.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { DEFAULT_SETTINGS, THINKING_LEVELS, type ThinkingLevel } from "../../src/core/defaults.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { scratchClioEnvVars } from "../../tests/harness/scratch-env.js";
import { type RunOptions, type RunResult, runCli } from "../../tests/harness/spawn.js";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

export type LiveSettings = typeof DEFAULT_SETTINGS;

export interface LiveArgs {
	target: string;
	model: string | null;
	thinking: ThinkingLevel;
	keep: boolean;
	/** Flags the shared parser did not consume, for the driver to interpret. */
	rest: string[];
}

export class LiveUsageError extends Error {}

/**
 * Parse the shared flags. Unknown flags and positionals are handed back in
 * `rest` so a driver can add its own without a second parser.
 */
export function parseLiveArgs(argv: ReadonlyArray<string>, defaultThinking: ThinkingLevel = "off"): LiveArgs {
	let target: string | null = null;
	let model: string | null = null;
	let thinking = defaultThinking;
	let keep = false;
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined) throw new LiveUsageError(`${arg} needs a value`);
			index += 1;
			return next;
		};
		if (arg === "--target") target = value();
		else if (arg === "--model") model = value();
		else if (arg === "--thinking") {
			const level = value();
			if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
				throw new LiveUsageError(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
			}
			thinking = level as ThinkingLevel;
		} else if (arg === "--keep") keep = true;
		else rest.push(arg);
	}
	if (!target) throw new LiveUsageError("--target <id> is required; run `clio-coder targets` for the configured ids");
	return { target, model, thinking, keep, rest };
}

/** Read one flag's value out of `rest`, removing it. */
export function takeFlag(rest: string[], flag: string): string | null {
	const index = rest.indexOf(flag);
	if (index === -1) return null;
	const value = rest[index + 1];
	if (value === undefined) throw new LiveUsageError(`${flag} needs a value`);
	rest.splice(index, 2);
	return value;
}

/** Remove a boolean flag from `rest`, reporting whether it was present. */
export function takeSwitch(rest: string[], flag: string): boolean {
	const index = rest.indexOf(flag);
	if (index === -1) return false;
	rest.splice(index, 1);
	return true;
}

export function rejectUnknown(rest: ReadonlyArray<string>): void {
	if (rest.length > 0) throw new LiveUsageError(`unknown argument: ${rest[0]}`);
}

export interface LiveHome {
	dir: string;
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	/** Empty directory under the home; the default cwd for the binary. */
	workspace: string;
	env: NodeJS.ProcessEnv;
	target: TargetDescriptor;
	model: string;
	thinking: ThinkingLevel;
	/** Hide any API key the target reads from the environment. */
	redact(text: string): string;
	/** Remove credentials always; remove the tree on success unless --keep. */
	cleanup(passed: boolean): void;
}

/** Fail early with the one message that matters when dist/ is missing. */
export function requireBuild(): void {
	if (!existsSync(CLI_ENTRY)) throw new LiveUsageError(`${CLI_ENTRY} is missing; run \`npm run build\` first`);
}

export interface LiveHomeOptions {
	prefix: string;
	autonomy?: LiveSettings["autonomy"];
	/** Last word on the scratch settings before they are written. */
	settings?: (settings: LiveSettings) => void;
}

function operatorTarget(id: string): TargetDescriptor {
	const settingsPath = join(resolveClioDirs().config, "settings.yaml");
	if (!existsSync(settingsPath)) {
		throw new LiveUsageError(`no operator settings at ${settingsPath}; run \`clio-coder configure\` first`);
	}
	const parsed = parse(readFileSync(settingsPath, "utf8")) as { targets?: TargetDescriptor[] } | null;
	const targets = Array.isArray(parsed?.targets) ? parsed.targets : [];
	const target = targets.find((candidate) => candidate.id === id);
	if (!target) {
		const known = targets.map((candidate) => candidate.id).join(", ") || "(none)";
		throw new LiveUsageError(`target "${id}" is not configured; configured ids: ${known}`);
	}
	return target;
}

export function prepareLiveHome(args: LiveArgs, options: LiveHomeOptions): LiveHome {
	const target = operatorTarget(args.target);
	const model = args.model ?? target.defaultModel ?? null;
	if (!model) throw new LiveUsageError(`target "${target.id}" has no defaultModel; pass --model <wireId>`);
	const keyEnvVar = target.auth?.apiKeyEnvVar;
	if (keyEnvVar && !process.env[keyEnvVar]) {
		throw new LiveUsageError(`target "${target.id}" reads its key from ${keyEnvVar}, which is not set`);
	}

	const dir = mkdtempSync(join(tmpdir(), options.prefix));
	const env = scratchClioEnvVars(dir, { requireHomePrefix: true });
	const configDir = env.CLIO_CODER_CONFIG_DIR as string;
	const dataDir = env.CLIO_CODER_DATA_DIR as string;
	const stateDir = env.CLIO_CODER_STATE_DIR as string;
	const cacheDir = env.CLIO_CODER_CACHE_DIR as string;
	const tmpDir = join(dir, "tmp");
	const workspace = join(dir, "workspace");
	for (const path of [configDir, dataDir, stateDir, cacheDir, tmpDir, workspace]) mkdirSync(path, { recursive: true });

	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [structuredClone(target)];
	settings.orchestrator = { target: target.id, model, thinkingLevel: args.thinking };
	settings.workers.default = { target: target.id, model, thinkingLevel: args.thinking };
	if (options.autonomy) settings.autonomy = options.autonomy;
	options.settings?.(settings);
	writeFileSync(join(configDir, "settings.yaml"), stringify(settings), "utf8");

	// OAuth profiles and keyring references live in credentials.yaml next to the
	// operator's settings. Copy it for the run; it never outlives the run.
	const sourceCredentials = join(resolveClioDirs().config, "credentials.yaml");
	const copiedCredentials = join(configDir, "credentials.yaml");
	if (existsSync(sourceCredentials)) {
		copyFileSync(sourceCredentials, copiedCredentials);
		chmodSync(copiedCredentials, 0o600);
	}

	const secrets = [keyEnvVar ? process.env[keyEnvVar] : undefined].filter(
		(value): value is string => typeof value === "string" && value.length > 4,
	);

	return {
		dir,
		configDir,
		dataDir,
		stateDir,
		cacheDir,
		workspace,
		env: { ...env, TMPDIR: tmpDir, TERM: "xterm-256color" },
		target,
		model,
		thinking: args.thinking,
		redact(text) {
			let out = text;
			for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
			return out;
		},
		cleanup(passed) {
			rmSync(copiedCredentials, { force: true });
			if (passed && !args.keep) {
				rmSync(dir, { recursive: true, force: true });
				return;
			}
			process.stderr.write(`${passed ? "kept" : "failed; retained"} scratch tree at ${dir}\n`);
		},
	};
}

/** Run the built binary inside the scratch home, in its workspace unless told otherwise. Rejects on timeout. */
export function clio(
	home: LiveHome,
	args: ReadonlyArray<string>,
	options: Omit<RunOptions, "env"> = {},
): Promise<RunResult> {
	return runCli(args, { cwd: home.workspace, ...options, env: home.env });
}

/** Standard driver entry: usage on error, exit 2 for usage, 1 for a failed run. */
export async function runDriver(usage: string, body: () => Promise<boolean>): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		process.stdout.write(usage);
		return;
	}
	try {
		process.exitCode = (await body()) ? 0 : 1;
	} catch (error) {
		if (error instanceof LiveUsageError) {
			process.stderr.write(`error: ${error.message}\n\n${usage}`);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
}
