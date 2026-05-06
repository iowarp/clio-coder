import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const commandResultCache = new Map<string, string | undefined>();

export interface ResolveConfigValueOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

function env(options?: ResolveConfigValueOptions): NodeJS.ProcessEnv {
	return options?.env ?? process.env;
}

function shellCommand(command: string): string | undefined {
	const isWindows = process.platform === "win32";
	const shell = isWindows ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
	const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
	const result = spawnSync(shell, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 10_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return undefined;
	const value = result.stdout.trim();
	return value.length > 0 ? value : undefined;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) return commandResultCache.get(commandConfig);
	const value = shellCommand(commandConfig.slice(1));
	commandResultCache.set(commandConfig, value);
	return value;
}

function executeCommandUncached(commandConfig: string): string | undefined {
	return shellCommand(commandConfig.slice(1));
}

export function expandConfigValue(value: string, options?: ResolveConfigValueOptions): string {
	const sourceEnv = env(options);
	return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, bare: string | undefined, braced: string | undefined) => {
		const key = bare ?? braced;
		if (!key) return match;
		return sourceEnv[key] ?? "";
	});
}

export function expandConfigPath(value: string, options?: ResolveConfigValueOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const expandedEnv = expandConfigValue(value.trim(), options);
	let expanded = expandedEnv;
	if (expanded === "~") {
		expanded = homedir();
	} else if (expanded.startsWith(`~${sep}`) || expanded.startsWith("~/")) {
		expanded = `${homedir()}${expanded.slice(1)}`;
	} else if (expanded.startsWith("~")) {
		expanded = join(homedir(), expanded.slice(1));
	}
	return resolve(cwd, expanded);
}

export function resolveConfigValue(config: string, options?: ResolveConfigValueOptions): string | undefined {
	if (config.startsWith("!")) return executeCommand(config);
	const sourceEnv = env(options);
	const envValue = sourceEnv[config];
	if (envValue !== undefined && envValue.length > 0) return envValue;
	const expanded = expandConfigValue(config, options);
	return expanded.length > 0 ? expanded : undefined;
}

export function resolveConfigValueUncached(config: string, options?: ResolveConfigValueOptions): string | undefined {
	if (config.startsWith("!")) return executeCommandUncached(config);
	const sourceEnv = env(options);
	const envValue = sourceEnv[config];
	if (envValue !== undefined && envValue.length > 0) return envValue;
	const expanded = expandConfigValue(config, options);
	return expanded.length > 0 ? expanded : undefined;
}

export function resolveConfigValueOrThrow(
	config: string,
	description: string,
	options?: ResolveConfigValueOptions,
): string {
	const value = resolveConfigValueUncached(config, options);
	if (value !== undefined) return value;
	if (config.startsWith("!")) throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	throw new Error(`Failed to resolve ${description}`);
}

export function resolveHeaders(
	headers: Readonly<Record<string, string>> | undefined,
	options?: ResolveConfigValueOptions,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const next = resolveConfigValue(value, options);
		if (next !== undefined && next.length > 0) resolved[key] = next;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Readonly<Record<string, string>> | undefined,
	description: string,
	options?: ResolveConfigValueOptions,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, options);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
