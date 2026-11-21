#!/usr/bin/env node
/**
 * Keeps CLIO Coder's ACP wire shapes in step with the upstream Agent Client Protocol JSON schemas.
 *
 * The pin (scripts/acp-schema.pin.json) names one upstream tag per protocol major and the sha256 of each file read
 * from it. `src/engine/acp/upstream-schema.ts` is generated from the pinned v1 schema: TypeBox schemas for the
 * answers CLIO Coder reads from a peer and serves as one, the enums it matches on and the method tables.
 *
 *   --check (default)  fail when the generated module is not what the pin produces, or a pinned file changed
 *   --write            regenerate the module from the pin
 *   --bump             move the pin to the newest upstream tags, then regenerate
 *
 * Every mode prints the v2 drift (methods and session update kinds that differ from v1) and any newer upstream tag.
 * Downloads are cached by sha256 under the system temp directory; nothing here runs in CI.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pinPath = path.join(root, "scripts", "acp-schema.pin.json");
const modulePath = path.join(root, "src", "engine", "acp", "upstream-schema.ts");
const moduleRelative = "src/engine/acp/upstream-schema.ts";

/** The v1 definitions generated as exported schemas; everything they reference is generated alongside. */
const ROOTS = [
	"InitializeResponse",
	"NewSessionResponse",
	"LoadSessionResponse",
	"ResumeSessionResponse",
	"PromptResponse",
] as const;
/** String unions emitted as const value lists (an open `other` member is left out). */
const ENUMS = ["StopReason", "ToolKind", "ToolCallStatus", "PermissionOptionKind"] as const;
const PIN_FILES = ["schema.json", "meta.json"] as const;
type Major = "v1" | "v2";
const MAJORS: readonly Major[] = ["v1", "v2"];

interface PinEntry {
	tag: string;
	files: Record<(typeof PIN_FILES)[number], string>;
}
interface Pin {
	repository: string;
	v1: PinEntry;
	v2: PinEntry;
}
type JsonSchema = Record<string, unknown>;
interface SchemaDocument {
	$defs: Record<string, JsonSchema>;
}
interface MetaDocument {
	agentMethods: Record<string, string>;
	clientMethods: Record<string, string>;
	protocolMethods?: Record<string, string>;
}

function fail(message: string): never {
	console.error(`acp-schema: ${message}`);
	process.exit(1);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPin(): Pin {
	return JSON.parse(readFileSync(pinPath, "utf8")) as Pin;
}

function cacheDir(): string {
	const dir = path.join(tmpdir(), "clio-coder-acp-schema");
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function download(url: string): Promise<string> {
	const response = await fetch(url, { headers: { "user-agent": "clio-coder-acp-schema" } });
	if (!response.ok) fail(`GET ${url} answered ${response.status}`);
	return await response.text();
}

/** A pinned file: from the cache when its digest matches, else downloaded and held to the pin. */
async function pinnedFile(pin: Pin, major: Major, file: (typeof PIN_FILES)[number]): Promise<string> {
	const expected = pin[major].files[file];
	const cached = path.join(cacheDir(), `${expected}.json`);
	if (existsSync(cached)) {
		const text = readFileSync(cached, "utf8");
		if (sha256(text) === expected) return text;
	}
	const text = await download(rawUrl(pin.repository, pin[major].tag, major, file));
	const actual = sha256(text);
	if (actual !== expected)
		fail(`${pin[major].tag} ${major}/${file} has sha256 ${actual}, the pin says ${expected}; run --bump to re-pin`);
	writeFileSync(cached, text);
	return text;
}

function rawUrl(repository: string, tag: string, major: Major, file: string): string {
	return `https://raw.githubusercontent.com/${repository}/${tag}/schema/${major}/${file}`;
}

/** Orders `schema-v<major>.<x>.<y>[-pre]` tags; a prerelease sorts before its release. */
function compareTags(a: string, b: string): number {
	const parse = (tag: string) => {
		const match = /^schema-v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(tag);
		return match === null
			? null
			: { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
	};
	const left = parse(a);
	const right = parse(b);
	if (left === null || right === null) return 0;
	for (let index = 0; index < 3; index++) {
		const delta = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
		if (delta !== 0) return delta;
	}
	if (left.pre === right.pre) return 0;
	if (left.pre === null) return 1;
	if (right.pre === null) return -1;
	return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/** The newest upstream tag per major, or null when the tag list cannot be read. */
async function latestTags(repository: string): Promise<Record<Major, string> | null> {
	const names: string[] = [];
	for (let page = 1; page <= 5; page++) {
		const response = await fetch(`https://api.github.com/repos/${repository}/tags?per_page=100&page=${page}`, {
			headers: { "user-agent": "clio-coder-acp-schema", accept: "application/vnd.github+json" },
		}).catch(() => null);
		if (response === null || !response.ok) return null;
		const rows = (await response.json()) as unknown;
		if (!Array.isArray(rows) || rows.length === 0) break;
		for (const row of rows) if (isRecord(row) && typeof row.name === "string") names.push(row.name);
		if (rows.length < 100) break;
	}
	const newest = (major: Major): string | undefined =>
		names
			.filter((name) => name.startsWith(`schema-${major}.`))
			.sort(compareTags)
			.at(-1);
	const v1 = newest("v1");
	const v2 = newest("v2");
	return v1 !== undefined && v2 !== undefined ? { v1, v2 } : null;
}

/* ------------------------------------------------------------------------------------------------------------- */
/* JSON schema to TypeBox source                                                                                   */
/* ------------------------------------------------------------------------------------------------------------- */

function refName(ref: unknown): string {
	if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) fail(`unsupported $ref ${String(ref)}`);
	return ref.slice("#/$defs/".length);
}

function referencedDefs(node: unknown, into: Set<string>): void {
	if (Array.isArray(node)) for (const item of node) referencedDefs(item, into);
	else if (isRecord(node))
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref") into.add(refName(value));
			else referencedDefs(value, into);
		}
}

/** The definitions the roots need, each after the ones it references. */
function orderedClosure(defs: Record<string, JsonSchema>, roots: readonly string[]): string[] {
	const ordered: string[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (name: string, trail: string[]): void => {
		const seen = state.get(name);
		if (seen === "done") return;
		if (seen === "visiting") fail(`cyclic definition ${[...trail, name].join(" -> ")} needs a generator rule`);
		const def = defs[name];
		if (def === undefined) fail(`upstream schema has no definition ${name}`);
		state.set(name, "visiting");
		const refs = new Set<string>();
		referencedDefs(def, refs);
		for (const ref of [...refs].sort()) visit(ref, [...trail, name]);
		state.set(name, "done");
		ordered.push(name);
	};
	for (const name of roots) visit(name, []);
	return ordered;
}

/** Roots are referenced by their exported name, so no unused alias is emitted for one. */
function identifier(name: string): string {
	return (ROOTS as readonly string[]).includes(name) ? exportName(name) : `V1${name}`;
}

function options(schema: JsonSchema, keys: readonly string[]): string {
	const kept = keys.filter((key) => typeof schema[key] === "number").map((key) => `${key}: ${schema[key]}`);
	return kept.length === 0 ? "" : `{ ${kept.join(", ")} }`;
}

function primitive(type: string, schema: JsonSchema): string {
	switch (type) {
		case "string":
			return `Type.String(${options(schema, ["minLength", "maxLength"])})`;
		case "integer":
			return `Type.Integer(${options(schema, ["minimum", "maximum"])})`;
		case "number":
			return `Type.Number(${options(schema, ["minimum", "maximum"])})`;
		case "boolean":
			return "Type.Boolean()";
		case "null":
			return "Type.Null()";
		case "array":
			return `Type.Array(${schema.items === undefined ? "Type.Unknown()" : convert(schema.items as JsonSchema)})`;
		case "object":
			return objectSource(schema);
		default:
			return fail(`unsupported type ${type}`);
	}
}

function objectSource(schema: JsonSchema): string {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
	const entries = Object.entries(properties).map(([key, value]) => {
		const converted = convert(value as JsonSchema);
		return `${JSON.stringify(key)}: ${required.has(key) ? converted : `Type.Optional(${converted})`}`;
	});
	if (entries.length === 0 && isRecord(schema.additionalProperties))
		return `Type.Record(Type.String(), ${convert(schema.additionalProperties)})`;
	// JSON schema leaves an object open unless it says otherwise; the upstream schemas never close one.
	return `Type.Object({ ${entries.join(", ")} })`;
}

function union(members: string[]): string {
	return members.length === 1 ? (members[0] as string) : `Type.Union([${members.join(", ")}])`;
}

/** One schema node as a TypeBox expression; every constraint it states becomes a part all of which must hold. */
function convert(schema: JsonSchema): string {
	const parts: string[] = [];
	if (schema.$ref !== undefined) parts.push(identifier(refName(schema.$ref)));
	if (schema.const !== undefined) parts.push(`Type.Literal(${JSON.stringify(schema.const)})`);
	else if (Array.isArray(schema.enum))
		parts.push(union(schema.enum.map((value) => `Type.Literal(${JSON.stringify(value)})`)));
	else if (typeof schema.type === "string") parts.push(primitive(schema.type, schema));
	else if (Array.isArray(schema.type))
		parts.push(union((schema.type as string[]).map((type) => primitive(type, schema))));
	else if (isRecord(schema.properties)) parts.push(objectSource(schema));
	for (const key of ["anyOf", "oneOf"] as const) {
		const members = schema[key];
		if (Array.isArray(members)) parts.push(union(members.map((member) => convert(member as JsonSchema))));
	}
	if (Array.isArray(schema.allOf)) for (const member of schema.allOf) parts.push(convert(member as JsonSchema));
	if (parts.length === 0) return "Type.Unknown()";
	return parts.length === 1 ? (parts[0] as string) : `Type.Intersect([${parts.join(", ")}])`;
}

/** The closed string values of a union definition (`const` members; an open `title: other` member is skipped). */
function enumValues(def: JsonSchema, name: string): string[] {
	const members = (def.oneOf ?? def.anyOf) as unknown;
	if (!Array.isArray(members)) fail(`${name} is not a union`);
	const values = members
		.filter(isRecord)
		.map((member) => member.const)
		.filter((value): value is string => typeof value === "string");
	if (values.length === 0) fail(`${name} has no string values`);
	return values;
}

function sessionUpdateKinds(defs: Record<string, JsonSchema>): string[] {
	const members = (defs.SessionUpdate?.oneOf ?? defs.SessionUpdate?.anyOf) as unknown;
	if (!Array.isArray(members)) fail("SessionUpdate is not a union");
	return members
		.filter(isRecord)
		.map((member) => (isRecord(member.properties) ? member.properties.sessionUpdate : undefined))
		.map((property) => (isRecord(property) ? property.const : undefined))
		.filter((value): value is string => typeof value === "string");
}

function exportName(name: string): string {
	return `AcpV1${name}Schema`;
}

function constantName(name: string): string {
	const words = name.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase();
	return `ACP_V1_${words}${words.endsWith("S") ? "ES" : "S"}`;
}

function generate(pin: Pin, schemaText: string, metaText: string): string {
	const schema = JSON.parse(schemaText) as SchemaDocument;
	const meta = JSON.parse(metaText) as MetaDocument;
	const defs = schema.$defs;
	const closure = orderedClosure(defs, ROOTS);
	const roots = new Set<string>(ROOTS);
	const lines: string[] = [
		"// Generated by scripts/acp-schema.ts from the pinned upstream ACP schema. Do not edit; run",
		"// `node --import tsx scripts/acp-schema.ts --write` (or `--bump` for a newer upstream tag).",
		`// Source: https://github.com/${pin.repository} ${pin.v1.tag} schema/v1/schema.json sha256 ${pin.v1.files["schema.json"]}`,
		"",
		'import type { Static } from "typebox";',
		'import { Type } from "typebox";',
		"",
		"/** The upstream ACP v1 schema these shapes come from. */",
		`export const ACP_UPSTREAM_V1 = { repository: ${JSON.stringify(pin.repository)}, tag: ${JSON.stringify(pin.v1.tag)}, schemaSha256: ${JSON.stringify(pin.v1.files["schema.json"])} } as const;`,
		"",
		"/** Methods a v1 agent serves (`session/resume` among them) and a v1 client serves, as upstream lists them. */",
		`export const ACP_V1_AGENT_METHODS = ${JSON.stringify(Object.values(meta.agentMethods))} as const;`,
		`export const ACP_V1_CLIENT_METHODS = ${JSON.stringify(Object.values(meta.clientMethods))} as const;`,
		`export const ACP_V1_SESSION_UPDATE_KINDS = ${JSON.stringify(sessionUpdateKinds(defs))} as const;`,
	];
	for (const name of ENUMS) {
		const def = defs[name];
		if (def === undefined) fail(`upstream schema has no definition ${name}`);
		lines.push(`export const ${constantName(name)} = ${JSON.stringify(enumValues(def, name))} as const;`);
	}
	lines.push("");
	for (const name of closure) {
		const def = defs[name] as JsonSchema;
		if (roots.has(name)) {
			const method = typeof def["x-method"] === "string" ? ` (\`${def["x-method"]}\`)` : "";
			lines.push(`/** Upstream \`${name}\`${method}. */`);
			lines.push(`export const ${exportName(name)} = ${convert(def)};`);
			lines.push(`export type AcpV1${name} = Static<typeof ${exportName(name)}>;`);
		} else {
			lines.push(`const ${identifier(name)} = ${convert(def)};`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** biome's formatting of the generated text, so the committed file passes lint as written. */
function formatted(source: string): string {
	const biome = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "biome.cmd" : "biome");
	const result = spawnSync(biome, ["format", `--stdin-file-path=${moduleRelative}`], {
		cwd: root,
		input: source,
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) fail(`biome format failed: ${result.stderr || result.stdout}`);
	return result.stdout;
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Drift                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------- */

function difference(left: Iterable<string>, right: Iterable<string>): string[] {
	const other = new Set(right);
	return [...new Set(left)].filter((item) => !other.has(item)).sort();
}

async function printDrift(pin: Pin): Promise<void> {
	const [v1Meta, v2Meta, v1Schema, v2Schema] = await Promise.all([
		pinnedFile(pin, "v1", "meta.json"),
		pinnedFile(pin, "v2", "meta.json"),
		pinnedFile(pin, "v1", "schema.json"),
		pinnedFile(pin, "v2", "schema.json"),
	]);
	const methods = (text: string): string[] => {
		const meta = JSON.parse(text) as MetaDocument;
		return [...Object.values(meta.agentMethods), ...Object.values(meta.clientMethods)];
	};
	const kinds = (text: string): string[] => sessionUpdateKinds((JSON.parse(text) as SchemaDocument).$defs);
	const rows: Array<[string, string[]]> = [
		["methods only in v2", difference(methods(v2Meta), methods(v1Meta))],
		["methods v2 dropped", difference(methods(v1Meta), methods(v2Meta))],
		["session updates only in v2", difference(kinds(v2Schema), kinds(v1Schema))],
		["session updates v2 dropped", difference(kinds(v1Schema), kinds(v2Schema))],
	];
	console.log(`v2 drift (${pin.v2.tag} against ${pin.v1.tag}):`);
	for (const [label, items] of rows) console.log(`  ${label}: ${items.length === 0 ? "none" : items.join(", ")}`);
	const latest = await latestTags(pin.repository);
	if (latest === null) console.log("newest upstream tags: unknown (the tag list could not be read)");
	else
		for (const major of MAJORS)
			console.log(
				latest[major] === pin[major].tag
					? `${major}: pinned ${pin[major].tag} is the newest upstream tag`
					: `${major}: upstream has ${latest[major]}; pinned ${pin[major].tag} (run --bump)`,
			);
}

async function bump(pin: Pin): Promise<Pin> {
	const latest = await latestTags(pin.repository);
	if (latest === null) fail("cannot read the upstream tag list");
	const next: Pin = { ...pin };
	for (const major of MAJORS) {
		const files = {} as PinEntry["files"];
		for (const file of PIN_FILES) {
			const text = await download(rawUrl(pin.repository, latest[major], major, file));
			files[file] = sha256(text);
			writeFileSync(path.join(cacheDir(), `${files[file]}.json`), text);
		}
		next[major] = { tag: latest[major], files };
	}
	writeFileSync(pinPath, `${JSON.stringify(next, null, "\t")}\n`);
	return next;
}

async function main(): Promise<void> {
	const args = new Set(process.argv.slice(2));
	for (const arg of args)
		if (!["--check", "--write", "--bump"].includes(arg)) fail(`unknown argument ${arg}; use --check, --write or --bump`);
	let pin = readPin();
	if (args.has("--bump")) pin = await bump(pin);
	const source = formatted(
		generate(pin, await pinnedFile(pin, "v1", "schema.json"), await pinnedFile(pin, "v1", "meta.json")),
	);
	if (args.has("--write") || args.has("--bump")) {
		writeFileSync(modulePath, source);
		console.log(`wrote ${moduleRelative} from ${pin.v1.tag}`);
	} else {
		const current = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";
		if (current !== source) fail(`${moduleRelative} is not what ${pin.v1.tag} generates; run --write`);
		console.log(`${moduleRelative} matches ${pin.v1.tag}`);
	}
	await printDrift(pin);
}

await main();
