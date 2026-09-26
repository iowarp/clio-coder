/** Bounded deterministic orientation, stored with lifecycle evidence rather than in another cache. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Codewiki } from "./codewiki/schema.js";
import type { Fingerprint } from "./fingerprint.js";
import { readmeSummary, readmeTitle } from "./project-metadata.js";

const INPUT_LIMIT = 64 * 1024;
const MAX_ORIENTATION_BYTES = 12 * 1024;
const INPUTS = [
	"package.json",
	"CMakeLists.txt",
	"CMakePresets.json",
	"pyproject.toml",
	"Cargo.toml",
	"README.md",
] as const;

export interface ProjectOrientation {
	version: 1;
	workspace: string;
	treeHash: string;
	observedAt: string;
	/** Content identities include absent inputs, so an added higher-priority manifest invalidates the view. */
	inputs: Record<string, string | null>;
	identity: { name: string; purpose?: string | undefined; purposeSource?: string; source: string } | null;
	commands: Array<{ name: string; command: string; source: string }>;
	entries: string[];
	areas: Array<{ path: string; files: number }>;
	sourceFiles: number;
	testFiles: number;
}

function readInput(cwd: string, path: string): string | null {
	try {
		const full = join(cwd, path);
		if (!statSync(full).isFile() || statSync(full).size > INPUT_LIMIT) return null;
		const text = readFileSync(full, "utf8");
		return Buffer.byteLength(text) <= INPUT_LIMIT ? text : null;
	} catch {
		return null;
	}
}
function inputIdentity(cwd: string, path: string, content: string | null): string | null {
	if (content !== null) return hash(content);
	try {
		statSync(join(cwd, path));
		return "unknown";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unknown";
	}
}
function hash(text: string | null): string | null {
	return text === null ? null : createHash("sha256").update(text).digest("hex");
}
function text(value: unknown, max = 240): string | undefined {
	return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : undefined;
}
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function buildProjectOrientation(cwd: string, codewiki: Codewiki, fingerprint: Fingerprint): ProjectOrientation {
	const captured = Object.fromEntries(INPUTS.map((path) => [path, readInput(cwd, path)]));
	let identity: ProjectOrientation["identity"] = null;
	const commands: ProjectOrientation["commands"] = [];
	try {
		const pkg = record(JSON.parse(captured["package.json"] ?? "null"));
		if (pkg) {
			const name = text(pkg.name, 80);
			if (name) identity = { name, purpose: text(pkg.description), source: "package.json" };
			const manager = text(pkg.packageManager)?.split("@")[0];
			const runner = manager && ["pnpm", "npm", "yarn", "bun"].includes(manager) ? manager : "npm";
			const scripts = record(pkg.scripts);
			for (const name of ["build", "test:file", "test", "typecheck", "lint", "test:package", "ci"]) {
				if (typeof scripts?.[name] === "string")
					commands.push({ name, command: `${runner} run ${name}`, source: `package.json#scripts.${name}` });
			}
		}
	} catch {
		/* Malformed inputs remain unknown. */
	}
	if (!identity && captured["CMakeLists.txt"]) {
		const project = /\bproject\s*\(\s*([\w.+-]+)([^)]*)\)/i.exec(captured["CMakeLists.txt"]);
		if (project)
			identity = {
				name: project[1] ?? "unknown",
				purpose: text(/\bDESCRIPTION\s+"([^"]+)"/i.exec(project[2] ?? "")?.[1]),
				source: "CMakeLists.txt#project",
			};
	}
	for (const [path, key] of [
		["pyproject.toml", "project"],
		["Cargo.toml", "package"],
	] as const) {
		if (identity) break;
		try {
			const table = record(parseToml(captured[path] ?? "")[key]);
			const name = text(table?.name, 80);
			if (name) identity = { name, purpose: text(table?.description), source: `${path}#${key}` };
		} catch {
			/* No inference from malformed manifests. */
		}
	}
	try {
		const presets = record(JSON.parse(captured["CMakePresets.json"] ?? "null"));
		for (const [key, flag] of [
			["configurePresets", ""],
			["buildPresets", "--build "],
			["testPresets", "ctest"],
		] as const) {
			const values = presets?.[key];
			if (!Array.isArray(values)) continue;
			const selected = values
				.map(record)
				.filter((preset) => preset && preset.hidden !== true && text(preset.name, 80))
				.sort((a, b) => {
					const rank = (preset: Record<string, unknown> | null) =>
						preset?.name === "release" ? 0 : preset?.name === "debug" ? 1 : 2;
					return rank(a) - rank(b);
				})
				.slice(0, 2);
			for (const preset of selected) {
				const name = text(preset?.name, 80);
				if (!name || preset?.hidden === true || commands.length >= 7) continue;
				commands.push({
					name: `${key}:${name}`,
					command:
						flag === "ctest" ? `ctest --preset ${JSON.stringify(name)}` : `cmake ${flag}--preset ${JSON.stringify(name)}`,
					source: `CMakePresets.json#${key}`,
				});
			}
		}
	} catch {
		/* Presets are hints, never executed by extraction. */
	}
	if (!identity && captured["README.md"]) {
		const title = readmeTitle(captured["README.md"]);
		if (title) identity = { name: text(title, 80) ?? "unknown", source: "README.md#title" };
	}
	if (identity && !identity.purpose && captured["README.md"]) {
		const purpose = text(readmeSummary(captured["README.md"]));
		if (purpose) identity = { ...identity, purpose, purposeSource: "README.md#summary" };
	}
	const counts = new Map<string, number>();
	const sources = codewiki.files.filter((file) => file.lang !== "config");
	for (const file of sources) {
		const path = file.path.split("/").slice(0, -1).slice(0, 2).join("/") || ".";
		counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return {
		version: 1,
		workspace: resolve(cwd),
		treeHash: fingerprint.treeHash,
		observedAt: new Date().toISOString(),
		inputs: Object.fromEntries(INPUTS.map((path) => [path, inputIdentity(cwd, path, captured[path] ?? null)])),
		identity,
		commands,
		entries: sources
			.filter((file) => file.role === "entry" && file.path.length <= 240)
			.slice(0, 5)
			.map((file) => file.path),
		areas: [...counts]
			.filter(([path]) => path.length <= 240)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 6)
			.map(([path, files]) => ({ path, files })),
		sourceFiles: sources.length,
		testFiles: sources.filter((file) => file.role === "test").length,
	};
}

/** Optional additive state field: a damaged orientation must not discard valid lifecycle evidence. */
export function parseProjectOrientation(value: unknown): ProjectOrientation | undefined {
	const v = record(value);
	if (
		!v ||
		Buffer.byteLength(JSON.stringify(v)) > MAX_ORIENTATION_BYTES ||
		v.version !== 1 ||
		typeof v.workspace !== "string" ||
		typeof v.treeHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(v.treeHash) ||
		typeof v.observedAt !== "string" ||
		!Number.isFinite(Date.parse(v.observedAt))
	)
		return;
	const inputs = record(v.inputs);
	if (
		!inputs ||
		Object.keys(inputs).length !== INPUTS.length ||
		INPUTS.some(
			(p) =>
				inputs[p] !== null &&
				inputs[p] !== "unknown" &&
				(typeof inputs[p] !== "string" || !/^[a-f0-9]{64}$/.test(inputs[p] as string)),
		)
	)
		return;
	const identity = v.identity === null ? null : record(v.identity);
	if (
		v.identity !== null &&
		(!identity ||
			!text(identity.name, 80) ||
			typeof identity.source !== "string" ||
			(identity.purpose !== undefined && typeof identity.purpose !== "string") ||
			(identity.purposeSource !== undefined && typeof identity.purposeSource !== "string"))
	)
		return;
	if (
		!Array.isArray(v.commands) ||
		v.commands.length > 7 ||
		!v.commands.every((c) => {
			const r = record(c);
			return r && typeof r.name === "string" && typeof r.command === "string" && typeof r.source === "string";
		})
	)
		return;
	if (!Array.isArray(v.entries) || v.entries.length > 5 || !v.entries.every((p) => typeof p === "string")) return;
	if (
		!Array.isArray(v.areas) ||
		v.areas.length > 6 ||
		!v.areas.every((a) => {
			const r = record(a);
			return r && typeof r.path === "string" && Number.isSafeInteger(r.files) && (r.files as number) >= 0;
		})
	)
		return;
	if (![v.sourceFiles, v.testFiles].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return;
	return v as unknown as ProjectOrientation;
}

export function orientationInputsMatch(cwd: string, orientation: ProjectOrientation): boolean {
	return (
		orientation.workspace === resolve(cwd) &&
		INPUTS.every(
			(path) =>
				orientation.inputs[path] !== "unknown" &&
				inputIdentity(cwd, path, readInput(cwd, path)) === orientation.inputs[path],
		)
	);
}

/** Match only captured readable/absent inputs; unknown inputs never become certified facts. */
export function orientationKnownInputsMatch(cwd: string, orientation: ProjectOrientation): boolean {
	return (
		orientation.workspace === resolve(cwd) &&
		INPUTS.every(
			(path) =>
				orientation.inputs[path] === "unknown" ||
				inputIdentity(cwd, path, readInput(cwd, path)) === orientation.inputs[path],
		)
	);
}

/** Snapshot labels never certify a current tree, tests, task completion, or assistant conclusions. */
export function renderProjectOrientation(
	cwd: string,
	orientation: ProjectOrientation,
	fingerprint: Fingerprint,
): string {
	if (orientation.treeHash !== fingerprint.treeHash || !orientationKnownInputsMatch(cwd, orientation))
		return "<project-orientation>snapshot unavailable for current manifests/workspace; use code_nav mode=project</project-orientation>";
	const lines = [
		"<project-orientation>",
		`Recorded source snapshot ${orientation.observedAt}; current source/status must be checked with tools.`,
	];
	const knownSource = (source: string) => /^[a-f0-9]{64}$/.test(orientation.inputs[source.split("#")[0] ?? ""] ?? "");
	const unknownInputs = INPUTS.filter((path) => orientation.inputs[path] === "unknown");
	if (unknownInputs.length)
		lines.push(
			`Manifest coverage partial: ${unknownInputs.join(", ")} unreadable or oversized; their facts are unknown.`,
		);
	if (orientation.identity && knownSource(orientation.identity.source))
		lines.push(
			`Declared project (${orientation.identity.source}): ${JSON.stringify(orientation.identity.name)}${orientation.identity.purpose && knownSource(orientation.identity.purposeSource ?? orientation.identity.source) ? ` — ${JSON.stringify(orientation.identity.purpose)}${orientation.identity.purposeSource ? ` [${orientation.identity.purposeSource}]` : ""}` : ""}`,
		);
	const commands = orientation.commands.filter((command) => knownSource(command.source));
	if (commands.length)
		lines.push(
			`Declared commands: ${commands
				.slice(0, 6)
				.map((c) => `${c.command} [${c.source}]`)
				.join("; ")}`,
		);
	lines.push(
		`Indexed source: ${orientation.sourceFiles} files, ${orientation.testFiles} tests; areas: ${orientation.areas.map((a) => `${JSON.stringify(a.path)} (${a.files})`).join(", ")}.`,
	);
	if (orientation.entries.length)
		lines.push(
			`Entry candidates: ${orientation.entries.map((p) => JSON.stringify(p)).join(", ")}; confirm execution with source.`,
		);
	lines.push(
		"Navigation: code_nav mode=symbol|path|entries|outline|deps|dependents; use code_nav mode=project to retrieve current Git and durable operator task evidence. Session progress/blockers: tasks action=list. Recorded task status is not passing verification.",
		"</project-orientation>",
	);
	const prefixCount = unknownInputs.length ? 3 : 2;
	const required = [...lines.slice(0, prefixCount), ...lines.slice(-2)];
	const selected = required.slice(0, prefixCount);
	for (const line of lines.slice(prefixCount, -2)) {
		if ([...selected, line, ...required.slice(prefixCount)].join("\n").length <= 2100) selected.push(line);
	}
	return [...selected, ...required.slice(prefixCount)].join("\n");
}
