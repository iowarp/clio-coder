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
				process.stderr.write(
					`[providers] runtime plugin ${full} rejected: ${describeError(err)}\n`,
				);
			}
		}
		return loaded;
	};

	const loadFromPackage = async (packageName: string): Promise<ReadonlyArray<string>> => {
		let mod: unknown;
		try {
			mod = await import(packageName);
		} catch (err) {
			process.stderr.write(
				`[providers] runtime package ${packageName} failed to import: ${describeError(err)}\n`,
			);
			return [];
		}
		const exported = (mod as { clioRuntimes?: unknown }).clioRuntimes;
		if (!Array.isArray(exported)) {
			process.stderr.write(
				`[providers] runtime package ${packageName} has no 'clioRuntimes' array export\n`,
			);
			return [];
		}
		const loaded: string[] = [];
		for (const candidate of exported) {
			if (!isRuntimeDescriptor(candidate)) {
				process.stderr.write(
					`[providers] runtime package ${packageName} exported an invalid descriptor\n`,
				);
				continue;
			}
			try {
				register(candidate);
				loaded.push(candidate.id);
			} catch (err) {
				process.stderr.write(
					`[providers] runtime package ${packageName} id conflict: ${describeError(err)}\n`,
				);
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

async function importDescriptor(
	file: string,
	href: string,
): Promise<RuntimeDescriptor | null> {
	let mod: unknown;
	try {
		mod = await import(href);
	} catch (err) {
		process.stderr.write(`[providers] runtime plugin ${file} failed to import: ${describeError(err)}\n`);
		return null;
	}
	const candidate = (mod as { default?: unknown }).default;
	if (!isRuntimeDescriptor(candidate)) {
		process.stderr.write(
			`[providers] runtime plugin ${file} has no valid default-export RuntimeDescriptor\n`,
		);
		return null;
	}
	return candidate;
}

function isRuntimeDescriptor(value: unknown): value is RuntimeDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.displayName === "string" &&
		(v.kind === "http" || v.kind === "subprocess") &&
		typeof v.apiFamily === "string" &&
		typeof v.auth === "string" &&
		typeof v.defaultCapabilities === "object" &&
		v.defaultCapabilities !== null &&
		typeof v.synthesizeModel === "function"
	);
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
