/**
 * Source-tree extractors for the knob registry. Each kind has one mechanical
 * reading of "what the code exposes", and the check in ./check.ts holds
 * docs/knobs.yaml against it in both directions.
 *
 *   env           process.env reads and CLIO_CODER_* tokens under src/
 *   flag          --flag literals in parse positions under src/cli/
 *   setting       DEFAULT_SETTINGS leaves, plus the members of the interfaces
 *                 behind the opaque paths (targets[], fleet.nodes[], ...)
 *   project-file  the keys the .clio-coder/ loaders read (forward-verified only)
 *   tool-arg      the argument schemas of the tools named in toolArgScopes
 *   recipe-key    RECIPE_KEYS plus the nested budget and resultContract keys
 *   fragment-key  frontmatter keys the fragment loader reads or a fragment carries
 *   model-tag     every key path in the model knowledge-base YAML files
 *   constant      top-level numeric constants in the files named in constantScopes
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { OPTIONAL_RECIPE_KEYS, RECIPE_KEYS } from "../../src/domains/agents/recipe-schema.js";
import type { KnobKind, SourceInventory, SourceKnob, SourceSite } from "./types.js";

export interface SourceScopes {
	constantScopes: ReadonlyArray<string>;
	toolArgScopes: ReadonlyArray<string>;
}

function walkFiles(dir: string, accept: (file: string) => boolean): string[] {
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries.sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...walkFiles(full, accept));
			continue;
		}
		if (accept(full)) found.push(full);
	}
	return found;
}

function isTs(file: string): boolean {
	return (file.endsWith(".ts") || file.endsWith(".mts")) && !file.endsWith(".d.ts");
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
	return line;
}

class Collector {
	readonly knobs = new Map<string, SourceKnob>();
	constructor(private readonly root: string) {}

	add(knob: Omit<SourceKnob, "sites">, site: SourceSite | null): SourceKnob {
		const key = `${knob.kind}:${knob.command ?? knob.file ?? knob.source ?? ""}:${knob.name}`;
		let existing = this.knobs.get(key);
		if (!existing) {
			existing = { ...knob, sites: [] };
			this.knobs.set(key, existing);
		}
		if (site && !existing.sites.some((s) => s.path === site.path && s.line === site.line)) existing.sites.push(site);
		if (knob.default !== undefined && existing.default === undefined) existing.default = knob.default;
		return existing;
	}

	rel(file: string): string {
		return relative(this.root, file).split("\\").join("/");
	}
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

const ENV_ACCESS = /(?:process\.env|\benv)(?:\.([A-Z][A-Z0-9_]{1,})\b|\[["']([A-Z][A-Z0-9_]{1,})["']\])/g;
/** A CLIO_CODER_* name spelled as a string (env key, child env entry, help text), not as an identifier. */
const CLIO_TOKEN = /(?:["'`]|\$(?!\{))(CLIO_CODER_[A-Z0-9_]+)/g;
/** process.emitWarning codes that share the prefix but are not environment variables. */
const NOT_ENV_NAMES = new Set(["CLIO_CODER_DEPRECATED_ENV", "CLIO_CODER_LEGACY_NAMING"]);

function collectEnv(c: Collector, srcFiles: string[]): void {
	for (const file of srcFiles) {
		const text = readFileSync(file, "utf8");
		const path = c.rel(file);
		for (const match of text.matchAll(ENV_ACCESS)) {
			const name = match[1] ?? match[2];
			if (!name) continue;
			c.add({ kind: "env", name }, { path, line: lineOf(text, match.index ?? 0) });
		}
		for (const match of text.matchAll(CLIO_TOKEN)) {
			const name = match[1];
			if (!name || NOT_ENV_NAMES.has(name)) continue;
			c.add({ kind: "env", name }, { path, line: lineOf(text, match.index ?? 0) });
		}
	}
}

// ---------------------------------------------------------------------------
// flag
// ---------------------------------------------------------------------------

/**
 * Which command a file under src/cli parses flags for. Files that exist to
 * serve one command carry that command's name; helpers shared by several
 * commands are listed under the command whose flags they parse.
 */
const CLI_FILE_COMMANDS: ReadonlyArray<[RegExp, string]> = [
	[/^src\/cli\/(argv|index|clio)\.ts$/, "global"],
	[/^src\/cli\/(args|run|initial-message|steer-channel|validate-model)\.ts$/, "run"],
	[/^src\/cli\/modes\//, "run"],
	[/^src\/cli\/configure(-[a-z-]+)?\.ts$/, "configure"],
	[/^src\/cli\/(provider-target|default-target|oauth-[a-z-]+)\.ts$/, "configure"],
	[/^src\/cli\/targets\.ts$/, "targets"],
	[/^src\/cli\/context(-[a-z-]+)?\.ts$/, "context"],
	[/^src\/cli\/(bootstrap-generate|wiki-generate)\.ts$/, "context"],
	[/^src\/cli\/fleet(-[a-z-]+)?\.ts$/, "fleet"],
	[/^src\/cli\/doctor(-[a-z-]+)?\.ts$/, "doctor"],
	[/^src\/cli\/skills(-[a-z-]+)?\.ts$/, "skills"],
	[/^src\/cli\/eval(-[a-z-]+)?\.ts$/, "eval"],
	[/^src\/cli\/evidence(-[a-z-]+)?\.ts$/, "evidence"],
	[/^src\/cli\/interop(-[a-z-]+)?\.ts$/, "interop"],
	[/^src\/cli\/verifiers(-[a-z-]+)?\.ts$/, "verifiers"],
	[/^src\/cli\/trace(-[a-z-]+)?\.ts$/, "trace"],
	[/^src\/cli\/config(-[a-z-]+)?\.ts$/, "config"],
	[/^src\/cli\/(removal|uninstall)\.ts$/, "uninstall"],
	[/^src\/cli\/(shared|output-guard|text-layout|paths)\.ts$/, "paths"],
	[/^src\/cli\/([a-z]+)\.ts$/, "$1"],
];

function cliCommandFor(path: string): string | null {
	for (const [pattern, command] of CLI_FILE_COMMANDS) {
		const match = path.match(pattern);
		if (match) return command === "$1" ? (match[1] ?? null) : command;
	}
	return null;
}

function flagLiteral(node: ts.Node): string | null {
	if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
	const text = node.text;
	if (!/^--?[a-zA-Z]/.test(text)) return null;
	return text.replace(/=.*$/, "");
}

function collectFlagsInFile(c: Collector, file: string, command: string): void {
	const text = readFileSync(file, "utf8");
	const path = c.rel(file);
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const seen = new Set<string>();
	const record = (node: ts.Node, name: string): void => {
		const line = lineOf(text, node.getStart(sf));
		if (seen.has(`${name}@${line}`)) return;
		seen.add(`${name}@${line}`);
		c.add({ kind: "flag", name, command }, { path, line });
	};
	const consider = (node: ts.Node): void => {
		const name = flagLiteral(node);
		if (name) record(node, name);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node)) {
			const op = node.operatorToken.kind;
			if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
				consider(node.left);
				consider(node.right);
			}
		} else if (ts.isCaseClause(node)) {
			consider(node.expression);
		} else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			if (method === "startsWith" || method === "includes" || method === "indexOf" || method === "has") {
				for (const arg of node.arguments) {
					const literal = flagLiteral(arg);
					if (literal) record(arg, literal);
					else if (method === "has" && ts.isStringLiteral(arg) && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(arg.text)) {
						// parseFlags() strips the dashes before the set is built.
						record(arg, arg.text.length === 1 ? `-${arg.text}` : `--${arg.text}`);
					}
				}
			}
			if ((method === "includes" || method === "has") && ts.isArrayLiteralExpression(node.expression.expression)) {
				for (const element of node.expression.expression.elements) consider(element);
			}
		} else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
			const ctor = node.expression.text;
			const first = node.arguments?.[0];
			if ((ctor === "Set" || ctor === "Map") && first && ts.isArrayLiteralExpression(first)) {
				for (const element of first.elements) {
					if (ctor === "Set") consider(element);
					else if (ts.isArrayLiteralExpression(element) && element.elements[0]) consider(element.elements[0]);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

function collectFlags(c: Collector, root: string): string[] {
	const unmapped: string[] = [];
	for (const file of walkFiles(join(root, "src", "cli"), isTs)) {
		const path = c.rel(file);
		const command = cliCommandFor(path);
		if (command === null) {
			if (/["'`]--?[a-zA-Z]/.test(readFileSync(file, "utf8"))) unmapped.push(path);
			continue;
		}
		collectFlagsInFile(c, file, command);
	}
	return unmapped;
}

// ---------------------------------------------------------------------------
// setting
// ---------------------------------------------------------------------------

interface InterfaceTable {
	members: Map<string, Array<{ name: string; type: string }>>;
	sites: Map<string, SourceSite>;
	docs: Map<string, string>;
	/** `type Name = ...` declarations, resolved before a member type is expanded. */
	aliases: Map<string, string>;
}

function readInterfaces(root: string, files: string[]): InterfaceTable {
	const table: InterfaceTable = { members: new Map(), sites: new Map(), docs: new Map(), aliases: new Map() };
	for (const rel of files) {
		const file = join(root, rel);
		const text = readFileSync(file, "utf8");
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isTypeAliasDeclaration(node)) table.aliases.set(node.name.text, node.type.getText(sf));
			if (ts.isInterfaceDeclaration(node)) {
				const members: Array<{ name: string; type: string }> = [];
				for (const clause of node.heritageClauses ?? []) {
					for (const parent of clause.types) {
						// `extends` is recorded as a pseudo-member the expander splices in.
						members.push({ name: "", type: parent.expression.getText(sf) });
					}
				}
				for (const member of node.members) {
					if (!ts.isPropertySignature(member) || !member.type) continue;
					const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
					if (!name) continue;
					members.push({ name, type: member.type.getText(sf) });
					table.sites.set(`${node.name.text}.${name}`, { path: rel, line: lineOf(text, member.getStart(sf)) });
					const doc = commentAbove(text, member.getStart(sf));
					if (doc) table.docs.set(`${node.name.text}.${name}`, doc);
				}
				table.members.set(node.name.text, members);
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return table;
}

/**
 * Expand one member type into dotted sub-paths. Unions with undefined/null are
 * stripped, arrays add `[]`, string-keyed records add `<key>`, and a type that
 * names a known interface recurses.
 */
function expandType(
	table: InterfaceTable,
	type: string,
	prefix: string,
	emit: (path: string, site: SourceSite | undefined, doc?: string) => void,
	depth = 0,
): number {
	if (depth > 8) return 0;
	let t = type.trim();
	t = t.replace(/\s*\|\s*(undefined|null)\b/g, "").replace(/^\((.*)\)$/, "$1");
	const alias = table.aliases.get(t);
	if (alias !== undefined && !table.members.has(t)) return expandType(table, alias, prefix, emit, depth + 1);
	const partial = t.match(/^Partial<(.+)>$/);
	if (partial?.[1]) t = partial[1];
	const omit = t.match(/^Omit<([A-Za-z]+),\s*(.+)>$/);
	if (omit?.[1] && omit[2]) {
		const dropped = new Set([...omit[2].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]));
		return expandMembers(
			table,
			omit[1],
			prefix,
			(path, site, doc) => {
				const leaf = path.slice(prefix.length + 1).split(".")[0] ?? "";
				if (!dropped.has(leaf)) emit(path, site, doc);
			},
			depth,
		);
	}
	const readonly = t.match(/^Readonly<(.+)>$/);
	if (readonly?.[1]) t = readonly[1];
	const array = t.match(/^(?:ReadonlyArray|Array)<(.+)>$/) ?? t.match(/^(.+)\[\]$/);
	if (array?.[1]) {
		// A list of scalars is one knob; a list of objects contributes its members.
		const inner = array[1].trim();
		if (/^(string|number|boolean)$/.test(inner)) return 0;
		return expandType(table, inner, `${prefix}[]`, emit, depth + 1);
	}
	const record = t.match(/^Record<string,\s*(.+)>$/);
	if (record?.[1]) {
		const below = expandType(table, record[1].trim(), `${prefix}.<key>`, emit, depth + 1);
		if (below > 0) return below;
		// A map of scalars: one knob per operator-chosen key.
		emit(`${prefix}.<key>`, undefined);
		return 1;
	}
	const inline = t.match(/^\{([\s\S]*)\}$/);
	if (inline?.[1]) {
		let emitted = 0;
		for (const line of inline[1].split(/[;\n]/)) {
			const member = line.trim().match(/^([a-zA-Z_]+)\??:\s*(.+)$/);
			if (!member?.[1] || !member[2]) continue;
			const below = expandType(table, member[2], `${prefix}.${member[1]}`, emit, depth + 1);
			if (below === 0) emit(`${prefix}.${member[1]}`, undefined);
			emitted += Math.max(below, 1);
		}
		return emitted;
	}
	if (table.members.has(t)) return expandMembers(table, t, prefix, emit, depth);
	return 0;
}

function expandMembers(
	table: InterfaceTable,
	name: string,
	prefix: string,
	emit: (path: string, site: SourceSite | undefined, doc?: string) => void,
	depth: number,
): number {
	const members = table.members.get(name);
	if (!members) return 0;
	let emitted = 0;
	for (const member of members) {
		if (member.name === "") {
			// An `extends` clause: the parent's members belong at this same prefix.
			emitted += expandMembers(table, member.type, prefix, emit, depth + 1);
			continue;
		}
		const site = table.sites.get(`${name}.${member.name}`);
		const doc = table.docs.get(`${name}.${member.name}`);
		const below = expandType(
			table,
			member.type,
			`${prefix}.${member.name}`,
			(path, childSite, childDoc) => emit(path, childSite ?? site, childDoc),
			depth + 1,
		);
		if (below === 0) emit(`${prefix}.${member.name}`, site, doc);
		emitted += Math.max(below, 1);
	}
	return emitted;
}

/**
 * The settings-v2 sections and the interfaces that type them. The interfaces
 * are the source for the key set (they carry the optional keys DEFAULT_SETTINGS
 * leaves out, such as `context.compaction.model`); DEFAULT_SETTINGS supplies
 * the defaults and the YAML line to cite.
 */
const SETTINGS_SHAPES: ReadonlyArray<[string, string]> = [
	["targets", "TargetDescriptor[]"],
	["chat", "ChatSettings"],
	["fleet", "FleetSettings"],
	["context", "ContextSettings"],
	["safety", "SafetySettings"],
	["interface", "InterfaceSettings"],
	["integrations", "IntegrationsSettings"],
];

/** Typed members the strict validator (src/core/config.ts) refuses in a settings file. */
const SETTINGS_NOT_ACCEPTED: ReadonlySet<string> = new Set([
	// WorkerTarget.node is a fleet profile pin; validateRoute admits it for profiles only.
	"chat.node",
	"fleet.default.node",
	// Populated by the endpoint probe, refused by validateCapabilities.
	"targets[].capabilities.parallelSlots",
]);

/** Paths whose value is a map or list DEFAULT_SETTINGS holds empty; the leaf default is the empty container. */
const SETTINGS_CONTAINER_LEAVES = new Set([
	"targets",
	"fleet.nodes",
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.adaptiveRouting.agentRoles",
	"integrations.externalAgents.entries",
	"interface.keybindings",
]);

function settingsLeaves(value: unknown, prefix = ""): Array<[string, string]> {
	if (prefix.length > 0 && SETTINGS_CONTAINER_LEAVES.has(prefix)) return [[prefix, JSON.stringify(value)]];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return prefix.length > 0 ? [[prefix, JSON.stringify(value)]] : [];
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return prefix.length > 0 ? [[prefix, JSON.stringify(value)]] : [];
	return entries.flatMap(([key, child]) => settingsLeaves(child, prefix ? `${prefix}.${key}` : key));
}

/** Line of every dotted key in the DEFAULT_SETTINGS_YAML block, by walking its indentation. */
function yamlKeyLines(text: string): Map<string, number> {
	const start = text.indexOf("DEFAULT_SETTINGS_YAML");
	const lines = text.slice(start).split("\n");
	const baseLine = lineOf(text, start);
	const stack: string[] = [];
	const out = new Map<string, number>();
	lines.forEach((line, index) => {
		const match = line.match(/^( *)([a-zA-Z0-9_]+):/);
		if (!match?.[2]) return;
		const depth = (match[1] ?? "").length / 2;
		stack.length = depth;
		stack[depth] = match[2];
		out.set(stack.join("."), baseLine + index);
	});
	return out;
}

function collectSettings(c: Collector, root: string): void {
	const table = readInterfaces(root, [
		"src/core/defaults.ts",
		"src/domains/providers/types/target-descriptor.ts",
		"src/domains/providers/types/capability-flags.ts",
	]);
	const defaultsPath = "src/core/defaults.ts";
	const defaultsText = readFileSync(join(root, defaultsPath), "utf8");
	const keyLines = yamlKeyLines(defaultsText);
	for (const [path, fallback] of settingsLeaves(DEFAULT_SETTINGS)) {
		const line = keyLines.get(path) ?? lineOf(defaultsText, defaultsText.indexOf("DEFAULT_SETTINGS_YAML"));
		c.add({ kind: "setting", name: path, default: fallback }, { path: defaultsPath, line });
	}
	for (const [path, shape] of SETTINGS_SHAPES) {
		expandType(table, shape, path, (subPath, site, doc) => {
			if (subPath === path || SETTINGS_NOT_ACCEPTED.has(subPath)) return;
			const knob: Omit<SourceKnob, "sites"> = { kind: "setting", name: subPath };
			if (doc) knob.description = doc;
			c.add(knob, site ?? null);
		});
	}
}

// ---------------------------------------------------------------------------
// tool-arg
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function walkSchema(schema: JsonSchema, prefix: string, emit: (path: string, node: JsonSchema) => void): void {
	const defs = schema.$defs as Record<string, JsonSchema> | undefined;
	if (defs) {
		for (const [name, def] of Object.entries(defs)) {
			emit(`${prefix}.$defs.${name}`, def);
			walkSchema(def, `${prefix}.$defs.${name}`, emit);
		}
	}
	const properties = schema.properties as Record<string, JsonSchema> | undefined;
	if (properties) {
		for (const [name, child] of Object.entries(properties)) {
			emit(`${prefix}.${name}`, child);
			walkSchema(child, `${prefix}.${name}`, emit);
		}
	}
	const items = schema.items as JsonSchema | undefined;
	if (items) walkSchema(items, `${prefix}[]`, emit);
	const anyOf = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
	if (anyOf) for (const variant of anyOf) walkSchema(variant, prefix, emit);
}

function schemaDefault(node: JsonSchema): string | undefined {
	if (node.$ref) return `ref ${String(node.$ref)}`;
	if (Array.isArray(node.enum)) return `enum ${(node.enum as unknown[]).map(String).join("|")}`;
	if (node.const !== undefined) return `literal ${JSON.stringify(node.const)}`;
	if (Array.isArray(node.anyOf)) {
		const literals = (node.anyOf as JsonSchema[]).filter((v) => v.const !== undefined).map((v) => String(v.const));
		if (literals.length > 0) return `enum ${literals.join("|")}`;
	}
	return typeof node.type === "string" ? node.type : undefined;
}

async function loadToolSchemas(): Promise<Map<string, { schema: JsonSchema; path: string }>> {
	const out = new Map<string, { schema: JsonSchema; path: string }>();
	const dispatchModule = await import("../../src/tools/dispatch.js");
	const dispatch = dispatchModule.createDispatchTool({ getAgentSpecs: () => [] } as never);
	out.set(dispatch.name, { schema: dispatch.parameters as JsonSchema, path: "src/tools/dispatch-schema.ts" });
	const bash = await import("../../src/tools/bash.js");
	out.set(bash.bashTool.name, { schema: bash.bashTool.parameters as JsonSchema, path: "src/tools/bash.ts" });
	const context = await import("../../src/tools/context/index.js");
	const contextTool = context.createContextTool({});
	out.set(contextTool.name, { schema: contextTool.parameters as JsonSchema, path: "src/tools/context/surface.ts" });
	const verify = await import("../../src/tools/verify/surface.js");
	out.set(verify.verifyToolSurface.name, {
		schema: verify.verifyToolSurface.parameters as JsonSchema,
		path: "src/tools/verify/surface.ts",
	});
	return out;
}

async function collectToolArgs(c: Collector, root: string, scopes: ReadonlyArray<string>): Promise<void> {
	const schemas = await loadToolSchemas();
	for (const tool of scopes) {
		const found = schemas.get(tool);
		if (!found) throw new Error(`knob registry: no schema loader for tool '${tool}'`);
		const text = readFileSync(join(root, found.path), "utf8");
		walkSchema(found.schema, tool, (path, node) => {
			const leaf = path.replace(/\[\]$/, "").split(".").at(-1) ?? path;
			const index = text.indexOf(`${leaf}:`);
			const site = { path: found.path, line: index >= 0 ? lineOf(text, index) : 1 };
			const knob: Omit<SourceKnob, "sites"> = { kind: "tool-arg", name: path };
			const def = schemaDefault(node);
			if (def !== undefined) knob.default = def;
			if (typeof node.description === "string") knob.description = node.description;
			c.add(knob, site);
		});
	}
}

// ---------------------------------------------------------------------------
// recipe-key
// ---------------------------------------------------------------------------

function functionBody(text: string, name: string): { body: string; offset: number } {
	const start = text.indexOf(`function ${name}(`);
	if (start < 0) return { body: "", offset: 0 };
	let depth = 0;
	let i = text.indexOf("{", start);
	const bodyStart = i;
	for (; i < text.length; i += 1) {
		if (text[i] === "{") depth += 1;
		else if (text[i] === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	return { body: text.slice(bodyStart, i + 1), offset: bodyStart };
}

function collectRecipeKeys(c: Collector, root: string): void {
	const schemaPath = "src/domains/agents/recipe-schema.ts";
	const schemaText = readFileSync(join(root, schemaPath), "utf8");
	for (const key of [...RECIPE_KEYS, ...OPTIONAL_RECIPE_KEYS]) {
		const index = schemaText.indexOf(`"${key}"`);
		c.add({ kind: "recipe-key", name: key }, { path: schemaPath, line: index >= 0 ? lineOf(schemaText, index) : 1 });
	}
	const nested: ReadonlyArray<[string, string, string]> = [
		["tools", "src/domains/agents/recipe-schema.ts", "parseTools"],
		["budget", "src/domains/agents/recipe.ts", "parseAgentBudget"],
		["budget.maximum", "src/domains/agents/recipe.ts", "parseAgentBudgetPhase"],
		["resultContract", "src/domains/agents/result-contract.ts", "parseContract"],
	];
	for (const [prefix, path, fn] of nested) {
		const text = readFileSync(join(root, path), "utf8");
		const { body, offset } = functionBody(text, fn);
		for (const match of body.matchAll(/\brecord\.([a-zA-Z]+)/g)) {
			const key = match[1];
			if (!key) continue;
			c.add({ kind: "recipe-key", name: `${prefix}.${key}` }, { path, line: lineOf(text, offset + (match.index ?? 0)) });
		}
	}
}

// ---------------------------------------------------------------------------
// fragment-key
// ---------------------------------------------------------------------------

function collectFragmentKeys(c: Collector, root: string): void {
	const loaderPath = "src/domains/prompts/fragment-loader.ts";
	const loaderText = readFileSync(join(root, loaderPath), "utf8");
	for (const match of loaderText.matchAll(/\bfm\.([a-zA-Z]+)/g)) {
		const key = match[1];
		if (key) c.add({ kind: "fragment-key", name: key }, { path: loaderPath, line: lineOf(loaderText, match.index ?? 0) });
	}
	const fragmentsDir = join(root, "src", "domains", "prompts", "fragments");
	for (const file of walkFiles(fragmentsDir, (f) => f.endsWith(".md"))) {
		const text = readFileSync(file, "utf8");
		const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match?.[1]) continue;
		const parsed = parseYaml(match[1]) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") continue;
		for (const key of Object.keys(parsed)) {
			const index = text.indexOf(`\n${key}:`);
			c.add({ kind: "fragment-key", name: key }, { path: c.rel(file), line: index >= 0 ? lineOf(text, index + 1) : 1 });
		}
	}
}

// ---------------------------------------------------------------------------
// model-tag
// ---------------------------------------------------------------------------

/** Key segments that are data (a tier name, a level, a runtime id), not schema. */
const MODEL_TAG_VARIABLE_PARENTS = new Set([
	"quirks.gpuTiers",
	"quirks.thinking.effortByLevel",
	"quirks.thinking.budgetByLevel",
	"quirks.runtimePreference",
	"quirks.llamaCpp.chatTemplateKwargs",
]);

function collectModelTags(c: Collector, root: string): void {
	const dir = join(root, "src", "domains", "providers", "models");
	for (const file of walkFiles(dir, (f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
		const text = readFileSync(file, "utf8");
		const path = c.rel(file);
		const doc = parseYaml(text) as unknown;
		const entries = Array.isArray(doc) ? doc : [doc];
		const walk = (value: unknown, prefix: string): void => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				const name = MODEL_TAG_VARIABLE_PARENTS.has(prefix)
					? `${prefix}.<${prefix.split(".").at(-1)}>`
					: prefix
						? `${prefix}.${key}`
						: key;
				const index = text.search(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"));
				c.add({ kind: "model-tag", name }, { path, line: index >= 0 ? lineOf(text, index) : 1 });
				walk(child, name);
			}
		};
		for (const entry of entries) walk(entry, "");
	}
}

// ---------------------------------------------------------------------------
// constant
// ---------------------------------------------------------------------------

const CONSTANT_DECL = /^(?:export )?const ([A-Z][A-Z0-9_]+)\s*(?::\s*[a-zA-Z<>|\s]+)?=\s*([^;]+?)\s*(?:as const)?;/gm;

function evaluateNumeric(expression: string, known: Map<string, number>): number | undefined {
	const substituted = expression.replace(/\b[A-Z][A-Z0-9_]+\b/g, (name) => {
		const value = known.get(name);
		return value === undefined ? "NaN" : String(value);
	});
	if (!/^[\d_\s+\-*/().e]+$/.test(substituted) || substituted.includes("NaN")) return undefined;
	try {
		const value = Function(`"use strict"; return (${substituted.replace(/_/g, "")});`)() as unknown;
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The doc comment or line comments immediately above an offset, folded to one line. */
function commentAbove(text: string, offset: number): string | undefined {
	const before = text.slice(0, offset).split("\n");
	const lines: string[] = [];
	for (let i = before.length - 1; i >= 0; i -= 1) {
		const line = (before[i] ?? "").trim();
		if (line.length === 0 && lines.length === 0) continue;
		if (line.startsWith("//")) {
			lines.unshift(line.replace(/^\/\/\s?/, ""));
			continue;
		}
		if (line.endsWith("*/") || line.startsWith("*") || line.startsWith("/**")) {
			lines.unshift(line.replace(/^\/\*\*\s?|^\*\/?\s?|\s?\*\/$/g, "").trim());
			if (line.startsWith("/**")) break;
			continue;
		}
		break;
	}
	const folded = lines.join(" ").replace(/\s+/g, " ").trim();
	return folded.length > 0 ? folded : undefined;
}

function collectConstants(c: Collector, root: string, scopes: ReadonlyArray<string>): void {
	for (const path of scopes) {
		const text = readFileSync(join(root, path), "utf8");
		const known = new Map<string, number>();
		for (const match of text.matchAll(CONSTANT_DECL)) {
			const name = match[1];
			const expression = match[2];
			if (!name || !expression) continue;
			const value = evaluateNumeric(expression, known);
			if (value === undefined) continue;
			known.set(name, value);
			if (/_VERSION$/.test(name)) continue;
			const knob: Omit<SourceKnob, "sites"> = { kind: "constant", name, source: path, default: String(value) };
			const description = commentAbove(text, match.index ?? 0);
			if (description) knob.description = description;
			c.add(knob, { path, line: lineOf(text, match.index ?? 0) });
		}
	}
}

// ---------------------------------------------------------------------------
// project-file: the loaders, so a registered key can be held against its reader
// ---------------------------------------------------------------------------

export const PROJECT_FILE_LOADERS: Readonly<Record<string, ReadonlyArray<string>>> = {
	".clio-coder/settings.yaml": ["src/core/settings-layers.ts"],
	".clio-coder/settings.local.yaml": ["src/core/settings-layers.ts"],
	".clio-coder/safety.yaml": ["src/domains/safety/project-policy.ts", "src/domains/safety/default-path-policy.ts"],
	".clio-coder/verifiers.yaml": ["src/tools/verify/catalog.ts"],
	".clio-coder/validation.yaml": ["src/domains/safety/rigor.ts"],
	".clio-coder/profile.yaml": ["src/domains/context/operator-profile.ts"],
	".clio-coder/hooks.yaml": ["src/domains/middleware/hooks.ts", "src/domains/middleware/hooks-io.ts"],
	".clio-coder/hooks.local.yaml": ["src/domains/middleware/hooks.ts", "src/domains/middleware/hooks-io.ts"],
	".clio-coder/rules": ["src/domains/context/project-rules.ts"],
	".clio-coder/agents": ["src/domains/agents/registry.ts", "src/domains/agents/manifest.ts"],
	".clio-coder/skills": ["src/domains/resources/skills/loader.ts"],
	".clio-coder/fleets": ["src/domains/agents/fleet-contract.ts"],
	".clio-coder/prompts": ["src/domains/resources/prompts/loader.ts", "src/interactive/overlays/prompts.ts"],
};

/** Where a registered project-file key is read: the loader line that names its last segment. */
export function projectFileSites(root: string, file: string, name: string): SourceSite[] {
	const loaders = PROJECT_FILE_LOADERS[file];
	if (!loaders) return [];
	// A parenthesized name describes the file as a whole rather than one key; cite the loader itself.
	if (name.startsWith("(")) return loaders.map((path) => ({ path, line: 1 }));
	const leaf = name.replace(/\[\]$/, "").split(".").at(-1) ?? name;
	const sites: SourceSite[] = [];
	for (const path of loaders) {
		let text: string;
		try {
			text = readFileSync(join(root, path), "utf8");
		} catch {
			continue;
		}
		const pattern = new RegExp(`(?:["'\`.]|\\b)${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:["'\`:\\b]|\\b)`);
		const index = text.search(pattern);
		if (index >= 0) sites.push({ path, line: lineOf(text, index) });
	}
	return sites;
}

// ---------------------------------------------------------------------------

export async function collectSourceKnobs(root: string, scopes: SourceScopes): Promise<SourceInventory> {
	const c = new Collector(root);
	const srcFiles = walkFiles(join(root, "src"), isTs);
	collectEnv(c, srcFiles);
	const unmappedCliFiles = collectFlags(c, root);
	collectSettings(c, root);
	await collectToolArgs(c, root, scopes.toolArgScopes);
	collectRecipeKeys(c, root);
	collectFragmentKeys(c, root);
	collectModelTags(c, root);
	collectConstants(c, root, scopes.constantScopes);
	const knobs = [...c.knobs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
	return { knobs, unmappedCliFiles };
}

export function kindsInInventory(inventory: SourceInventory): Record<KnobKind, number> {
	const counts = {} as Record<KnobKind, number>;
	for (const knob of inventory.knobs) counts[knob.kind] = (counts[knob.kind] ?? 0) + 1;
	return counts;
}
