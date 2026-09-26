import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { createRootVerifyResolver, type VerifyResolution } from "./resolve.js";

export const QUALITY_POLICY_PATH = ".clio-coder/quality.yaml";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_PATH_COMPONENTS = 50_000;
const MAX_GLOB_COMPARISONS = 1_000_000;

export interface QualityRule {
	id: string;
	paths: string[];
	inputs: string[];
	checks: string[];
	allowLimitations: boolean;
}

export interface QualityPolicy {
	digest: string;
	rules: QualityRule[];
}

export interface QualitySnapshot {
	version: 1;
	policyDigest: string;
	check: string;
	definitionDigest: string;
	inputs: { rule: string; digest: string }[];
}

export interface QualityFinding {
	rule: string;
	check: string;
	allowLimitation: boolean;
	state: "passed" | "failed" | "stale" | "missing" | "limited" | "unavailable";
	message: string;
}

type PolicyLoad = { ok: true; policy: QualityPolicy | null } | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length) throw new Error(`unknown fields: ${unexpected.join(", ")}`);
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32)
		throw new Error(`${label} must contain 1–32 strings`);
	if (!value.every((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 512))
		throw new Error(`${label} must contain nonempty strings of at most 512 characters`);
	if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
	return value;
}

function patterns(value: unknown, label: string): string[] {
	return strings(value, label).map((pattern) => {
		if (
			path.posix.isAbsolute(pattern) ||
			path.win32.isAbsolute(pattern) ||
			pattern.includes("\\") ||
			pattern.split("/").some((part) => part === ".." || part === ".") ||
			[...pattern].some((character) => character.charCodeAt(0) < 32)
		)
			throw new Error(`${label}: '${pattern}' must be a workspace-relative glob using forward slashes`);
		return pattern;
	});
}

/** Check components even for dangling links: absence must not hide a symbolic link. */
function qualityFileExists(root: string, relative: string, components?: Map<string, boolean | Error>): boolean {
	const parts = relative.split("/");
	let current = root;
	for (const part of parts) {
		current = path.join(current, part);
		const cached = components?.get(current);
		if (cached instanceof Error) throw cached;
		if (cached === false) return false;
		if (cached === true) continue;
		if (components && components.size >= MAX_PATH_COMPONENTS)
			throw new Error(`quality assessment exceeds ${MAX_PATH_COMPONENTS} path components`);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error(`symbolic link in quality input '${relative}'`);
			components?.set(current, true);
		} catch (error) {
			if (record(error)?.code === "ENOENT") {
				components?.set(current, false);
				return false;
			}
			const failure = error instanceof Error ? error : new Error(String(error));
			components?.set(current, failure);
			throw failure;
		}
	}
	return true;
}

/** Reject links at any component: quality evidence never reads outside the workspace. */
function boundedFile(
	root: string,
	relative: string,
	remainingBytes = MAX_INPUT_BYTES,
	components?: Map<string, boolean | Error>,
): Buffer {
	if (!qualityFileExists(root, relative, components)) throw new Error(`quality input '${relative}' is missing`);
	const current = path.join(root, relative);
	const stat = lstatSync(current);
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
		throw new Error(`quality input '${relative}' must be a regular file of at most ${MAX_FILE_BYTES} bytes`);
	if (stat.size > remainingBytes) throw new Error(`quality assessment exceeds ${MAX_INPUT_BYTES} input bytes`);
	return readFileSync(current);
}

export function loadQualityPolicy(root: string): PolicyLoad {
	try {
		try {
			lstatSync(path.join(root, QUALITY_POLICY_PATH));
		} catch (error) {
			if (record(error)?.code === "ENOENT") return { ok: true, policy: null };
			throw error;
		}
		const bytes = boundedFile(root, QUALITY_POLICY_PATH);
		if (bytes.length > 64 * 1024) throw new Error("policy exceeds 65536 bytes");
		const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
		if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
		const raw = record(document.toJS({ maxAliasCount: 0 }));
		if (!raw) throw new Error("policy must be an object");
		fields(raw, ["version", "rules"]);
		if (raw.version !== 1) throw new Error("version must be 1");
		if (!Array.isArray(raw.rules) || raw.rules.length === 0 || raw.rules.length > 32)
			throw new Error("rules must contain 1–32 entries");
		const ids = new Set<string>();
		const rules = raw.rules.map((value): QualityRule => {
			const rule = record(value);
			if (!rule) throw new Error("each rule must be an object");
			fields(rule, ["id", "paths", "inputs", "checks", "allowLimitations"]);
			if (typeof rule.id !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(rule.id) || ids.has(rule.id))
				throw new Error("rule ids must be unique lowercase identifiers of at most 64 characters");
			ids.add(rule.id);
			const paths = patterns(rule.paths, `${rule.id}.paths`);
			const checks = strings(rule.checks, `${rule.id}.checks`);
			if (checks.some((check) => !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,63}$/u.test(check) || check === "frontend"))
				throw new Error(`${rule.id}.checks must name declared command check ids`);
			if (rule.allowLimitations !== undefined && typeof rule.allowLimitations !== "boolean")
				throw new Error(`${rule.id}.allowLimitations must be a boolean`);
			return {
				id: rule.id,
				paths,
				inputs: rule.inputs === undefined ? paths : patterns(rule.inputs, `${rule.id}.inputs`),
				checks,
				allowLimitations: rule.allowLimitations === true,
			};
		});
		return { ok: true, policy: { digest: hash(bytes), rules } };
	} catch (error) {
		return { ok: false, reason: `${QUALITY_POLICY_PATH}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function qualityPathMatches(root: string, filename: string, patterns: string[]): boolean {
	const relative = path.relative(root, path.resolve(root, filename)).split(path.sep).join("/");
	return !relative.startsWith("../") && patterns.some((pattern) => path.posix.matchesGlob(relative, pattern));
}

/** Git provides ignored-file semantics and includes untracked inputs, additions and deletions. */
function qualityFiles(root: string): string[] {
	const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: root,
		encoding: "utf8",
		timeout: 5000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (realpathSync(gitRoot) !== realpathSync(root))
		throw new Error("quality snapshots require the workspace to be a Git repository root");
	const enumerate = (args: string[]): string[] =>
		execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		})
			.split("\0")
			.filter((file) => file.length > 0);
	const files = enumerate(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
	// A staged deletion leaves the index. Retain its path so fresh snapshots
	// fingerprint absence instead of mistaking a tracked deletion for an ignored input.
	const deleted = enumerate([
		"diff",
		"--cached",
		"--name-only",
		"--diff-filter=D",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		"-z",
	]);
	return [...new Set([...files, ...deleted])].sort();
}

interface SnapshotContext {
	root: string;
	files: string[];
	enumerated: Set<string>;
	digests: Map<string, string>;
	components: Map<string, boolean | Error>;
	ruleDigests: Map<string, string | Error>;
	bytes: number;
	globComparisons: number;
	resolve: (check: string) => VerifyResolution;
}

function snapshotContext(root: string): SnapshotContext {
	const files = qualityFiles(root);
	return {
		root,
		files,
		enumerated: new Set(files),
		digests: new Map(),
		components: new Map(),
		ruleDigests: new Map(),
		bytes: 0,
		globComparisons: 0,
		resolve: createRootVerifyResolver(root),
	};
}

function fileDigest(context: SnapshotContext, file: string): string {
	const cached = context.digests.get(file);
	if (cached !== undefined) return cached;
	if (context.digests.size >= MAX_FILES) throw new Error(`quality assessment exceeds ${MAX_FILES} input files`);
	let fingerprint = "deleted";
	if (qualityFileExists(context.root, file, context.components)) {
		const bytes = boundedFile(context.root, file, MAX_INPUT_BYTES - context.bytes, context.components);
		context.bytes += bytes.length;
		fingerprint = hash(bytes);
	}
	context.digests.set(file, fingerprint);
	return fingerprint;
}

function scopeRoot(pattern: string): string {
	const parts = pattern.split("/");
	const firstGlob = parts.findIndex((part) => [...part].some((character) => "*?[]{}()!+@".includes(character)));
	return (firstGlob < 0 ? parts : parts.slice(0, firstGlob)).join("/");
}

function globMatches(context: SnapshotContext, file: string, pattern: string): boolean {
	if (++context.globComparisons > MAX_GLOB_COMPARISONS)
		throw new Error(`quality assessment exceeds ${MAX_GLOB_COMPARISONS} glob comparisons`);
	return path.posix.matchesGlob(file, pattern);
}

/** Validate literal roots even when Git lists no descendants; also inspect possible wildcard ancestors. */
function inputDigest(rule: QualityRule, context: SnapshotContext): string {
	const cached = context.ruleDigests.get(rule.id);
	if (cached instanceof Error) throw cached;
	if (cached !== undefined) return cached;
	try {
		const patterns = [...new Set([...rule.paths, ...rule.inputs])];
		const scopes = patterns.map((pattern) => ({
			pattern,
			root: scopeRoot(pattern),
			prefixes: pattern
				.split("/")
				.slice(0, -1)
				.map((_, index) =>
					pattern
						.split("/")
						.slice(0, index + 1)
						.join("/"),
				),
			complex: pattern.includes("{") || pattern.includes("("),
		}));
		for (const scope of scopes) qualityFileExists(context.root, scope.root, context.components);
		const digest = createHash("sha256");
		for (const file of context.files) {
			const included = scopes.some((scope) => globMatches(context, file, scope.pattern));
			const ancestor =
				!included &&
				scopes.some((scope) =>
					scope.complex
						? scope.root.length === 0 || file === scope.root || file.startsWith(`${scope.root}/`)
						: scope.prefixes.some((prefix) => globMatches(context, file, prefix)),
				);
			if (included || ancestor) qualityFileExists(context.root, file, context.components);
			if (!included) continue;
			digest.update(JSON.stringify(file));
			digest.update(fileDigest(context, file));
		}
		const fingerprint = digest.digest("hex");
		context.ruleDigests.set(rule.id, fingerprint);
		return fingerprint;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		context.ruleDigests.set(rule.id, failure);
		throw failure;
	}
}

/** Capture policy, check declaration and all scoped source inputs before and after execution. */
export function captureQualitySnapshot(root: string, policy: QualityPolicy, check: string): QualitySnapshot {
	return captureSnapshot(snapshotContext(root), policy, check);
}

function captureSnapshot(context: SnapshotContext, policy: QualityPolicy, check: string): QualitySnapshot {
	const { root } = context;
	const resolution = context.resolve(check);
	if (resolution.kind !== "catalog" && resolution.kind !== "package" && resolution.kind !== "toolchain")
		throw new Error(
			`quality check '${check}' is not declared: ${resolution.kind === "unresolved" ? resolution.message : resolution.kind}`,
		);
	const source = path.relative(root, path.resolve(root, resolution.check.source.path)).split(path.sep).join("/");
	if (source.startsWith("../") || path.isAbsolute(source)) throw new Error("quality check source escapes workspace");
	return {
		version: 1,
		policyDigest: policy.digest,
		check,
		definitionDigest: hash(JSON.stringify(resolution) + fileDigest(context, source)),
		inputs: policy.rules
			.filter((rule) => rule.checks.includes(check))
			.map((rule) => ({ rule: rule.id, digest: inputDigest(rule, context) })),
	};
}

/** Only paired native verify receipts count; shell prose and unrelated checks cannot satisfy policy. */
export function assessQualityPolicy(
	root: string,
	policy: QualityPolicy,
	paths: readonly string[],
	entries: readonly unknown[],
): QualityFinding[] {
	const rules = policy.rules.filter(
		(rule) =>
			paths.some((filename) => qualityPathMatches(root, filename, rule.paths)) ||
			paths.some((filename) => path.resolve(root, filename) === path.resolve(root, QUALITY_POLICY_PATH)),
	);
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	const latest = new Map<string, Record<string, unknown>>();
	const limited = new Set<string>();
	for (const entry of entries) {
		const row = record(entry);
		const payload = record(row?.payload);
		if (row?.kind !== "message" || !payload || typeof payload.toolCallId !== "string") continue;
		if (row.role === "tool_call") {
			const args = record(payload.args);
			if (typeof payload.name === "string" && args) calls.set(payload.toolCallId, { name: payload.name, args });
		} else if (row.role === "tool_result") {
			const call = calls.get(payload.toolCallId);
			if (!call) continue;
			const result = record(payload.result);
			if (call.name === "verify" && typeof call.args.check === "string") {
				latest.set(call.args.check.trim(), {
					...result,
					isError: payload.isError === true || payload.error === true,
					args: call.args,
				});
			} else if (
				call.name === "limitation" &&
				(result?.kind === "ok" || record(result?.details)?.kind === "ok") &&
				payload.isError !== true &&
				payload.error !== true &&
				Array.isArray(call.args.paths)
			) {
				for (const check of call.args.paths) if (typeof check === "string") limited.add(check);
			}
		}
	}
	const snapshots = new Map<string, QualitySnapshot | Error>();
	let context: SnapshotContext | Error | undefined;
	return rules.flatMap((rule) =>
		rule.checks.map((check): QualityFinding => {
			const finding = (state: QualityFinding["state"], message: string): QualityFinding => ({
				rule: rule.id,
				check,
				allowLimitation: rule.allowLimitations,
				state,
				message,
			});
			const receipt = latest.get(check);
			if (rule.allowLimitations && limited.has(check) && !receipt)
				return finding("limited", "Explicit limitation recorded; check remains unverified.");
			if (!receipt) return finding("missing", `Run verify(check=${JSON.stringify(check)}) without args or cwd overrides.`);
			const details = record(receipt.details);
			if (
				receipt.kind === "error" ||
				details?.kind === "error" ||
				receipt.isError ||
				details?.exitCode !== 0 ||
				details?.aborted === true ||
				details?.timedOut === true ||
				details?.outputCapped === true
			)
				return rule.allowLimitations && limited.has(check)
					? finding("limited", "Explicit limitation recorded; latest check did not pass.")
					: finding("failed", "Latest check did not complete successfully.");
			const provenance = record(details.quality);
			const args = record(receipt.args);
			if (typeof provenance?.error === "string")
				return rule.allowLimitations && limited.has(check)
					? finding("limited", "Explicit limitation recorded; snapshot unavailable.")
					: finding("unavailable", provenance.error);
			if (
				args?.cwd !== undefined ||
				(args?.args !== undefined && (!Array.isArray(args.args) || args.args.length > 0)) ||
				provenance?.stable !== true
			)
				return rule.allowLimitations && limited.has(check)
					? finding("limited", "Explicit limitation recorded; snapshot is stale.")
					: finding("stale", "Check lacks a stable snapshot of the full declared invocation.");
			let current = snapshots.get(check);
			if (!current) {
				try {
					if (!context) {
						try {
							context = snapshotContext(root);
						} catch (error) {
							context = error instanceof Error ? error : new Error(String(error));
						}
					}
					if (context instanceof Error) throw context;
					current = captureSnapshot(context, policy, check);
				} catch (error) {
					current = error instanceof Error ? error : new Error(String(error));
				}
				snapshots.set(check, current);
			}
			if (current instanceof Error)
				return rule.allowLimitations && limited.has(check)
					? finding("limited", "Explicit limitation recorded; snapshot unavailable.")
					: finding("unavailable", current.message);
			if (context && !(context instanceof Error)) {
				const activeContext = context;
				const uncovered = paths.find(
					(filename) =>
						qualityPathMatches(root, filename, rule.paths) &&
						!activeContext.enumerated.has(path.relative(root, path.resolve(root, filename)).split(path.sep).join("/")),
				);
				if (uncovered !== undefined)
					return rule.allowLimitations && limited.has(check)
						? finding("limited", "Explicit limitation recorded; changed input coverage is unavailable.")
						: finding(
								"unavailable",
								`Changed source '${uncovered}' is outside the Git-enumerated snapshot; freshness cannot be established.`,
							);
			}
			if (JSON.stringify(provenance.snapshot) !== JSON.stringify(current))
				return rule.allowLimitations && limited.has(check)
					? finding("limited", "Explicit limitation recorded; snapshot is stale.")
					: finding("stale", "Source inputs, check declaration, or policy changed since verification.");
			return finding("passed", "Latest check passed against the current source and policy snapshot.");
		}),
	);
}
