import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

export interface RuntimeRegistry {
	register(desc: RuntimeDescriptor): void;
	get(id: string): RuntimeDescriptor | null;
	list(): ReadonlyArray<RuntimeDescriptor>;
	loadFromDir(dir: string): Promise<ReadonlyArray<string>>;
	loadFromPackage(packageName: string): Promise<ReadonlyArray<string>>;
	clear(): void;
}

export function createRuntimeRegistry(): RuntimeRegistry {
	const byId = new Map<string, RuntimeDescriptor>();

	const register = (desc: RuntimeDescriptor): void => {
		if (byId.has(desc.id)) {
			throw new Error(`runtime id '${desc.id}' already registered`);
		}
		byId.set(desc.id, desc);
	};

	const get = (id: string): RuntimeDescriptor | null => byId.get(id) ?? null;

	const list = (): ReadonlyArray<RuntimeDescriptor> => Array.from(byId.values());

	const clear = (): void => {
		byId.clear();
	};

	const loadFromDir = async (dir: string): Promise<ReadonlyArray<string>> => {
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
			const desc = await importDescriptor(full, pathToFileURL(full).href);
			if (desc === null) continue;
			try {
				register(desc);
				loaded.push(desc.id);
			} catch (err) {
				process.stderr.write(`[providers] runtime plugin ${full} rejected: ${describeError(err)}\n`);
			}
		}
		return loaded;
	};

	const loadFromPackage = async (packageName: string): Promise<ReadonlyArray<string>> => {
		let mod: unknown;
		try {
			mod = await import(packageName);
		} catch (err) {
			process.stderr.write(`[providers] runtime package ${packageName} failed to import: ${describeError(err)}\n`);
			return [];
		}
		const exported = (mod as { clioRuntimes?: unknown }).clioRuntimes;
		if (!Array.isArray(exported)) {
			process.stderr.write(`[providers] runtime package ${packageName} has no 'clioRuntimes' array export\n`);
			return [];
		}
		const loaded: string[] = [];
		for (const candidate of exported) {
			const validation = validateRuntimeDescriptor(candidate);
			if (!validation.ok) {
				process.stderr.write(
					`[providers] runtime package ${packageName} exported an invalid descriptor: ${validation.reason}\n`,
				);
				continue;
			}
			try {
				register(validation.descriptor);
				loaded.push(validation.descriptor.id);
			} catch (err) {
				process.stderr.write(`[providers] runtime package ${packageName} id conflict: ${describeError(err)}\n`);
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

async function importDescriptor(file: string, href: string): Promise<RuntimeDescriptor | null> {
	let mod: unknown;
	try {
		mod = await import(href);
	} catch (err) {
		process.stderr.write(`[providers] runtime plugin ${file} failed to import: ${describeError(err)}\n`);
		return null;
	}
	const candidate = (mod as { default?: unknown }).default;
	const validation = validateRuntimeDescriptor(candidate);
	if (!validation.ok) {
		process.stderr.write(
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
	if (typeof v.displayName !== "string" || v.displayName.trim().length === 0) {
		return { ok: false, reason: "displayName must be a non-empty string" };
	}
	if (v.kind !== "http" && v.kind !== "subprocess" && v.kind !== "sdk") {
		return { ok: false, reason: "kind must be one of http, subprocess, sdk" };
	}
	if (typeof v.apiFamily !== "string" || v.apiFamily.trim().length === 0) {
		return { ok: false, reason: "apiFamily must be a non-empty string" };
	}
	if (typeof v.auth !== "string" || v.auth.trim().length === 0) {
		return { ok: false, reason: "auth must be a non-empty string" };
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
