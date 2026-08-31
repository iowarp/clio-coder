/**
 * Bounded installation and project-aware projection of Clio Coder diagnostics.
 *
 * `doctor --json` can report native paths, endpoint URLs, target/model/node ids,
 * session ids, commands, and raw configuration errors. None cross this adapter.
 * The browser receives fixed diagnostic categories and aggregate severities only.
 */

import { isAbsolute, resolve } from "node:path";
import { ClioReadCommandError, ClioReadCommandRunner } from "./clio-read-command.ts";
import {
	type CommandErrorCode,
	isSafeRecoveryCheckName,
	MAX_WIRE_RECOVERY_CHECKS,
	RECOVERY_SECTION_IDS,
	type WireRecoveryCheck,
	type WireRecoveryInspection,
	type WireRecoverySectionId,
} from "./src/protocol.ts";

export const DEFAULT_RECOVERY_INSPECT_TIMEOUT_MS = 60_000;
export const MAX_RECOVERY_INSPECT_STDOUT_BYTES = 1024 * 1024;
export const MAX_RECOVERY_INSPECT_STDERR_BYTES = 64 * 1024;
const MAX_FINDINGS = 1_024;
const MAX_NAME_BYTES = 512;
const MAX_DETAIL_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export interface ClioRecoveryInspector {
	inspect(cwd: string, projectContext: boolean): Promise<WireRecoveryInspection>;
}

export interface ClioCliRecoveryInspectorOptions {
	readonly executable?: string;
	/** Test/development prefix only. Browser commands can never influence argv. */
	readonly prefixArgs?: readonly string[];
	readonly timeoutMs?: number;
	readonly maximumStdoutBytes?: number;
	readonly maximumStderrBytes?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class ClioRecoveryProjectionError extends Error {
	override readonly name = "ClioRecoveryProjectionError";
}

export class ClioRecoveryInspectError extends Error {
	override readonly name = "ClioRecoveryInspectError";

	constructor(readonly code: CommandErrorCode, message: string) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown, maximumBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) return null;
	}
	return encoder.encode(value).byteLength <= maximumBytes ? value : null;
}

function sectionFor(name: string): WireRecoverySectionId {
	if (name === "Clio Coder version" || name === "node version" || name === "platform" || name === "engine runtime") {
		return "runtime";
	}
	if (
		name === "config dir" || name === "data dir" || name === "state dir" || name === "cache dir" ||
		name === "state storage"
	) return "storage";
	if (name === "settings.yaml" || name === "credentials") return "configuration";
	if (name === "state metadata" || name === "session store" || name === "cache telemetry") return "history";
	if (name.startsWith("model ") || name.startsWith("target ")) return "models";
	if (name.startsWith("interop ")) return "interoperability";
	// The pinned external programs and the managed Yazi profile are one operator
	// concern, and the Toolchain panel is where its inventory already lives.
	if (name.startsWith("external tool ") || name === "yazi managed profile") return "toolchain";
	if (name.startsWith("panes ")) return "panes";
	if (name.startsWith("fleet ")) return "fleet";
	return "other";
}

function safeVersion(value: string, node: boolean): string | null {
	const prefix = node ? "v" : "";
	return new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$`, "u").test(value) ? value : null;
}

function safePlatform(value: string): string | null {
	return /^[a-z0-9]+-[a-z0-9_]+$/u.test(value) ? value : null;
}

function validatePaths(value: unknown): number {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "cache,config,data,state") {
		throw new ClioRecoveryProjectionError("Clio Coder returned an invalid path resolution report.");
	}
	for (const key of ["config", "data", "state", "cache"] as const) {
		const path = boundedText(value[key], 4 * 1024);
		if (path === null || !isAbsolute(path)) {
			throw new ClioRecoveryProjectionError("Clio Coder returned an invalid path resolution report.");
		}
	}
	return 4;
}

type MutableCounts = { checks: number; passed: number; warnings: number; failures: number };

export function projectRecoveryInspection(
	doctorValue: unknown,
	pathsValue: unknown,
	inspectedAt: string,
	projectContext: boolean,
): WireRecoveryInspection {
	if (!isRecord(doctorValue) || typeof doctorValue.ok !== "boolean" || doctorValue.fix !== false) {
		throw new ClioRecoveryProjectionError("Clio Coder returned an invalid diagnostic report.");
	}
	if (
		!Array.isArray(doctorValue.findings) || doctorValue.findings.length === 0 ||
		doctorValue.findings.length > MAX_FINDINGS
	) {
		throw new ClioRecoveryProjectionError("Clio Coder returned an invalid diagnostic report.");
	}
	const sections = new Map<WireRecoverySectionId, MutableCounts>();
	const summary: MutableCounts = { checks: 0, passed: 0, warnings: 0, failures: 0 };
	const checks: WireRecoveryCheck[] = [];
	let clioCoderVersion: string | null = null;
	let nodeVersion: string | null = null;
	let platform: string | null = null;

	for (const finding of doctorValue.findings) {
		if (!isRecord(finding) || typeof finding.ok !== "boolean") {
			throw new ClioRecoveryProjectionError("Clio Coder returned an invalid diagnostic finding.");
		}
		const name = boundedText(finding.name, MAX_NAME_BYTES);
		const detail = boundedText(finding.detail, MAX_DETAIL_BYTES);
		const level = finding.level === undefined ? (finding.ok ? "ok" : "error") : finding.level;
		if (
			name === null || detail === null || (level !== "ok" && level !== "warn" && level !== "error") ||
			(finding.ok !== (level !== "error"))
		) throw new ClioRecoveryProjectionError("Clio Coder returned a contradictory diagnostic finding.");

		const sectionId = sectionFor(name);
		const counts = sections.get(sectionId) ?? { checks: 0, passed: 0, warnings: 0, failures: 0 };
		counts.checks += 1;
		summary.checks += 1;
		if (level === "ok") {
			counts.passed += 1;
			summary.passed += 1;
		} else if (level === "warn") {
			counts.warnings += 1;
			summary.warnings += 1;
		} else {
			counts.failures += 1;
			summary.failures += 1;
		}
		sections.set(sectionId, counts);
		// The detail is free prose that quotes native paths, endpoint URLs, socket
		// paths, model ids, and session ids, so only the name and verdict cross. A
		// name that is not name-shaped is dropped rather than failing the sweep,
		// because a harness that renames a check must not blank the whole panel.
		if (checks.length < MAX_WIRE_RECOVERY_CHECKS) {
			checks.push({
				name: isSafeRecoveryCheckName(name) ? name : null,
				section: sectionId,
				level,
			});
		}

		if (name === "Clio Coder version") clioCoderVersion = safeVersion(detail, false);
		else if (name === "node version") nodeVersion = safeVersion(detail, true);
		else if (name === "platform") platform = safePlatform(detail);
	}
	if (doctorValue.ok !== (summary.failures === 0)) {
		throw new ClioRecoveryProjectionError("Clio Coder returned a contradictory diagnostic summary.");
	}

	return {
		scope: "installation",
		projectContext,
		inspectedAt,
		healthy: doctorValue.ok,
		pathsResolved: validatePaths(pathsValue),
		versions: { clioCoder: clioCoderVersion, node: nodeVersion, platform },
		summary,
		sections: RECOVERY_SECTION_IDS.flatMap((id) => {
			const counts = sections.get(id);
			return counts === undefined ? [] : [{ id, ...counts }];
		}),
		checks,
		checksTruncated: summary.checks > checks.length,
	};
}

export class ClioCliRecoveryInspector implements ClioRecoveryInspector {
	readonly #runner: ClioReadCommandRunner;
	readonly #now: () => number;
	readonly #log: (message: string) => void;

	constructor(options: ClioCliRecoveryInspectorOptions = {}) {
		this.#runner = new ClioReadCommandRunner({
			executable: options.executable,
			prefixArgs: options.prefixArgs,
			timeoutMs: options.timeoutMs ?? DEFAULT_RECOVERY_INSPECT_TIMEOUT_MS,
			maximumStdoutBytes: options.maximumStdoutBytes ?? MAX_RECOVERY_INSPECT_STDOUT_BYTES,
			maximumStderrBytes: options.maximumStderrBytes ?? MAX_RECOVERY_INSPECT_STDERR_BYTES,
		});
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	async inspect(cwd: string, projectContext: boolean): Promise<WireRecoveryInspection> {
		let doctor: unknown;
		let paths: unknown;
		try {
			[doctor, paths] = await Promise.all([
				this.#runner.runJson(resolve(cwd), ["doctor", "--json"], [0, 1]),
				this.#runner.runJson(resolve(cwd), ["paths", "--json"]),
			]);
		} catch (error) {
			if (!(error instanceof ClioReadCommandError)) throw error;
			if (error.code === "spawn") {
				throw new ClioRecoveryInspectError("not-ready", "The GUI could not start Clio Coder diagnostics.");
			}
			if (error.code === "timeout") {
				throw new ClioRecoveryInspectError("not-ready", "Clio Coder diagnostics did not finish within one minute.");
			}
			if (error.code === "exit") {
				const unsupported = /(?:unknown|unsupported).{0,32}(?:command|doctor|paths)/iu.test(error.diagnostic);
				this.#log(`Clio Coder recovery inspector exited with code ${error.exitCode ?? "unknown"}.`);
				throw new ClioRecoveryInspectError(
					unsupported ? "unsupported" : "not-ready",
					unsupported
						? "This Clio Coder version does not provide machine-readable diagnostics."
						: "Clio Coder could not complete its diagnostic sweep.",
				);
			}
			throw new ClioRecoveryInspectError("internal", "Clio Coder returned invalid or oversized diagnostics.");
		}
		try {
			return projectRecoveryInspection(
				doctor,
				paths,
				new Date(this.#now()).toISOString(),
				projectContext,
			);
		} catch (error) {
			if (!(error instanceof ClioRecoveryProjectionError)) throw error;
			this.#log("Clio Coder recovery projection rejected an incompatible report.");
			throw new ClioRecoveryInspectError(
				"internal",
				"Clio Coder diagnostics are not compatible with this GUI build.",
			);
		}
	}
}
