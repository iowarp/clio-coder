import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const commandResultCache = new Map<string, string | undefined>();

export interface ConfigValueWarning {
	code: "dynamic-command-in-generic-resolution" | "dynamic-command-in-static-resolution";
	message: string;
	command: string;
}

export interface ResolveConfigValueOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	onWarning?: (warning: ConfigValueWarning) => void;
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

function warnLegacyCommand(config: string, options?: ResolveConfigValueOptions): void {
	options?.onWarning?.({
		code: "dynamic-command-in-generic-resolution",
		message: "bang-prefixed config command is no longer executed through generic config value resolution",
		command: config.slice(1),
	});
}

function warnStaticCommand(config: string, options?: ResolveConfigValueOptions): void {
	options?.onWarning?.({
		code: "dynamic-command-in-static-resolution",
		message: "bang-prefixed config command left literal by static config value resolver",
		command: config.slice(1),
	});
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

export function resolveStaticConfigValue(config: string, options?: ResolveConfigValueOptions): string | undefined {
	if (config.startsWith("!")) warnStaticCommand(config, options);
	const sourceEnv = env(options);
	const envValue = sourceEnv[config];
	if (envValue !== undefined && envValue.length > 0) return envValue;
	const expanded = expandConfigValue(config, options);
	return expanded.length > 0 ? expanded : undefined;
}

export function resolveDynamicConfigValue(config: string, options?: ResolveConfigValueOptions): string | undefined {
	if (config.startsWith("!")) return executeCommand(config);
	return resolveStaticConfigValue(config, options);
}

export function resolveConfigValue(config: string, options?: ResolveConfigValueOptions): string | undefined {
	if (config.startsWith("!")) {
		warnLegacyCommand(config, options);
	}
	return resolveStaticConfigValue(config, options);
}
