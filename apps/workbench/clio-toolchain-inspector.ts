/**
 * Bounded adapter for Clio Coder's pinned external-tool inventory.
 *
 * `tools list --json` includes native install and binary paths plus a prose
 * resolution detail. The host validates those fields but projects only public
 * tool identity, version policy, platform support, and path-free resolution
 * facts to the browser.
 */

import { isAbsolute, resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import type {
	CommandErrorCode,
	WireToolchainInspection,
	WireToolchainItem,
	WireToolchainSource,
} from "./src/protocol.ts";

export const DEFAULT_TOOLCHAIN_INSPECT_TIMEOUT_MS = 8_000;
export const MAX_TOOLCHAIN_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_TOOLCHAIN_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_RAW_TOOLS = 32;
const MAX_RAW_TEXT_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export interface ClioToolchainInspector {
	inspect(cwd: string): Promise<WireToolchainInspection>;
}

export interface ClioCliToolchainInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioToolchainProjectionError extends Error {
	override readonly name = "ClioToolchainProjectionError";
}

export class ClioToolchainInspectError extends Error {
	override readonly name = "ClioToolchainInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")) {
		throw new ClioToolchainProjectionError(`Clio Coder returned an invalid ${label}.`);
	}
	return value;
}

function rawText(value: unknown, label: string, nullable = false): string | null {
	if (nullable && value === null) return null;
	if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > MAX_RAW_TEXT_BYTES) {
		throw new ClioToolchainProjectionError(`Clio Coder returned an invalid ${label}.`);
	}
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x7f || code < 0x20) {
			throw new ClioToolchainProjectionError(`Clio Coder returned an invalid ${label}.`);
		}
	}
	return value;
}

function version(value: unknown, label: string, nullable = false): string | null {
	const text = rawText(value, label, nullable);
	if (text === null) return null;
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(text)) {
		throw new ClioToolchainProjectionError(`Clio Coder returned an invalid ${label}.`);
	}
	return text;
}

function publicItem(value: unknown, seen: Set<string>): WireToolchainItem {
	const row = exactRecord(value, [
		"id",
		"version",
		"license",
		"platform",
		"supported",
		"installed",
		"installDir",
		"source",
		"binaryPath",
		"foundVersion",
		"minimumVersion",
		"pathCandidate",
		"detail",
	], "toolchain row");
	const id = rawText(row.id, "tool id");
	if (id === null || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id) || seen.has(id)) {
		throw new ClioToolchainProjectionError("Clio Coder returned an invalid or duplicate tool id.");
	}
	seen.add(id);
	const pinnedVersion = version(row.version, "pinned tool version");
	const minimumVersion = version(row.minimumVersion, "minimum tool version");
	const foundVersion = version(row.foundVersion, "found tool version", true);
	const license = rawText(row.license, "tool license");
	if (license === null || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(license)) {
		throw new ClioToolchainProjectionError("Clio Coder returned an invalid tool license.");
	}
	const platform = rawText(row.platform, "tool platform", true);
	if (platform !== null && !/^[a-z0-9]+-[a-z0-9_]+$/u.test(platform)) {
		throw new ClioToolchainProjectionError("Clio Coder returned an invalid tool platform.");
	}
	if (typeof row.supported !== "boolean" || typeof row.installed !== "boolean") {
		throw new ClioToolchainProjectionError("Clio Coder returned invalid tool availability facts.");
	}
	const source = row.source;
	if (source !== "path" && source !== "vendored" && source !== "none") {
		throw new ClioToolchainProjectionError("Clio Coder returned an invalid tool resolution source.");
	}
	const installDir = rawText(row.installDir, "tool install path");
	const binaryPath = rawText(row.binaryPath, "tool binary path", true);
	if (installDir === null || !isAbsolute(installDir) || (binaryPath !== null && !isAbsolute(binaryPath))) {
		throw new ClioToolchainProjectionError("Clio Coder returned an invalid tool path.");
	}
	rawText(row.detail, "tool resolution detail");
	if ((source === "none") !== (binaryPath === null && foundVersion === null)) {
		throw new ClioToolchainProjectionError("Clio Coder returned contradictory tool resolution facts.");
	}

	let pathCandidate: WireToolchainItem["pathCandidate"] = null;
	if (row.pathCandidate !== null) {
		const candidate = exactRecord(
			row.pathCandidate,
			["path", "version", "satisfiesMinimum"],
			"tool PATH candidate",
		);
		const candidatePath = rawText(candidate.path, "tool PATH candidate path");
		const candidateVersion = version(candidate.version, "tool PATH candidate version", true);
		if (candidatePath === null || !isAbsolute(candidatePath) || typeof candidate.satisfiesMinimum !== "boolean") {
			throw new ClioToolchainProjectionError("Clio Coder returned an invalid tool PATH candidate.");
		}
		if (candidate.satisfiesMinimum && source !== "path") {
			throw new ClioToolchainProjectionError("Clio Coder returned contradictory tool PATH candidate facts.");
		}
		pathCandidate = { version: candidateVersion, satisfiesMinimum: candidate.satisfiesMinimum };
	}

	return {
		id,
		pinnedVersion: pinnedVersion as string,
		license,
		platform,
		supported: row.supported,
		installed: row.installed,
		source: source as WireToolchainSource,
		foundVersion,
		minimumVersion: minimumVersion as string,
		pathCandidate,
	};
}

export function projectToolchainInspection(value: unknown, inspectedAt: string): WireToolchainInspection {
	if (!Array.isArray(value) || value.length > MAX_RAW_TOOLS) {
		throw new ClioToolchainProjectionError("Clio Coder returned an invalid toolchain inventory.");
	}
	const seen = new Set<string>();
	return {
		scope: "installation",
		inspectedAt,
		tools: value.map((entry) => publicItem(entry, seen)),
		truncated: false,
	};
}

export class ClioCliToolchainInspector implements ClioToolchainInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliToolchainInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_TOOLCHAIN_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_TOOLCHAIN_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_TOOLCHAIN_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string): Promise<WireToolchainInspection> {
		let parsed: unknown;
		try {
			parsed = await this.#runner.runJson(resolve(cwd), ["tools", "list", "--json"]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioToolchainInspectError("not-ready", "The GUI could not start Clio Coder's toolchain inspector.");
			}
			if (error.code === "timeout") {
				throw new ClioToolchainInspectError("not-ready", "Clio Coder's toolchain inspection did not finish in time.");
			}
			if (error.code === "exit") {
				const unsupported = /(?:unknown|unsupported).{0,32}(?:command|tools)|tools.{0,32}(?:unknown|unsupported)/iu
					.test(error.diagnostic);
				this.#log(`Clio Coder toolchain inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioToolchainInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide toolchain inventory."
						: "Clio Coder could not inspect its pinned external tools.",
				);
			}
			throw new ClioToolchainInspectError("internal", "Clio Coder returned an invalid or oversized tool inventory.");
		}
		try {
			return projectToolchainInspection(parsed, new Date(this.#now()).toISOString());
		} catch (error) {
			if (!(error instanceof ClioToolchainProjectionError)) throw error;
			this.#log("Clio Coder toolchain projection rejected an incompatible inventory.");
			throw new ClioToolchainInspectError(
				"internal",
				"Clio Coder's toolchain inventory is not compatible with this GUI build.",
			);
		}
	}
}
