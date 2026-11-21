/**
 * Another agent's lifecycle hooks (Claude Code `settings.json` and
 * `hooks/hooks.json`, Codex `hooks/hooks.json`; both use the same
 * `{hooks: {<Event>: [{matcher, hooks: [{type: "command", command, timeout}]}]}}`
 * shape) ported onto Clio's command hooks: the same shell command, fed the
 * event as JSON on stdin, blocking with exit 2. A user source lands in the
 * user's `<config>/hooks.yaml`; a project source lands in the project's
 * `.clio-coder/hooks.yaml`, which keeps its own workspace-trust review.
 * What Clio cannot state the same way (a regex matcher, an MCP tool matcher,
 * a prompt-type hook, an event Clio has no point for) is skipped and named.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { clioProjectRoot } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { ToolNames } from "../../core/tool-names.js";
import { clioConfigDir } from "../../core/xdg.js";
import {
	loadUserHooks,
	USER_HOOK_COMMAND_TIMEOUT_MAX_MS,
	USER_HOOKS_FILENAME,
	type UserHookOrigin,
} from "../middleware/index.js";
import { inventoryText } from "./inventory.js";
import type { InteropAgentId, InteropInventoryItem } from "./types.js";

/** A Clio hook declaration as `hooks.yaml` spells it. */
export type PortedHookDeclaration = Record<string, unknown> & { id: string; argv: string[] };

export type HookAdoptionMapping =
	| { ok: true; hooks: PortedHookDeclaration[]; destination: string; digest: string; notes: string[] }
	| { ok: false; reason: string };

const EVENTS: Readonly<
	Record<string, { on: "before_tool" | "after_tool" | "turn_start" | "turn_end"; as: string; once?: "session" }>
> = {
	PreToolUse: { on: "before_tool", as: "none" },
	PostToolUse: { on: "after_tool", as: "none" },
	// The agents add a prompt or session hook's output to the model's context, as a Clio reminder does.
	UserPromptSubmit: { on: "turn_start", as: "reminder" },
	SessionStart: { on: "turn_start", as: "reminder", once: "session" },
	Stop: { on: "turn_end", as: "none" },
};

/** Claude Code and Codex tool names to Clio's. */
const TOOLS: Readonly<Record<string, string>> = {
	Bash: ToolNames.Bash,
	shell: ToolNames.Bash,
	Read: ToolNames.Read,
	Write: ToolNames.Write,
	Edit: ToolNames.Edit,
	MultiEdit: ToolNames.Edit,
	apply_patch: ToolNames.Edit,
	Glob: ToolNames.Find,
	Grep: ToolNames.Grep,
	LS: ToolNames.Ls,
	WebFetch: ToolNames.WebFetch,
	Task: ToolNames.Dispatch,
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slug(text: string): string {
	return text
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
}

/** The Clio tool list a matcher names, with the payload names scripts expect; a string is why it cannot. */
function mapMatcher(matcher: unknown): { tools?: string[]; toolNameMap: Record<string, string> } | string {
	const reverse = (names: ReadonlyArray<string>): Record<string, string> => {
		const map: Record<string, string> = {};
		for (const name of names) {
			const clio = TOOLS[name];
			if (clio !== undefined && map[clio] === undefined) map[clio] = name;
		}
		return map;
	};
	if (matcher === undefined || matcher === "" || matcher === "*") return { toolNameMap: reverse(Object.keys(TOOLS)) };
	if (typeof matcher !== "string") return "its matcher is not a string";
	if (!/^[A-Za-z_]+(\|[A-Za-z_]+)*$/.test(matcher))
		return `its matcher ${JSON.stringify(matcher)} is a pattern, not a list of tool names`;
	const names = matcher.split("|");
	const unknown = names.filter((name) => TOOLS[name] === undefined);
	if (unknown.length > 0) return `CLIO Coder has no tool matching ${unknown.join(", ")}`;
	return { tools: [...new Set(names.map((name) => TOOLS[name] as string))], toolNameMap: reverse(names) };
}

function destinationOf(scope: "user" | "project", cwd: string): { path: string; origin: UserHookOrigin; root: string } {
	if (scope === "user") return { path: path.join(clioConfigDir(), USER_HOOKS_FILENAME), origin: "user", root: cwd };
	const root = clioProjectRoot(cwd, USER_HOOKS_FILENAME);
	return { path: path.join(root, ".clio-coder", USER_HOOKS_FILENAME), origin: "project", root };
}

/** Port every hook of one inventoried event, each validated by Clio's own hook loader. */
export function mapForeignHooks(item: InteropInventoryItem, host: InteropAgentId, cwd: string): HookAdoptionMapping {
	const event = EVENTS[item.name];
	if (event === undefined) return { ok: false, reason: `Not adoptable: CLIO Coder has no hook point for ${item.name}.` };
	let groups: unknown;
	try {
		const data: unknown = JSON.parse(inventoryText(item.path));
		groups = record(data) && record(data.hooks) ? data.hooks[item.name] : undefined;
	} catch (error) {
		return { ok: false, reason: `Cannot read ${item.path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!Array.isArray(groups)) return { ok: false, reason: `Not adoptable: ${item.name} is not a list of hook groups.` };
	const destination = destinationOf(item.scope, cwd);
	const hooks: PortedHookDeclaration[] = [];
	const notes: string[] = [];
	const capSeconds = USER_HOOK_COMMAND_TIMEOUT_MAX_MS / 1000;
	groups.forEach((group, groupIndex) => {
		const where = `${item.name}[${groupIndex}]`;
		if (!record(group) || !Array.isArray(group.hooks)) {
			notes.push(`${where} skipped: no hooks list`);
			return;
		}
		let tools: { tools?: string[]; toolNameMap: Record<string, string> } | undefined;
		if (event.on === "before_tool" || event.on === "after_tool") {
			const mapped = mapMatcher(group.matcher);
			if (typeof mapped === "string") {
				notes.push(`${where} skipped: ${mapped}`);
				return;
			}
			tools = mapped;
		} else if (
			item.name === "SessionStart" &&
			typeof group.matcher === "string" &&
			group.matcher !== "" &&
			!group.matcher.split("|").includes("startup")
		) {
			notes.push(`${where} skipped: it runs only on ${group.matcher}, and CLIO Coder runs it at the start of a session`);
			return;
		}
		group.hooks.forEach((entry, index) => {
			const at = `${where}.hooks[${index}]`;
			if (!record(entry) || entry.type !== "command" || typeof entry.command !== "string" || !entry.command.trim()) {
				notes.push(`${at} skipped: only command hooks run in CLIO Coder`);
				return;
			}
			const seconds = typeof entry.timeout === "number" && entry.timeout > 0 ? entry.timeout : 60;
			if (seconds > capSeconds) notes.push(`${at} runs at most ${capSeconds} s; the source allowed ${seconds} s`);
			// Claude Code hands its hooks the project root as CLAUDE_PROJECT_DIR; a Clio hook starts there.
			const command = /\bCLAUDE_PROJECT_DIR\b/.test(entry.command)
				? `CLAUDE_PROJECT_DIR="$PWD"; export CLAUDE_PROJECT_DIR; ${entry.command}`
				: entry.command;
			hooks.push({
				id: `${host}-${slug(item.name)}-${groupIndex}-${index}`,
				on: event.on,
				kind: "command",
				argv: ["/bin/sh", "-c", command],
				timeoutMs: Math.min(USER_HOOK_COMMAND_TIMEOUT_MAX_MS, Math.round(seconds * 1000)),
				as: event.as,
				eventName: item.name,
				...(tools?.tools ? { tools: tools.tools } : {}),
				...(tools && Object.keys(tools.toolNameMap).length > 0 ? { toolNameMap: tools.toolNameMap } : {}),
				...(event.once ? { once: event.once } : {}),
			});
		});
	});
	if (hooks.length === 0)
		return {
			ok: false,
			reason: `Not adoptable: no hook of ${item.name} ports (${notes.join("; ") || "none declared"}).`,
		};
	const loaded = loadUserHooks(
		[{ source: { origin: destination.origin, sourcePath: destination.path }, declarations: hooks }],
		{
			workspaceRoot: destination.root,
		},
	);
	const problems = loaded.issues.flatMap((issue) => issue.issues);
	if (problems.length > 0) return { ok: false, reason: `Not adoptable as a Clio hook: ${problems.join("; ")}.` };
	return {
		ok: true,
		hooks,
		destination: destination.path,
		digest: createHash("sha256").update(JSON.stringify(hooks)).digest("hex"),
		notes,
	};
}

function existingDeclarations(destination: string): unknown[] | string {
	if (!existsSync(destination)) return [];
	const document = parseDocument(inventoryText(destination));
	if (document.errors.length > 0) return `${destination} is not valid YAML; fix it before adopting hooks.`;
	const value: unknown = document.toJS();
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value;
	if (record(value) && Array.isArray(value.hooks)) return value.hooks;
	return `${destination} is neither a list of hooks nor a map with a hooks list.`;
}

/** Why the destination already settles these hooks, or null when they can be added. */
export function hookDestinationConflict(
	hooks: ReadonlyArray<PortedHookDeclaration>,
	destination: string,
): string | null {
	let existing: unknown[] | string;
	try {
		existing = existingDeclarations(destination);
	} catch (error) {
		return `Cannot read ${destination}: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (typeof existing === "string") return existing;
	const byId = new Map(existing.filter(record).map((entry) => [entry.id, entry]));
	const present = hooks.filter((hook) => byId.has(hook.id));
	if (present.length === 0) return null;
	if (
		present.length === hooks.length &&
		present.every((hook) => JSON.stringify(byId.get(hook.id)) === JSON.stringify(hook))
	)
		return "Already declared: same hooks in the Clio hooks file.";
	return `Hook id collision: ${present.map((hook) => hook.id).join(", ")} already declared in ${destination}; existing content will not be replaced.`;
}

/** Append the reviewed hooks, re-checking the source and the merged file. */
export function applyHookAdoption(
	item: InteropInventoryItem,
	host: InteropAgentId,
	cwd: string,
	reviewedDigest: string,
): { ok: true; destination: string } | { ok: false; reason: string } {
	const current = mapForeignHooks(item, host, cwd);
	if (!current.ok) return current;
	if (current.digest !== reviewedDigest)
		return { ok: false, reason: "Source changed after review; inspect a new plan." };
	const conflict = hookDestinationConflict(current.hooks, current.destination);
	if (conflict !== null) return { ok: false, reason: conflict };
	let text: string;
	const document = existsSync(current.destination) ? parseDocument(inventoryText(current.destination)) : null;
	const value: unknown = document?.toJS();
	if (document !== null && (record(value) || Array.isArray(value))) {
		// Edited as a document so the operator's comments and order survive.
		for (const hook of current.hooks) {
			if (record(value)) document.addIn(["hooks"], document.createNode(hook));
			else document.add(document.createNode(hook));
		}
		text = document.toString();
	} else text = stringifyYaml(current.hooks);
	const destination = destinationOf(item.scope, cwd);
	const merged = existingDeclarations(current.destination);
	const kept = Array.isArray(merged) ? merged : [];
	const check = loadUserHooks(
		[{ source: { origin: destination.origin, sourcePath: destination.path }, declarations: parseDocument(text).toJS() }],
		{ workspaceRoot: destination.root },
	);
	// The operator's own hooks are theirs to fix; only the ported ones must load.
	const problems = check.issues.filter((issue) => issue.index >= kept.length).flatMap((issue) => issue.issues);
	if (problems.length > 0) return { ok: false, reason: `Merged hooks would be invalid: ${problems.join("; ")}.` };
	safeResourceWrite(current.destination, text, { mode: 0o600 });
	return { ok: true, destination: current.destination };
}
