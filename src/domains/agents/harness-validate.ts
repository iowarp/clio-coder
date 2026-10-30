import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readSettings } from "../../core/config.js";
import { readLayeredSettings } from "../../core/settings-layers.js";
import {
	ALL_TOOL_NAMES,
	isBuiltinToolName,
	isHarnessExtensionToolName,
	isMcpToolName,
	type ToolName,
	ToolNames,
} from "../../core/tool-names.js";
import { captureProjectSurface } from "../../core/workspace-trust.js";
import { clioConfigDir } from "../../core/xdg.js";
import { isWorkerSurfaceExcludedTool } from "../../tools/policy.js";
import { resolvePackageReferences } from "../resources/package-references.js";
import { loadSkills, type Skill, type SkillList } from "../resources/skills/loader.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { AgentRecipe } from "./recipe.js";
import { parseAgentRecipeSchemaIssues } from "./recipe-schema.js";
import { type AgentRecipeDiagnostic, discoverAgentRecipes } from "./registry.js";
import { agentSpecPolicyErrors, normalizeAgentSpec } from "./spec.js";

/**
 * One problem in a repository's runtime harness: a project or user agent
 * recipe, a project or user skill, or the fleet bindings in
 * `.clio-coder/settings.local.yaml`. `file` is workspace-relative when the
 * file sits inside the workspace and absolute otherwise; `field` is the
 * frontmatter key, settings path or `body` the problem is about; `message`
 * says what is wrong and what would fix it, in prose a model that authored
 * the file can act on without the source.
 *
 * The validator never validates Clio's own builtins, plugin recipes or prompt
 * fragments. It reports every problem of every file in one pass so the whole
 * list can be handed back at once.
 */
export interface HarnessIssue {
	file: string;
	field: string;
	message: string;
}

export interface HarnessRecipeFile {
	source: "user" | "project";
	filepath: string;
	raw: string;
}

export interface HarnessLocalSettings {
	path: string;
	/** Parsed `settings.local.yaml`; undefined when absent or unparseable (the layer issue says which). */
	blob: unknown;
	/** Settings-loader issues attributed to this file, already in prose. */
	layerIssues: ReadonlyArray<{ path: string; message: string }>;
}

export interface HarnessInput {
	workspaceRoot: string;
	recipes: ReadonlyArray<HarnessRecipeFile>;
	/** The catalog the registry built for this workspace, every source, and its ignore/override verdicts. */
	catalog: ReadonlyArray<AgentRecipe>;
	catalogDiagnostics: ReadonlyArray<AgentRecipeDiagnostic>;
	/** The skill catalog custom recipes bind against (the registry's own discovery inputs). */
	skills: SkillList;
	/** Skill roots whose files are the operator's to fix: the user and project skill directories. */
	ownedSkillRoots: ReadonlyArray<string>;
	localSettings: HarnessLocalSettings | null;
	targets: ReadonlyArray<{ id: string; wireModels?: ReadonlyArray<string> }>;
	/** Every `fleet.profiles` key a binding may name, effective layers plus the local file's own. */
	profileNames: ReadonlyArray<string>;
	externalAgentIds: ReadonlyArray<string>;
	/** `package.json` script names at the workspace root; null when there is no package.json. */
	packageScripts: ReadonlySet<string> | null;
	fileExists: (absolutePath: string) => boolean;
}

function editDistance(left: string, right: string): number {
	let row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 0; i < left.length; i++) {
		const next = [i + 1];
		for (let j = 0; j < right.length; j++) {
			next.push(Math.min((next[j] ?? 0) + 1, (row[j + 1] ?? 0) + 1, (row[j] ?? 0) + (left[i] === right[j] ? 0 : 1)));
		}
		row = next;
	}
	return row[right.length] ?? 0;
}

/** The closest known name when it is close enough to be a typo, else null. */
function nearest(wanted: string, known: Iterable<string>): string | null {
	const target = wanted.toLowerCase();
	let best: { name: string; distance: number } | null = null;
	for (const name of known) {
		const distance = editDistance(target, name.toLowerCase());
		if (best === null || distance < best.distance || (distance === best.distance && name < best.name)) {
			best = { name, distance };
		}
	}
	if (best === null) return null;
	return best.distance <= Math.max(2, Math.floor(wanted.length / 3)) ? best.name : null;
}

function suggestion(wanted: string, known: Iterable<string>): string {
	const match = nearest(wanted, known);
	return match === null ? "" : ` (did you mean '${match}'?)`;
}

function listOf(values: Iterable<string>, limit = 8): string {
	const all = [...values];
	if (all.length === 0) return "none";
	const shown = all.slice(0, limit).map((value) => `'${value}'`);
	return all.length > limit ? `${shown.join(", ")} and ${all.length - limit} more` : shown.join(", ");
}

function displayPath(workspaceRoot: string, filepath: string): string {
	const relative = path.relative(workspaceRoot, filepath);
	return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? filepath : relative;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip the parser's own `agent recipe: <path>: ` framing: the issue already
 * names the file, so the message should start at what is wrong.
 */
function unframed(message: string, filepath: string): string {
	for (const prefix of [`agent recipe: ${filepath}: `, `agent budget: ${filepath}: `, `frontmatter: ${filepath}: `]) {
		if (message.startsWith(prefix)) return message.slice(prefix.length);
	}
	return message;
}

/**
 * Something a body tells the agent to run. Only an invocation form counts: an
 * interpreter followed by a path, a `./` path, or a package-manager `run`. A
 * bare path in prose is a mention, not an instruction, and a recipe that tells
 * the agent to create `scripts/x.py` must not be told that it is missing.
 */
interface ScriptInvocation {
	text: string;
	kind: "path" | "package-script";
	target: string;
}

const INVOCATION_PATTERN =
	/(?:^|[\s`(;&|])(?:(python3?|node|bash|sh|zsh|tsx|deno run|npx tsx|uv run)\s+((?:-[A-Za-z-]+\s+)*)([^\s`'"();|&<>]+)|(\.\/[^\s`'"();|&<>]+)|(pnpm|npm|yarn|bun)\s+run\s+([A-Za-z0-9:_.-]+))/gu;

const EXAMPLE_LEAD = /(?:\be\.g\.|\bfor example\b|\bexample\b|\bsuch as\b)[^\n]*$/iu;
/** A lead-in on the same line that makes the path something to produce, not something to run. */
const AUTHORING_LEAD =
	/\b(?:creat(?:e|es|ed|ing)|writ(?:e|es|ten|ing)|sav(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|add(?:s|ed|ing)?)\b[^\n]*$/iu;

const SCRIPT_EXTENSIONS = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".sh", ".bash", ".zsh", ".rb", ".pl"]);

function looksLikeLocalPath(candidate: string): boolean {
	if (/[$*?{}[\]<>]/u.test(candidate)) return false;
	if (path.isAbsolute(candidate) || candidate.startsWith("~")) return false;
	if (candidate.startsWith("./") || candidate.includes("/")) return true;
	return SCRIPT_EXTENSIONS.has(path.extname(candidate));
}

function scriptInvocations(body: string): ScriptInvocation[] {
	const out: ScriptInvocation[] = [];
	const seen = new Set<string>();
	for (const match of body.matchAll(INVOCATION_PATTERN)) {
		const [, interpreter, flags, interpreterPath, dotPath, manager, scriptName] = match;
		// "e.g. `node --test test/x.test.js`" illustrates a form; it tells the agent to run nothing.
		// "create `scripts/new.py`" or "write the report to `./out/x.md`" produce
		// the path; only a lead-in free of both forms tells the agent to run it.
		const lead = body.slice(Math.max(0, (match.index ?? 0) - 48), match.index);
		if (EXAMPLE_LEAD.test(lead) || AUTHORING_LEAD.test(lead)) continue;
		let invocation: ScriptInvocation | null = null;
		if (interpreter !== undefined && interpreterPath !== undefined) {
			if (
				interpreterPath.startsWith("-") ||
				!looksLikeLocalPath(interpreterPath) ||
				!(interpreterPath.startsWith("./") || SCRIPT_EXTENSIONS.has(path.extname(interpreterPath)))
			)
				continue;
			invocation = {
				text: `${interpreter} ${flags ?? ""}${interpreterPath}`.replace(/\s+/gu, " ").trim(),
				kind: "path",
				target: interpreterPath,
			};
		} else if (dotPath !== undefined) {
			if (!looksLikeLocalPath(dotPath) || !SCRIPT_EXTENSIONS.has(path.extname(dotPath))) continue;
			invocation = { text: dotPath, kind: "path", target: dotPath };
		} else if (manager !== undefined && scriptName !== undefined) {
			invocation = { text: `${manager} run ${scriptName}`, kind: "package-script", target: scriptName };
		}
		if (invocation === null || seen.has(invocation.text)) continue;
		seen.add(invocation.text);
		out.push(invocation);
	}
	return out;
}

function scriptIssues(
	body: string,
	file: string,
	baseDirs: ReadonlyArray<string>,
	input: Pick<HarnessInput, "packageScripts" | "fileExists" | "workspaceRoot">,
): HarnessIssue[] {
	const issues: HarnessIssue[] = [];
	for (const invocation of scriptInvocations(body)) {
		if (invocation.kind === "package-script") {
			if (input.packageScripts === null) continue;
			if (input.packageScripts.has(invocation.target)) continue;
			issues.push({
				file,
				field: "body",
				message: `tells the agent to run \`${invocation.text}\`, but package.json defines no script named '${invocation.target}'${suggestion(invocation.target, input.packageScripts)}; the scripts it defines are ${listOf(input.packageScripts)}`,
			});
			continue;
		}
		const resolved = baseDirs.map((dir) => path.resolve(dir, invocation.target));
		if (resolved.some((candidate) => input.fileExists(candidate))) continue;
		const where =
			baseDirs.length > 1
				? "neither beside the file nor in the repository"
				: `not in the repository at ${displayPath(input.workspaceRoot, resolved[0] ?? invocation.target)}`;
		issues.push({
			file,
			field: "body",
			message: `tells the agent to run \`${invocation.text}\`, but ${invocation.target} does not exist (${where}); add the script or change the instruction to one that exists`,
		});
	}
	return issues;
}

const IGNORE_REASONS: Record<string, (id: string, source: string) => string> = {
	"reserved-agent-id": (id) =>
		`'${id}' is a reserved agent id (worker, delegate and auto are owned by dispatch); the recipe is ignored, so rename the file`,
	"reserved-builtin": (id, source) =>
		`'${id}' is the id of a recipe Clio ships; a ${source} recipe with a builtin id is ignored, not applied, so rename the file to a new id`,
	"reserved-shadow": (id) =>
		`'${id}' names a shadow builtin reserved for Clio's internal orchestration; a user recipe cannot replace it, so rename the file`,
};

/** The non-empty strings in a frontmatter list, whatever else the list holds. */
function rawStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Tool names a `tools` block declares, read leniently so a broken block still names its tools. */
function rawToolNames(frontmatter: Record<string, unknown>): string[] {
	if (!isRecord(frontmatter.tools)) return [];
	const required = Array.isArray(frontmatter.tools.required) ? frontmatter.tools.required : [];
	return [
		...rawStrings(required),
		...required.flatMap((entry: unknown) => (isRecord(entry) ? rawStrings(entry.anyOf) : [])),
		...rawStrings(frontmatter.tools.optional),
	];
}

function recipeIssues(file: HarnessRecipeFile, input: HarnessInput): HarnessIssue[] {
	const issues: HarnessIssue[] = [];
	const display = displayPath(input.workspaceRoot, file.filepath);
	const id = path.basename(file.filepath, ".md");
	const push = (field: string, message: string): void => {
		issues.push({ file: display, field, message });
	};
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(file.raw, file.filepath));
	} catch (error) {
		push("frontmatter", unframed(error instanceof Error ? error.message : String(error), file.filepath));
		return issues;
	}
	try {
		body = resolvePackageReferences(body, { plugin: false });
	} catch (error) {
		push("body", error instanceof Error ? error.message : String(error));
	}
	const parsed = parseAgentRecipeSchemaIssues({ id, source: file.source, filepath: file.filepath, body, frontmatter });
	for (const issue of parsed.issues) push(issue.field, unframed(issue.message, file.filepath));
	const recipe = parsed.recipe;
	// A schema failure must not hide the reference problems: the names are
	// still read from the raw frontmatter so the author fixes everything at once.
	const tools = recipe !== null ? recipe.tools : rawToolNames(frontmatter);
	const skillNames = recipe !== null ? recipe.skills : rawStrings(frontmatter.skills);
	const builtinNames = ALL_TOOL_NAMES as ReadonlyArray<string>;
	for (const tool of new Set(tools)) {
		if (isBuiltinToolName(tool as ToolName)) {
			// dispatch and ask_user are policy's to judge: dispatch is permitted on
			// an orchestration recipe and ask_user is always refused there.
			if (tool === ToolNames.Dispatch || tool === ToolNames.AskUser) continue;
			if (isWorkerSurfaceExcludedTool(tool as ToolName)) {
				push(
					"tools",
					`names tool '${tool}', which exists only on the attended session and never on a worker surface, so a dispatched run of this recipe cannot call it; remove it from tools`,
				);
			}
			continue;
		}
		if (isMcpToolName(tool) || isHarnessExtensionToolName(tool)) continue;
		push(
			"tools",
			`names tool '${tool}', which Clio does not have${suggestion(tool, builtinNames)}; builtin tools are ${listOf(builtinNames, 40)}, and an MCP tool is named mcp_<server>__<tool>`,
		);
	}
	if (recipe !== null) {
		try {
			for (const error of agentSpecPolicyErrors(normalizeAgentSpec(recipe))) push("tools", error);
		} catch (error) {
			push("tools", error instanceof Error ? error.message : String(error));
		}
	}
	const trustedSkills = new Map(input.skills.items.filter((skill) => skill.trusted).map((skill) => [skill.name, skill]));
	for (const skillName of new Set(skillNames)) {
		if (trustedSkills.has(skillName)) continue;
		const untrusted = input.skills.items.find((skill) => skill.name === skillName);
		if (untrusted !== undefined) {
			push(
				"skills",
				`names skill '${skillName}', which exists at ${displayPath(input.workspaceRoot, untrusted.filePath)} but is not trusted, so the recipe cannot bind it and is quarantined; move the skill under .clio-coder/skills/ or trust its root with integrations.projectResources.trustProjectImports`,
			);
			continue;
		}
		push(
			"skills",
			`names skill '${skillName}', which is not in the skill catalog${suggestion(skillName, trustedSkills.keys())}; add .clio-coder/skills/${skillName}/SKILL.md or name one of ${listOf(trustedSkills.keys())}`,
		);
	}
	for (const diagnostic of input.catalogDiagnostics) {
		if (diagnostic.filepath !== file.filepath) continue;
		if (diagnostic.kind === "ignored") {
			const reason = diagnostic.message.slice(diagnostic.message.lastIndexOf(": ") + 2);
			const explain = IGNORE_REASONS[reason];
			push("id", explain ? explain(id, file.source) : diagnostic.message);
		} else if (diagnostic.kind === "overridden") {
			const winner = input.catalog.find((recipe) => recipe.id === id && recipe.source === diagnostic.by);
			push(
				"id",
				`'${id}' is overridden by the ${diagnostic.by ?? "later"} recipe of the same id${winner ? ` at ${displayPath(input.workspaceRoot, winner.filepath)}` : ""}, so this file loads and does nothing; rename one of them`,
			);
		} else if (diagnostic.kind === "quarantine" && issues.length === 0) {
			// Something the schema pass cannot see, such as a bound skill escaping its root.
			push("frontmatter", unframed(diagnostic.message, file.filepath));
		}
	}
	issues.push(...scriptIssues(body, display, [input.workspaceRoot], input));
	return issues;
}

function isUnder(filePath: string, roots: ReadonlyArray<string>): boolean {
	return roots.some((root) => {
		const relative = path.relative(root, filePath);
		return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
	});
}

const SKILL_DIAGNOSTIC_FIELDS: ReadonlyArray<[RegExp, string]> = [
	[/^allowed-tools/u, "allowed-tools"],
	[/^disallowed-tools/u, "disallowed-tools"],
	[/^description/u, "description"],
	[/^name /u, "name"],
	[/requires skill/u, "requires"],
	[/frontmatter/u, "frontmatter"],
];

function skillIssues(input: HarnessInput): HarnessIssue[] {
	const issues: HarnessIssue[] = [];
	const seen = new Set<string>();
	for (const diagnostic of input.skills.diagnostics) {
		if (diagnostic.path === undefined || !isUnder(diagnostic.path, input.ownedSkillRoots)) continue;
		const field = SKILL_DIAGNOSTIC_FIELDS.find(([pattern]) => pattern.test(diagnostic.message))?.[1] ?? "SKILL.md";
		const issue = { file: displayPath(input.workspaceRoot, diagnostic.path), field, message: diagnostic.message };
		const key = `${issue.file}\0${issue.field}\0${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		issues.push(issue);
	}
	const owned = input.skills.items.filter((skill: Skill) => isUnder(skill.filePath, input.ownedSkillRoots));
	for (const skill of owned) {
		issues.push(
			...scriptIssues(
				skill.content,
				displayPath(input.workspaceRoot, skill.filePath),
				[skill.baseDir, input.workspaceRoot],
				input,
			),
		);
	}
	return issues;
}

function modelIssue(
	file: string,
	field: string,
	model: unknown,
	targetId: string,
	input: HarnessInput,
): HarnessIssue | null {
	if (typeof model !== "string" || model.trim().length === 0) return null;
	const target = input.targets.find((entry) => entry.id === targetId);
	if (target === undefined || target.wireModels === undefined || target.wireModels.length === 0) return null;
	if (target.wireModels.includes(model)) return null;
	return {
		file,
		field,
		message: `names model '${model}', which target '${targetId}' does not list${suggestion(model, target.wireModels)}; its recorded models are ${listOf(target.wireModels)}`,
	};
}

function settingsIssues(input: HarnessInput): HarnessIssue[] {
	const local = input.localSettings;
	if (local === null) return [];
	const file = displayPath(input.workspaceRoot, local.path);
	const issues: HarnessIssue[] = local.layerIssues.map((issue) => ({ file, field: issue.path, message: issue.message }));
	if (!isRecord(local.blob) || !isRecord(local.blob.fleet)) return issues;
	const fleet = local.blob.fleet;
	const targetIds = input.targets.map((target) => target.id);
	if (isRecord(fleet.profiles)) {
		for (const [name, profile] of Object.entries(fleet.profiles)) {
			if (!isRecord(profile)) continue;
			const field = `fleet.profiles.${name}`;
			if (typeof profile.target === "string" && !targetIds.includes(profile.target)) {
				issues.push({
					file,
					field: `${field}.target`,
					message: `names target '${profile.target}', which is not configured${suggestion(profile.target, targetIds)}; the profile is dropped silently and every agent bound to it falls back to fleet.default, so use one of ${listOf(targetIds)} or add the target with \`clio-coder targets add\``,
				});
				continue;
			}
			if (typeof profile.target === "string") {
				const issue = modelIssue(file, `${field}.model`, profile.model, profile.target, input);
				if (issue !== null) issues.push(issue);
			}
		}
	}
	if (isRecord(fleet.rosters)) {
		for (const [name, roster] of Object.entries(fleet.rosters)) {
			if (!isRecord(roster) || !Array.isArray(roster.members)) continue;
			for (const [index, member] of roster.members.entries()) {
				if (!isRecord(member) || typeof member.target !== "string") continue;
				const issue = modelIssue(file, `fleet.rosters.${name}.members[${index}].model`, member.model, member.target, input);
				if (issue !== null) issues.push(issue);
			}
		}
	}
	if (isRecord(fleet.agentProfiles)) {
		const recipeIds = new Set(input.catalog.map((recipe) => recipe.id));
		const profileNames = new Set(input.profileNames);
		for (const [rawAgentId, rawProfile] of Object.entries(fleet.agentProfiles)) {
			const agentId = rawAgentId.trim();
			const field = `fleet.agentProfiles.${agentId}`;
			if (agentId.length === 0 || agentId === "auto") continue;
			if (input.externalAgentIds.includes(agentId)) {
				issues.push({
					file,
					field,
					message: `binds '${agentId}', which is an ACP delegation agent; delegation agents ignore native routing, so the binding does nothing and should be removed`,
				});
			} else if (!recipeIds.has(agentId)) {
				issues.push({
					file,
					field,
					message: `binds agent '${agentId}', which is not a loaded recipe${suggestion(agentId, recipeIds)}; the binding does nothing until a recipe with that id loads, so fix the id or add .clio-coder/agents/${agentId}.md (loaded recipes: ${listOf(recipeIds, 12)})`,
				});
			}
			if (typeof rawProfile === "string" && rawProfile.trim().length > 0 && !profileNames.has(rawProfile.trim())) {
				issues.push({
					file,
					field,
					message: `names profile '${rawProfile.trim()}', which fleet.profiles does not define${suggestion(rawProfile.trim(), profileNames)}; dispatch of '${agentId}' fails with "fleet profile not configured", so define the profile or name one of ${listOf(profileNames)}`,
				});
			}
		}
	}
	return issues;
}

/**
 * Every problem in the harness described by `input`, in file order. Pure:
 * reads nothing, throws on nothing a file can contain. An artifact that fails
 * to parse yields one issue for the parse and whatever else can still be said.
 */
export function validateHarness(input: HarnessInput): HarnessIssue[] {
	const issues: HarnessIssue[] = [];
	for (const file of input.recipes) issues.push(...recipeIssues(file, input));
	issues.push(...skillIssues(input));
	issues.push(...settingsIssues(input));
	return issues;
}

/** One line per issue, `file: field: message`, the form a model can be handed verbatim. */
export function formatHarnessIssues(issues: ReadonlyArray<HarnessIssue>): string {
	return issues.map((issue) => `${issue.file}: ${issue.field}: ${issue.message}`).join("\n");
}

function readRecipeDir(dir: string, source: HarnessRecipeFile["source"]): HarnessRecipeFile[] {
	let entries: ReadonlyArray<import("node:fs").Dirent>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		// A missing or unreadable recipe directory is a harness with no recipes there.
		return [];
	}
	const files: HarnessRecipeFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filepath = path.join(dir, entry.name);
		try {
			files.push({ source, filepath, raw: readFileSync(filepath, "utf8") });
		} catch {
			// The registry skips an unreadable file the same way; nothing to validate.
		}
	}
	return files.sort((left, right) => left.filepath.localeCompare(right.filepath));
}

function readPackageScripts(workspaceRoot: string): ReadonlySet<string> | null {
	const file = path.join(workspaceRoot, "package.json");
	if (!existsSync(file)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.scripts)) return new Set();
		return new Set(Object.keys(parsed.scripts));
	} catch {
		// An unparseable package.json is the project's problem, not the harness's; skip the script check.
		return null;
	}
}

export interface CollectHarnessOptions {
	/** Validate only this recipe file (absolute path); the catalog and settings still load so its references resolve. */
	recipeFile?: string;
}

/**
 * Read everything `validateHarness` needs for `workspaceRoot`. The catalog
 * comes from the registry's own discovery, so ignore and override verdicts are
 * the ones dispatch would see; the skill catalog loads with the registry's
 * inputs for custom recipes. Never throws: a loader that fails leaves its part
 * empty and the artifacts still get their own checks.
 */
export function collectHarnessInput(workspaceRoot: string, options: CollectHarnessOptions = {}): HarnessInput {
	let configDir: string | null = null;
	try {
		configDir = clioConfigDir();
	} catch {
		// No resolvable config root: user recipes and skills are simply absent.
	}
	let trustProjectImports = false;
	try {
		trustProjectImports = readSettings().integrations.projectResources.trustProjectImports;
	} catch {
		// Invalid user settings are reported by doctor's settings row; bind against untrusted imports.
	}
	const catalogDiagnostics: AgentRecipeDiagnostic[] = [];
	let catalog: ReadonlyArray<AgentRecipe> = [];
	try {
		catalog = discoverAgentRecipes(workspaceRoot, catalogDiagnostics);
	} catch {
		// A shipped recipe defect aborts discovery; the custom files still get their own pass.
	}
	let skills: SkillList = { items: [], diagnostics: [] };
	try {
		skills = loadSkills({ cwd: workspaceRoot, trustProjectCompatRoots: trustProjectImports });
	} catch (error) {
		skills = {
			items: [],
			diagnostics: [{ type: "error", message: error instanceof Error ? error.message : String(error) }],
		};
	}
	const projectRecipes = readRecipeDir(path.join(workspaceRoot, ".clio-coder", "agents"), "project");
	const userRecipes = configDir === null ? [] : readRecipeDir(path.join(configDir, "agents"), "user");
	const recipes = [...userRecipes, ...projectRecipes].filter(
		(file) => options.recipeFile === undefined || path.resolve(file.filepath) === path.resolve(options.recipeFile),
	);
	const localPath = path.join(workspaceRoot, ".clio-coder", "settings.local.yaml");
	let layered: ReturnType<typeof readLayeredSettings> | null = null;
	let layerFailure: string | null = null;
	try {
		layered = readLayeredSettings(workspaceRoot);
	} catch (error) {
		// The recipe and skill checks do not need the settings stack; the file
		// gets one issue naming the failure instead of a stack trace.
		layerFailure = error instanceof Error ? error.message : String(error);
	}
	let localSettings: HarnessLocalSettings | null = null;
	if (layered === null) {
		if (existsSync(localPath)) {
			localSettings = {
				path: localPath,
				blob: undefined,
				layerIssues: [
					{ path: "(file)", message: `settings could not be read, so its bindings were not checked: ${layerFailure}` },
				],
			};
		}
	} else if (existsSync(localPath)) {
		let blob: unknown;
		try {
			blob = parseYaml(readFileSync(localPath, "utf8"), { maxAliasCount: 100 });
		} catch {
			// The layer issue for this file already names the parse failure.
		}
		const localDisplay = displayPath(workspaceRoot, localPath);
		const layerIssues = layered.issues
			.filter((issue) => issue.origin === "project.local")
			.map((issue) => ({
				path: issue.path === localPath || issue.path === "(root)" ? "(file)" : issue.path,
				message: issue.message.split(`${localPath}: `).join("").split(localPath).join(localDisplay),
			}));
		try {
			const snapshot = captureProjectSurface(workspaceRoot, "settings");
			if (snapshot.verdict !== "trusted" && !layerIssues.some((issue) => issue.message.includes(snapshot.verdict))) {
				layerIssues.unshift({
					path: "(file)",
					message: `the project settings surface is ${snapshot.verdict}, so this file is ignored entirely; review it with \`clio-coder config trust settings\``,
				});
			}
		} catch (error) {
			layerIssues.unshift({
				path: "(file)",
				message: `trust for the project settings surface could not be determined: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		localSettings = { path: localPath, blob, layerIssues };
	}
	const localProfileNames =
		localSettings !== null &&
		isRecord(localSettings.blob) &&
		isRecord(localSettings.blob.fleet) &&
		isRecord(localSettings.blob.fleet.profiles)
			? Object.keys(localSettings.blob.fleet.profiles).filter((name) => name.trim().length > 0)
			: [];
	return {
		workspaceRoot,
		recipes,
		catalog,
		catalogDiagnostics,
		skills,
		ownedSkillRoots: [
			path.join(workspaceRoot, ".clio-coder", "skills"),
			...(configDir === null ? [] : [path.join(configDir, "skills")]),
		],
		localSettings,
		targets: layered?.settings.targets ?? [],
		profileNames: [...new Set([...Object.keys(layered?.settings.fleet.profiles ?? {}), ...localProfileNames])],
		externalAgentIds: layered?.settings.integrations.externalAgents.entries.map((agent) => agent.id) ?? [],
		packageScripts: readPackageScripts(workspaceRoot),
		fileExists: existsSync,
	};
}

/** Collect and validate in one call. */
export function validateHarnessAt(workspaceRoot: string, options: CollectHarnessOptions = {}): HarnessIssue[] {
	return validateHarness(collectHarnessInput(workspaceRoot, options));
}
