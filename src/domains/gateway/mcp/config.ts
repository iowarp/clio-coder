/**
 * Declared local MCP servers. Two optional YAML files name them: the user's
 * `<config>/mcp.yaml`, trusted by authorship, and the project's
 * `.clio-coder/mcp.yaml`, which needs an explicit trust record (see trust.ts)
 * before anything in it is launched. The loader is strict in the same way the
 * verifier catalog is: unknown fields, shell strings, escaping paths, and
 * oversized files are diagnostics that contribute no server, never a guess.
 */

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { resolveSafeCwd } from "../../../core/safe-exec.js";
import { clioConfigDir } from "../../../core/xdg.js";

export const MCP_CONFIG_VERSION = 1;
export const MCP_USER_CONFIG_FILENAME = "mcp.yaml";
export const MCP_PROJECT_CONFIG_RELATIVE_PATH = ".clio-coder/mcp.yaml";

/** Public schema limits; diagnostics cite these values. */
export const MCP_CONFIG_CAPS = Object.freeze({
	fileBytes: 256 * 1024,
	servers: 32,
	idChars: 32,
	commandBytes: 512,
	args: 64,
	argBytes: 4096,
	envEntries: 64,
	envValueBytes: 4096,
	cwdBytes: 512,
	timeoutMs: 900_000,
});

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ROOT_FIELDS = new Set(["version", "servers"]);
const SERVER_FIELDS = new Set(["id", "command", "args", "cwd", "env", "timeoutMs"]);
const SHELL_EXECUTABLES = new Set([
	"bash",
	"cmd",
	"command.com",
	"dash",
	"fish",
	"ksh",
	"powershell",
	"pwsh",
	"sh",
	"tcsh",
	"zsh",
]);

export type McpServerScope = "user" | "project";

export interface McpServerDeclaration {
	id: string;
	scope: McpServerScope;
	/** The config file that declares the server. */
	path: string;
	command: string;
	args: string[];
	/** Absolute working directory the server starts in. */
	cwd: string;
	/** Containment root for `cwd`; the client refuses a cwd outside it. */
	cwdRoot: string;
	env: Record<string, string>;
	timeoutMs: number | null;
	/** sha256 of the canonical declaration; a trust record binds to it. */
	digest: string;
}

export interface McpConfigDiagnostic {
	scope: McpServerScope;
	path: string;
	message: string;
}

export interface McpConfigLoadResult {
	servers: McpServerDeclaration[];
	diagnostics: McpConfigDiagnostic[];
}

export interface McpConfigLoadOptions {
	cwd: string;
	/** Override for the user config directory; defaults to clioConfigDir(). */
	configDir?: string;
}

interface DeclaredServerFields {
	id: string;
	command: string;
	args: string[];
	cwd: string | null;
	env: Record<string, string>;
	timeoutMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
	return Object.keys(record)
		.filter((key) => !allowed.has(key))
		.sort();
}

/** The digest a trust record binds to: every field that changes what runs, in canonical order. */
export function mcpServerDigest(fields: {
	id: string;
	command: string;
	args: ReadonlyArray<string>;
	cwd: string | null;
	env: Readonly<Record<string, string>>;
	timeoutMs: number | null;
}): string {
	const canonical = JSON.stringify({
		id: fields.id,
		command: fields.command,
		args: [...fields.args],
		cwd: fields.cwd,
		env: Object.fromEntries(
			Object.keys(fields.env)
				.sort()
				.map((key) => [key, fields.env[key]]),
		),
		timeoutMs: fields.timeoutMs,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

export function mcpConfigPaths(options: McpConfigLoadOptions): { user: string; project: string } {
	return {
		user: path.join(options.configDir ?? clioConfigDir(), MCP_USER_CONFIG_FILENAME),
		project: path.join(path.resolve(options.cwd), MCP_PROJECT_CONFIG_RELATIVE_PATH),
	};
}

function validateId(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (value.length > MCP_CONFIG_CAPS.idChars) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.idChars}-character cap`);
	}
	if (!ID_PATTERN.test(value)) return new Error(`${location} must match /^[a-z0-9][a-z0-9_-]*$/`);
	return value;
}

function validateCommand(value: unknown, location: string): string | Error {
	if (typeof value !== "string" || value.length === 0) return new Error(`${location} must be a non-empty string`);
	if (value.includes("\0")) return new Error(`${location} must not contain a NUL byte`);
	if (/\s/u.test(value)) return new Error(`${location} must be one executable token, not a shell command string`);
	if (utf8Bytes(value) > MCP_CONFIG_CAPS.commandBytes) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.commandBytes}-byte cap`);
	}
	const hasSeparator = value.includes("/") || value.includes("\\");
	if (hasSeparator && !(path.isAbsolute(value) || path.win32.isAbsolute(value))) {
		return new Error(
			`${location} must be an executable name resolved on PATH or an absolute path; relative path '${value}' is not allowed`,
		);
	}
	const executable = path
		.basename(value)
		.toLowerCase()
		.replace(/\.exe$/u, "");
	if (SHELL_EXECUTABLES.has(executable)) {
		return new Error(`${location} may not invoke shell executable '${value}'`);
	}
	return value;
}

function validateArgs(value: unknown, location: string): string[] | Error {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return new Error(`${location} must be an array of strings`);
	if (value.length > MCP_CONFIG_CAPS.args) return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.args}-entry cap`);
	const args: string[] = [];
	for (const [index, entry] of value.entries()) {
		const entryLocation = `${location}[${index}]`;
		if (typeof entry !== "string") return new Error(`${entryLocation} must be a string`);
		if (entry.includes("\0")) return new Error(`${entryLocation} must not contain a NUL byte`);
		if (utf8Bytes(entry) > MCP_CONFIG_CAPS.argBytes) {
			return new Error(`${entryLocation} exceeds the ${MCP_CONFIG_CAPS.argBytes}-byte cap`);
		}
		args.push(entry);
	}
	return args;
}

function validateEnv(value: unknown, location: string): Record<string, string> | Error {
	if (value === undefined) return {};
	if (!isRecord(value)) return new Error(`${location} must be an object of string values`);
	const keys = Object.keys(value);
	if (keys.length > MCP_CONFIG_CAPS.envEntries) {
		return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.envEntries}-entry cap`);
	}
	const env: Record<string, string> = {};
	for (const key of keys.sort()) {
		if (!ENV_KEY_PATTERN.test(key)) return new Error(`${location}.${key} is not a valid environment variable name`);
		const entry = value[key];
		if (typeof entry !== "string") return new Error(`${location}.${key} must be a string`);
		if (entry.includes("\0")) return new Error(`${location}.${key} must not contain a NUL byte`);
		if (utf8Bytes(entry) > MCP_CONFIG_CAPS.envValueBytes) {
			return new Error(`${location}.${key} exceeds the ${MCP_CONFIG_CAPS.envValueBytes}-byte cap`);
		}
		env[key] = entry;
	}
	return env;
}

function validateTimeout(value: unknown, location: string): number | null | Error {
	if (value === undefined) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return new Error(`${location} must be a positive integer number of milliseconds`);
	}
	if (value > MCP_CONFIG_CAPS.timeoutMs) return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.timeoutMs}ms cap`);
	return value;
}

interface ResolvedCwd {
	cwd: string;
	cwdRoot: string;
}

function realDirectory(candidate: string, location: string): string | Error {
	try {
		if (!statSync(candidate).isDirectory()) return new Error(`${location} is not a directory: '${candidate}'`);
		return realpathSync(candidate);
	} catch (error) {
		return new Error(
			`${location} cannot be resolved as a directory: '${candidate}' (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

/**
 * A project server's cwd is repository-relative and must stay inside the
 * repository, symlinks included. A user server's cwd is absolute or relative
 * to the config directory; an absolute directory is its own containment root.
 */
function resolveCwd(raw: string | null, scope: McpServerScope, root: string, location: string): ResolvedCwd | Error {
	if (raw !== null) {
		if (raw.length === 0) return new Error(`${location} must be a non-empty path when given`);
		if (raw.includes("\0")) return new Error(`${location} must not contain a NUL byte`);
		if (utf8Bytes(raw) > MCP_CONFIG_CAPS.cwdBytes) {
			return new Error(`${location} exceeds the ${MCP_CONFIG_CAPS.cwdBytes}-byte cap`);
		}
	}
	const absolute = raw !== null && (path.isAbsolute(raw) || path.win32.isAbsolute(raw));
	if (scope === "project" && absolute) {
		return new Error(`${location} must be repository-relative; absolute cwd '${raw}' is not allowed`);
	}
	const realRoot = realDirectory(root, `${location} root`);
	if (realRoot instanceof Error) return realRoot;
	if (scope === "user" && absolute && raw !== null) {
		const real = realDirectory(raw, location);
		if (real instanceof Error) return real;
		return { cwd: real, cwdRoot: real };
	}
	let resolved: string;
	try {
		resolved = resolveSafeCwd(raw ?? undefined, realRoot);
	} catch {
		return new Error(`${location} escapes its root: '${raw}'`);
	}
	const real = realDirectory(resolved, location);
	if (real instanceof Error) return real;
	try {
		resolveSafeCwd(real, realRoot);
	} catch {
		return new Error(`${location} escapes its root through a symbolic link: '${raw}'`);
	}
	return { cwd: real, cwdRoot: realRoot };
}

function validateServer(
	value: unknown,
	location: string,
): { fields: DeclaredServerFields; declaredCwd: string | null } | Error {
	if (!isRecord(value)) return new Error(`${location} must be an object`);
	const unknown = unknownFields(value, SERVER_FIELDS);
	if (unknown.length > 0) return new Error(`${location} has unknown field(s): ${unknown.join(", ")}`);
	for (const field of ["id", "command"]) {
		if (!Object.hasOwn(value, field)) return new Error(`${location}.${field} is required`);
	}
	const id = validateId(value.id, `${location}.id`);
	if (id instanceof Error) return id;
	const command = validateCommand(value.command, `${location}.command`);
	if (command instanceof Error) return command;
	const args = validateArgs(value.args, `${location}.args`);
	if (args instanceof Error) return args;
	const env = validateEnv(value.env, `${location}.env`);
	if (env instanceof Error) return env;
	const timeoutMs = validateTimeout(value.timeoutMs, `${location}.timeoutMs`);
	if (timeoutMs instanceof Error) return timeoutMs;
	let declaredCwd: string | null = null;
	if (value.cwd !== undefined) {
		if (typeof value.cwd !== "string") return new Error(`${location}.cwd must be a string`);
		declaredCwd = value.cwd;
	}
	return { fields: { id, command, args, cwd: declaredCwd, env, timeoutMs }, declaredCwd };
}

export interface McpConfigTextInput {
	scope: McpServerScope;
	/** The config file path, for diagnostics and declarations. */
	path: string;
	/** Root that relative cwd values resolve against: the project root or the config directory. */
	root: string;
}

/** Parse one config file's text through the strict schema. Exported for tests and the CLI. */
export function parseMcpConfigText(text: string, input: McpConfigTextInput): McpConfigLoadResult {
	const diagnostic = (message: string): McpConfigLoadResult => ({
		servers: [],
		diagnostics: [{ scope: input.scope, path: input.path, message }],
	});
	if (utf8Bytes(text) > MCP_CONFIG_CAPS.fileBytes) {
		return diagnostic(`file exceeds the ${MCP_CONFIG_CAPS.fileBytes}-byte cap`);
	}
	const document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
	if (document.errors.length > 0) {
		return diagnostic(`invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	let parsed: unknown;
	try {
		parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
	} catch (error) {
		return diagnostic(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) return diagnostic("root must be an object with version and servers fields");
	const rootUnknown = unknownFields(parsed, ROOT_FIELDS);
	if (rootUnknown.length > 0) return diagnostic(`root has unknown field(s): ${rootUnknown.join(", ")}`);
	if (!Object.hasOwn(parsed, "version")) return diagnostic("root.version is required");
	if (parsed.version !== MCP_CONFIG_VERSION) {
		return diagnostic(
			`unsupported version ${JSON.stringify(parsed.version)}; supported version is ${MCP_CONFIG_VERSION}`,
		);
	}
	if (!Object.hasOwn(parsed, "servers")) return diagnostic("root.servers is required");
	if (!Array.isArray(parsed.servers)) return diagnostic("root.servers must be an array");
	if (parsed.servers.length > MCP_CONFIG_CAPS.servers) {
		return diagnostic(`root.servers exceeds the ${MCP_CONFIG_CAPS.servers}-server cap`);
	}
	const servers: McpServerDeclaration[] = [];
	const ids = new Map<string, number>();
	for (const [index, value] of parsed.servers.entries()) {
		const location = `servers[${index}]`;
		const validated = validateServer(value, location);
		if (validated instanceof Error) return diagnostic(validated.message);
		const { fields, declaredCwd } = validated;
		const duplicateIndex = ids.get(fields.id);
		if (duplicateIndex !== undefined) {
			return diagnostic(`${location}.id duplicates '${fields.id}' from servers[${duplicateIndex}].id`);
		}
		const resolved = resolveCwd(declaredCwd, input.scope, input.root, `${location}.cwd`);
		if (resolved instanceof Error) return diagnostic(resolved.message);
		ids.set(fields.id, index);
		servers.push({
			id: fields.id,
			scope: input.scope,
			path: input.path,
			command: fields.command,
			args: fields.args,
			cwd: resolved.cwd,
			cwdRoot: resolved.cwdRoot,
			env: fields.env,
			timeoutMs: fields.timeoutMs,
			digest: mcpServerDigest(fields),
		});
	}
	return { servers, diagnostics: [] };
}

type BoundedFileRead =
	| { ok: true; text: string }
	| { ok: false; reason: "missing" | "oversized" | "unreadable"; message: string };

/**
 * Read a regular file of at most `maxBytes` as UTF-8. The read stops one byte
 * past the cap, so a file that is (or grows) larger than the cap never lands
 * in memory whole; a FIFO or directory at the path is refused without
 * blocking on it. Shared by the config and trust loaders.
 */
export function readBoundedFileText(filePath: string, maxBytes: number): BoundedFileRead {
	const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
	let fd: number;
	try {
		fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, reason: "missing", message: "file does not exist" };
		}
		return { ok: false, reason: "unreadable", message: `cannot read (${describe(error)})` };
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) return { ok: false, reason: "unreadable", message: "path must be a regular file" };
		let buffer = Buffer.allocUnsafe(Math.min(Math.max(stats.size, 0), maxBytes) + 1);
		let total = 0;
		for (;;) {
			if (total === buffer.length) {
				if (total > maxBytes) break;
				// The file grew past its stat size; one growth to the cap settles whether it fits.
				buffer = Buffer.concat([buffer], maxBytes + 1);
			}
			const read = readSync(fd, buffer, total, buffer.length - total, null);
			if (read === 0) break;
			total += read;
		}
		if (total > maxBytes) return { ok: false, reason: "oversized", message: `file exceeds the ${maxBytes}-byte cap` };
		return { ok: true, text: buffer.toString("utf8", 0, total) };
	} catch (error) {
		return { ok: false, reason: "unreadable", message: `cannot read (${describe(error)})` };
	} finally {
		closeSync(fd);
	}
}

function loadFile(filePath: string, scope: McpServerScope, root: string): McpConfigLoadResult {
	const read = readBoundedFileText(filePath, MCP_CONFIG_CAPS.fileBytes);
	if (!read.ok) {
		if (read.reason === "missing") return { servers: [], diagnostics: [] };
		return { servers: [], diagnostics: [{ scope, path: filePath, message: read.message }] };
	}
	return parseMcpConfigText(read.text, { scope, path: filePath, root });
}

/**
 * Load both scopes. A user declaration wins an id collision; the project
 * declaration is dropped with a diagnostic so nobody wonders why the project's
 * command never runs. A malformed file contributes nothing (fail closed).
 */
export function loadMcpServerConfig(options: McpConfigLoadOptions): McpConfigLoadResult {
	const paths = mcpConfigPaths(options);
	const configDir = options.configDir ?? clioConfigDir();
	const user = loadFile(paths.user, "user", configDir);
	const project = loadFile(paths.project, "project", path.resolve(options.cwd));
	const servers = [...user.servers];
	const diagnostics = [...user.diagnostics, ...project.diagnostics];
	const userIds = new Set(user.servers.map((server) => server.id));
	for (const server of project.servers) {
		if (userIds.has(server.id)) {
			diagnostics.push({
				scope: "project",
				path: server.path,
				message: `server '${server.id}' is shadowed by the user declaration in ${paths.user}`,
			});
			continue;
		}
		servers.push(server);
	}
	return { servers, diagnostics };
}
