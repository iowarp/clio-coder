import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeDiagnostic } from "../../core/diagnostics.js";

import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

const RUNTIME_KINDS = ["http", "sdk", "subprocess"] as const;
const RUNTIME_AUTHS = ["api-key", "oauth", "aws-sdk", "vertex-adc", "claude-cli", "none"] as const;

export interface RuntimeRegistry {
	register(desc: RuntimeDescriptor): void;
	get(id: string): RuntimeDescriptor | null;
	list(): ReadonlyArray<RuntimeDescriptor>;
	loadFromDir(dir: string, beforeImport?: () => Promise<void>): Promise<ReadonlyArray<string>>;
	loadFromPackage(packageName: string, beforeImport?: () => Promise<void>): Promise<ReadonlyArray<string>>;
	clear(): void;
}

export function createRuntimeRegistry(): RuntimeRegistry {
	const byId = new Map<string, RuntimeDescriptor>();
	const canonical = new Set<string>();

	const register = (desc: RuntimeDescriptor): void => {
		const ids = [desc.id, ...(desc.aliases ?? [])];
		const conflict = ids.find((id) => byId.has(id));
		if (conflict) {
			throw new Error(`runtime id '${conflict}' already registered`);
		}
		for (const id of ids) byId.set(id, desc);
		canonical.add(desc.id);
	};

	const get = (id: string): RuntimeDescriptor | null => byId.get(id) ?? null;

	const list = (): ReadonlyArray<RuntimeDescriptor> =>
		Array.from(canonical, (id) => byId.get(id)).filter((entry): entry is RuntimeDescriptor => entry !== undefined);

	const clear = (): void => {
		byId.clear();
		canonical.clear();
	};

	const loadFromDir = async (dir: string, beforeImport?: () => Promise<void>): Promise<ReadonlyArray<string>> => {
		let entries: string[];
		try {
			const stat = statSync(dir);
			if (!stat.isDirectory()) return [];
			entries = readdirSync(dir);
		} catch {
			return [];
		}
		const loaded: string[] = [];
		for (const name of entries) {
			if (!name.endsWith(".js")) continue;
			const full = join(dir, name);
			const desc = await importDescriptor(full, pathToFileURL(full).href, beforeImport);
			if (desc === null) continue;
			try {
				register(desc);
				loaded.push(desc.id);
			} catch (err) {
				writeDiagnostic(`[providers] runtime plugin ${full} rejected: ${describeError(err)}\n`);
			}
		}
		return loaded;
	};

	const loadFromPackage = async (
		packageName: string,
		beforeImport?: () => Promise<void>,
	): Promise<ReadonlyArray<string>> => {
		let mod: unknown;
		try {
			await beforeImport?.();
			mod = await import(packageName);
		} catch (err) {
			writeDiagnostic(`[providers] runtime package ${packageName} failed to import: ${describeError(err)}\n`);
			return [];
		}
		const exported = (mod as { clioRuntimes?: unknown }).clioRuntimes;
		if (!Array.isArray(exported)) {
			writeDiagnostic(`[providers] runtime package ${packageName} has no 'clioRuntimes' array export\n`);
			return [];
		}
		const loaded: string[] = [];
		for (const candidate of exported) {
			const validation = validateRuntimeDescriptor(candidate);
			if (!validation.ok) {
				writeDiagnostic(
					`[providers] runtime package ${packageName} exported an invalid descriptor: ${validation.reason}\n`,
				);
				continue;
			}
			try {
				register(validation.descriptor);
				loaded.push(validation.descriptor.id);
			} catch (err) {
				writeDiagnostic(`[providers] runtime package ${packageName} id conflict: ${describeError(err)}\n`);
			}
		}
		return loaded;
	};

	return { register, get, list, clear, loadFromDir, loadFromPackage };
}

let singleton: RuntimeRegistry | null = null;

export function getRuntimeRegistry(): RuntimeRegistry {
	if (singleton === null) singleton = createRuntimeRegistry();
	return singleton;
}

function normalizeRuntimeId(id: string): string {
	return id.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/**
 * The canonical id of the registered runtime closest to an unknown one, or
 * null when nothing is near enough to be a plausible typo. Ids compare
 * lowercased with separators dropped, so `lm-studio` and `llama.cpp` find their
 * runtime, and a near miss of an alias suggests the canonical id it names.
 */
export function closestRuntimeId(registry: RuntimeRegistry, input: string): string | null {
	const wanted = normalizeRuntimeId(input);
	if (wanted.length === 0) return null;
	const limit = Math.max(1, Math.floor(wanted.length / 3));
	let best: { id: string; distance: number } | null = null;
	for (const runtime of registry.list()) {
		for (const id of [runtime.id, ...(runtime.aliases ?? [])]) {
			const distance = editDistance(wanted, normalizeRuntimeId(id));
			if (distance <= limit && (best === null || distance < best.distance)) best = { id: runtime.id, distance };
		}
	}
	return best?.id ?? null;
}

async function importDescriptor(
	file: string,
	href: string,
	beforeImport?: () => Promise<void>,
): Promise<RuntimeDescriptor | null> {
	let mod: unknown;
	try {
		await beforeImport?.();
		mod = await import(href);
	} catch (err) {
		writeDiagnostic(`[providers] runtime plugin ${file} failed to import: ${describeError(err)}\n`);
		return null;
	}
	const candidate = (mod as { default?: unknown }).default;
	const validation = validateRuntimeDescriptor(candidate);
	if (!validation.ok) {
		writeDiagnostic(
			`[providers] runtime plugin ${file} has invalid default-export RuntimeDescriptor: ${validation.reason}\n`,
		);
		return null;
	}
	return validation.descriptor;
}

type RuntimeDescriptorValidation = { ok: true; descriptor: RuntimeDescriptor } | { ok: false; reason: string };

function validateRuntimeDescriptor(value: unknown): RuntimeDescriptorValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "descriptor must be an object" };
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.trim().length === 0) {
		return { ok: false, reason: "id must be a non-empty string" };
	}
	if (
		v.aliases !== undefined &&
		(!Array.isArray(v.aliases) || v.aliases.some((alias) => typeof alias !== "string" || alias.trim().length === 0))
	) {
		return { ok: false, reason: "aliases must be non-empty strings when present" };
	}
	if (typeof v.displayName !== "string" || v.displayName.trim().length === 0) {
		return { ok: false, reason: "displayName must be a non-empty string" };
	}
	if (typeof v.kind !== "string" || !RUNTIME_KINDS.includes(v.kind as (typeof RUNTIME_KINDS)[number])) {
		return { ok: false, reason: `kind must be one of: ${RUNTIME_KINDS.join(", ")}` };
	}
	if (typeof v.apiFamily !== "string" || v.apiFamily.trim().length === 0) {
		return { ok: false, reason: "apiFamily must be a non-empty string" };
	}
	if (typeof v.auth !== "string" || !RUNTIME_AUTHS.includes(v.auth as (typeof RUNTIME_AUTHS)[number])) {
		return { ok: false, reason: `auth must be one of: ${RUNTIME_AUTHS.join(", ")}` };
	}
	if (
		typeof v.defaultCapabilities !== "object" ||
		v.defaultCapabilities === null ||
		Array.isArray(v.defaultCapabilities)
	) {
		return { ok: false, reason: "defaultCapabilities must be an object" };
	}
	if (typeof v.synthesizeModel !== "function") {
		return { ok: false, reason: "synthesizeModel must be a function" };
	}
	for (const field of ["probe", "probeModels", "complete", "infill", "embed", "rerank"]) {
		if (v[field] !== undefined && typeof v[field] !== "function") {
			return { ok: false, reason: `${field} must be a function when present` };
		}
	}
	return { ok: true, descriptor: value as RuntimeDescriptor };
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
