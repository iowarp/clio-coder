import { readFile } from "node:fs/promises";
import {
	COMPONENT_AUTHORITIES,
	COMPONENT_KINDS,
	COMPONENT_RELOAD_CLASSES,
	type ComponentAuthority,
	type ComponentKind,
	type ComponentReloadClass,
	type ComponentSnapshot,
	type HarnessComponent,
} from "./types.js";

export async function loadComponentSnapshot(path: string): Promise<ComponentSnapshot> {
	const raw = await readFile(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${path}: invalid JSON: ${message}`);
	}
	return parseComponentSnapshot(parsed, path);
}

export function parseComponentSnapshot(value: unknown, source = "snapshot"): ComponentSnapshot {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	if (value.version !== 1) throw new Error(`${source}: expected version 1`);
	if (typeof value.generatedAt !== "string" || value.generatedAt.length === 0) {
		throw new Error(`${source}: expected generatedAt string`);
	}
	if (typeof value.root !== "string" || value.root.length === 0) {
		throw new Error(`${source}: expected root string`);
	}
	if (!Array.isArray(value.components)) throw new Error(`${source}: expected components array`);
	return {
		version: 1,
		generatedAt: value.generatedAt,
		root: value.root,
		components: value.components.map((component, index) =>
			parseHarnessComponent(component, `${source}:components[${index}]`),
		),
	};
}

function parseHarnessComponent(value: unknown, source: string): HarnessComponent {
	if (!isRecord(value)) throw new Error(`${source}: expected object`);
	const id = readString(value, source, "id");
	const kind = readEnum(value, source, "kind", COMPONENT_KINDS);
	const path = readString(value, source, "path");
	const ownerDomain = readString(value, source, "ownerDomain");
	const mutable = readBoolean(value, source, "mutable");
	const authority = readEnum(value, source, "authority", COMPONENT_AUTHORITIES);
	const reloadClass = readEnum(value, source, "reloadClass", COMPONENT_RELOAD_CLASSES);
	const contentHash = readString(value, source, "contentHash");
	if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error(`${source}: expected contentHash sha256 hex`);
	const component: HarnessComponent = {
		id,
		kind,
		path,
		ownerDomain,
		mutable,
		authority,
		reloadClass,
		contentHash,
	};
	if (Object.hasOwn(value, "description")) {
		if (typeof value.description !== "string") throw new Error(`${source}: expected description string`);
		component.description = value.description;
	}
	return component;
}

function readString(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}: expected ${field} string`);
	return value;
}

function readBoolean(record: Record<string, unknown>, source: string, field: string): boolean {
	const value = record[field];
	if (typeof value !== "boolean") throw new Error(`${source}: expected ${field} boolean`);
	return value;
}

function readEnum<T extends ComponentKind | ComponentAuthority | ComponentReloadClass>(
	record: Record<string, unknown>,
	source: string,
	field: string,
	values: ReadonlyArray<T>,
): T {
	const value = record[field];
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${source}: expected ${field} to be one of ${values.join(", ")}`);
	}
	return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
