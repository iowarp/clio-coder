import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { sha256Hex, stableJson } from "./hash.js";
import type {
	ComponentAuthority,
	ComponentKind,
	ComponentReloadClass,
	ComponentSnapshot,
	ComponentSnapshotOptions,
	HarnessComponent,
} from "./types.js";

const KIND_ORDER: ReadonlyArray<ComponentKind> = [
	"prompt-fragment",
	"agent-recipe",
	"tool-implementation",
	"tool-helper",
	"runtime-descriptor",
	"safety-rule-pack",
	"config-schema",
	"session-schema",
	"receipt-schema",
	"context-file",
	"doc-spec",
	"middleware",
	"memory",
	"eval-suite",
];

const AUTHORITY_BY_KIND: Record<ComponentKind, ComponentAuthority> = {
	"prompt-fragment": "advisory",
	"context-file": "advisory",
	"tool-implementation": "enforcing",
	"tool-helper": "enforcing",
	middleware: "enforcing",
	"agent-recipe": "advisory",
	"runtime-descriptor": "runtime-critical",
	"safety-rule-pack": "enforcing",
	"config-schema": "runtime-critical",
	"session-schema": "runtime-critical",
	"receipt-schema": "runtime-critical",
	memory: "advisory",
	"eval-suite": "descriptive",
	"doc-spec": "descriptive",
};

const RELOAD_BY_KIND: Record<ComponentKind, ComponentReloadClass> = {
	"prompt-fragment": "hot",
	"context-file": "hot",
	"tool-implementation": "hot",
	"tool-helper": "restart-required",
	middleware: "restart-required",
	"agent-recipe": "next-dispatch",
	"runtime-descriptor": "restart-required",
	"safety-rule-pack": "restart-required",
	"config-schema": "restart-required",
	"session-schema": "restart-required",
	"receipt-schema": "restart-required",
	memory: "hot",
	"eval-suite": "static",
	"doc-spec": "static",
};

const OWNER_BY_KIND: Record<ComponentKind, string> = {
	"prompt-fragment": "prompts",
	"context-file": "repository",
	"tool-implementation": "tools",
	"tool-helper": "tools",
	middleware: "middleware",
	"agent-recipe": "agents",
	"runtime-descriptor": "providers",
	"safety-rule-pack": "safety",
	"config-schema": "config",
	"session-schema": "session",
	"receipt-schema": "dispatch",
	memory: "memory",
	"eval-suite": "eval",
	"doc-spec": "docs",
};

const TOOL_HELPER_FILES = new Set([
	"src/tools/bootstrap.ts",
	"src/tools/registry.ts",
	"src/tools/self-dev-guards.ts",
	"src/tools/truncate-utf8.ts",
]);

const CONFIG_SCHEMA_FILES: ReadonlyArray<string> = [
	"src/core/defaults.ts",
	"src/core/config.ts",
	"src/domains/config/schema.ts",
];

const SESSION_SCHEMA_FILES: ReadonlyArray<string> = [
	"src/domains/session/entries.ts",
	"src/domains/session/contract.ts",
	"src/engine/session.ts",
];

const RECEIPT_SCHEMA_FILES: ReadonlyArray<string> = [
	"src/domains/dispatch/types.ts",
	"src/domains/dispatch/receipt-integrity.ts",
];

const CONTEXT_FILES: ReadonlyArray<string> = ["CLIO.md", "CONTRIBUTING.md", "SECURITY.md"];

interface RawSafetyPack {
	id: string;
	value: unknown;
}

export async function scanComponents(root: string): Promise<HarnessComponent[]> {
	const absoluteRoot = resolve(root);
	const components: HarnessComponent[] = [];
	components.push(...(await collectRecursive(absoluteRoot, "src/domains/prompts/fragments", ".md", "prompt-fragment")));
	components.push(...(await collectRecursive(absoluteRoot, "src/domains/agents/builtins", ".md", "agent-recipe")));
	components.push(...(await collectTools(absoluteRoot)));
	components.push(
		...(await collectRecursive(absoluteRoot, "src/domains/providers/runtimes", ".ts", "runtime-descriptor")),
	);
	components.push(...(await collectSafetyRulePacks(absoluteRoot)));
	components.push(...(await collectKnownFiles(absoluteRoot, CONFIG_SCHEMA_FILES, "config-schema")));
	components.push(...(await collectKnownFiles(absoluteRoot, SESSION_SCHEMA_FILES, "session-schema")));
	components.push(...(await collectKnownFiles(absoluteRoot, RECEIPT_SCHEMA_FILES, "receipt-schema")));
	components.push(...(await collectKnownFiles(absoluteRoot, CONTEXT_FILES, "context-file")));
	components.push(...(await collectRecursive(absoluteRoot, "docs/specs", ".md", "doc-spec")));
	return sortComponents(components);
}

export async function createComponentSnapshot(options: ComponentSnapshotOptions): Promise<ComponentSnapshot> {
	const root = resolve(options.root);
	const generatedAt = (options.generatedAt ?? new Date()).toISOString();
	return {
		version: 1,
		generatedAt,
		root,
		components: await scanComponents(root),
	};
}

async function collectRecursive(
	root: string,
	dirPath: string,
	extension: string,
	kind: ComponentKind,
): Promise<HarnessComponent[]> {
	const files = await listFiles(join(root, dirPath));
	const matching = files
		.map((filePath) => toRepoPath(root, filePath))
		.filter((repoPath) => repoPath.endsWith(extension))
		.sort((a, b) => a.localeCompare(b));
	return collectKnownFiles(root, matching, kind);
}

async function collectTools(root: string): Promise<HarnessComponent[]> {
	const files = await listFiles(join(root, "src/tools"));
	const repoPaths = files
		.map((filePath) => toRepoPath(root, filePath))
		.filter((repoPath) => repoPath.startsWith("src/tools/") && repoPath.endsWith(".ts"))
		.sort((a, b) => a.localeCompare(b));
	const components: HarnessComponent[] = [];
	for (const repoPath of repoPaths) {
		const kind: ComponentKind = TOOL_HELPER_FILES.has(repoPath) ? "tool-helper" : "tool-implementation";
		const component = await componentFromFile(root, repoPath, kind);
		if (component) components.push(component);
	}
	return components;
}

async function collectKnownFiles(
	root: string,
	paths: ReadonlyArray<string>,
	kind: ComponentKind,
): Promise<HarnessComponent[]> {
	const components: HarnessComponent[] = [];
	for (const repoPath of [...paths].sort((a, b) => a.localeCompare(b))) {
		const component = await componentFromFile(root, repoPath, kind);
		if (component) components.push(component);
	}
	return components;
}

async function componentFromFile(
	root: string,
	repoPath: string,
	kind: ComponentKind,
): Promise<HarnessComponent | null> {
	const absolutePath = join(root, repoPath);
	if (!(await isFile(absolutePath))) return null;
	const content = await readFile(absolutePath);
	return baseComponent({
		id: `${kind}:${repoPath}`,
		kind,
		path: repoPath,
		contentHash: sha256Hex(content),
	});
}

async function collectSafetyRulePacks(root: string): Promise<HarnessComponent[]> {
	const repoPath = "damage-control-rules.yaml";
	const absolutePath = join(root, repoPath);
	if (!(await isFile(absolutePath))) return [];
	const content = await readFile(absolutePath, "utf8");
	const packs = parseSafetyPacks(content);
	return packs
		.map((pack) =>
			baseComponent({
				id: `safety-rule-pack:${pack.id}`,
				kind: "safety-rule-pack",
				path: repoPath,
				contentHash: sha256Hex(stableJson(pack.value)),
				description: `damage-control rule pack: ${pack.id}`,
			}),
		)
		.sort((a, b) => a.id.localeCompare(b.id));
}

function parseSafetyPacks(content: string): RawSafetyPack[] {
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];
	const version = parsed.version;
	if (version === 1) {
		return [{ id: "base", value: { version, rules: parsed.rules ?? [] } }];
	}
	if (version !== 2 || !Array.isArray(parsed.packs)) return [];
	const packs: RawSafetyPack[] = [];
	for (const pack of parsed.packs) {
		if (!isRecord(pack) || typeof pack.id !== "string" || pack.id.length === 0) continue;
		packs.push({ id: pack.id, value: pack });
	}
	return packs.sort((a, b) => a.id.localeCompare(b.id));
}

function baseComponent(input: {
	id: string;
	kind: ComponentKind;
	path: string;
	contentHash: string;
	description?: string;
}): HarnessComponent {
	const component: HarnessComponent = {
		id: input.id,
		kind: input.kind,
		path: input.path,
		ownerDomain: OWNER_BY_KIND[input.kind],
		mutable: true,
		authority: AUTHORITY_BY_KIND[input.kind],
		reloadClass: RELOAD_BY_KIND[input.kind],
		contentHash: input.contentHash,
	};
	if (input.description !== undefined) component.description = input.description;
	return component;
}

async function listFiles(dirPath: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		const fullPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(fullPath)));
			continue;
		}
		if (entry.isFile()) files.push(fullPath);
	}
	return files;
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function toRepoPath(root: string, filePath: string): string {
	const rel = relative(root, filePath);
	const normalized = rel.split(sep).join("/");
	return isAbsolute(normalized) ? normalized : normalized;
}

function sortComponents(components: ReadonlyArray<HarnessComponent>): HarnessComponent[] {
	const kindRank = new Map(KIND_ORDER.map((kind, index) => [kind, index] as const));
	return [...components].sort((a, b) => {
		const rankA = kindRank.get(a.kind) ?? KIND_ORDER.length;
		const rankB = kindRank.get(b.kind) ?? KIND_ORDER.length;
		if (rankA !== rankB) return rankA - rankB;
		const pathOrder = a.path.localeCompare(b.path);
		if (pathOrder !== 0) return pathOrder;
		return a.id.localeCompare(b.id);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
