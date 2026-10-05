import { createHash } from "node:crypto";
import type {
	ExtensionCapabilityEnvelope,
	ExtensionCommandDeclarationV2,
	ExtensionConfigField,
	ExtensionHookDeclaration,
	ExtensionPermissionsDeclaration,
	ExtensionRuntimeDeclarationV2,
	ExtensionRuntimeToolDeclaration,
	ExtensionSlot,
	ExtensionWorkspaceDeclaration,
} from "./manifest-v2.js";
import type {
	ExtensionContentAccess,
	ExtensionHookPoint,
	ExtensionObservationEventV2,
	WorkspaceRegion,
} from "./public-api-v2.js";
import { RUNTIME_LIMITS } from "./runtime-schema.js";
import { SURFACE_LIMITS } from "./view-limits.js";

export const RUNTIME_V2_LIMITS = {
	commands: 32,
	hooks: 16,
	hookMs: 250,
	hookMsMin: 50,
	hookMsMax: 2000,
	tools: 32,
	toolMs: 30000,
	toolMsMax: 300000,
	tickMsMin: 5000,
	tickMsMax: 3600000,
	workspaces: 4,
	fsEntries: 16,
	configFields: 24,
	configOptions: 16,
} as const;

const EVENTS: ReadonlyArray<Exclude<ExtensionObservationEventV2, "tick">> = [
	"session_open",
	"session_close",
	"turn_start",
	"turn_end",
	"tool_end",
	"permission_requested",
	"permission_resolved",
	"dispatch_started",
	"dispatch_completed",
	"dispatch_failed",
	"compaction_end",
	"budget_alert",
	"safety_blocked",
	"fs_changed",
	"workspace_enter",
	"workspace_leave",
];
const HOOK_POINTS: ReadonlyArray<ExtensionHookPoint> = [
	"prompt_submit",
	"before_tool",
	"after_tool",
	"turn_start",
	"turn_end",
];
const SLOTS: ReadonlyArray<ExtensionSlot> = ["status", "band", "card", "toast", "panel", "dock", "interview"];
const REGIONS: ReadonlyArray<WorkspaceRegion | "islands"> = ["header", "board", "islands", "rail", "footer"];
const ACCESS: ReadonlyArray<ExtensionContentAccess> = ["prompt", "tool-args", "tool-results", "assistant-text"];
const ENTRYPOINT_SUFFIXES = [".mjs", ".ts", ".mts"];

/** Every refusal names the manifest path, so a diagnostic points at the line to fix. */
function fail(path: string, message: string): never {
	throw new Error(`${path} ${message}`);
}
function record(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a known field");
	return raw;
}
function list(value: unknown, path: string, max: number): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail(path, "must be a list");
	if (value.length > max) fail(path, `allows at most ${max} entries`);
	return value;
}
function text(value: unknown, path: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		fail(path, `must be text of 1-${max} characters`);
	return value;
}
function named(value: unknown, path: string, pattern: RegExp, max: number): string {
	const name = text(value, path, max);
	if (!pattern.test(name)) fail(path, `'${name}' is not a valid name`);
	return name;
}
function choice<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback?: T): T {
	if (value === undefined && fallback !== undefined) return fallback;
	if (!allowed.includes(value as T)) fail(path, `must be one of ${allowed.join(", ")}`);
	return value as T;
}
function choices<T extends string>(value: unknown, path: string, allowed: readonly T[]): T[] {
	const entries = list(value, path, allowed.length).map((item, index) => choice(item, `${path}[${index}]`, allowed));
	if (new Set(entries).size !== entries.length) fail(path, "lists a value twice");
	return entries;
}
function flag(value: unknown, path: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") fail(path, "must be true or false");
	return value;
}
function milliseconds(value: unknown, path: string, fallback: number, min: number, max: number): number {
	const ms = value ?? fallback;
	if (!Number.isInteger(ms) || Number(ms) < min || Number(ms) > max) fail(path, `must be ${min}-${max}`);
	return Number(ms);
}
/** A path that stays inside its root: no absolute form, no home shorthand, no parent segment. */
function containedPath(value: unknown, path: string): string {
	const entry = text(value, path, 240);
	if (entry.startsWith("/") || entry.startsWith("~") || /^[A-Za-z]:[\\/]/.test(entry) || entry.includes("\\"))
		fail(path, "must be a relative path");
	if (entry.split("/").some((segment) => segment === ".." || segment === "")) fail(path, "must not leave its root");
	return entry;
}
function duration(value: unknown, path: string): number {
	if (typeof value === "number")
		return milliseconds(value, path, 0, RUNTIME_V2_LIMITS.tickMsMin, RUNTIME_V2_LIMITS.tickMsMax);
	const match = typeof value === "string" ? /^(\d{1,7})(ms|s|m)$/.exec(value) : null;
	if (!match) fail(path, "must be milliseconds or a duration such as 30s");
	const scale = match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : 60000;
	return milliseconds(Number(match[1]) * scale, path, 0, RUNTIME_V2_LIMITS.tickMsMin, RUNTIME_V2_LIMITS.tickMsMax);
}

function parseCommands(value: unknown): ExtensionCommandDeclarationV2[] {
	const names = new Set<string>();
	return list(value, "runtime.commands", RUNTIME_V2_LIMITS.commands).map((item, index) => {
		const path = `runtime.commands[${index}]`;
		const raw = record(item, path, ["name", "description", "timeoutMs", "replaces"]);
		const name = named(raw.name, `${path}.name`, /^[a-z][a-z0-9_-]*$/, 40);
		if (names.has(name)) fail(`${path}.name`, `repeats '${name}'`);
		names.add(name);
		const command: ExtensionCommandDeclarationV2 = {
			name,
			description: text(raw.description, `${path}.description`, 240),
			timeoutMs: milliseconds(raw.timeoutMs, `${path}.timeoutMs`, RUNTIME_LIMITS.commandMs, 100, 300000),
		};
		if (raw.replaces !== undefined) command.replaces = choice(raw.replaces, `${path}.replaces`, ["prompt"]);
		return command;
	});
}

function parseEvents(value: unknown): Pick<ExtensionRuntimeDeclarationV2, "events" | "tickMs"> {
	const events: Array<Exclude<ExtensionObservationEventV2, "tick">> = [];
	let tickMs: number | undefined;
	for (const [index, item] of list(value, "runtime.events", EVENTS.length + 1).entries()) {
		const path = `runtime.events[${index}]`;
		if (typeof item === "string") {
			const event = choice(item, path, EVENTS);
			if (events.includes(event)) fail(path, `repeats '${event}'`);
			events.push(event);
			continue;
		}
		const raw = record(item, path, ["tick"]);
		if (tickMs !== undefined) fail(path, "declares a second tick");
		tickMs = duration(raw.tick, `${path}.tick`);
	}
	return tickMs === undefined ? { events } : { events, tickMs };
}

function parseHooks(value: unknown): ExtensionHookDeclaration[] {
	return list(value, "runtime.hooks", RUNTIME_V2_LIMITS.hooks).map((item, index) => {
		const path = `runtime.hooks[${index}]`;
		const raw = record(item, path, ["on", "tools", "timeoutMs", "onTimeout", "onError"]);
		const on = choice(raw.on, `${path}.on`, HOOK_POINTS);
		const hook: ExtensionHookDeclaration = {
			on,
			timeoutMs: milliseconds(
				raw.timeoutMs,
				`${path}.timeoutMs`,
				RUNTIME_V2_LIMITS.hookMs,
				RUNTIME_V2_LIMITS.hookMsMin,
				RUNTIME_V2_LIMITS.hookMsMax,
			),
			onTimeout: choice(raw.onTimeout, `${path}.onTimeout`, ["pass", "block"], "pass"),
			onError: choice(raw.onError, `${path}.onError`, ["pass", "block"], "pass"),
		};
		if (raw.tools !== undefined) {
			if (on !== "before_tool" && on !== "after_tool") fail(`${path}.tools`, "applies only to a tool hook");
			const tools = list(raw.tools, `${path}.tools`, 32).map((tool, at) =>
				named(tool, `${path}.tools[${at}]`, /^[A-Za-z][A-Za-z0-9_.-]*$/, 64),
			);
			if (tools.length === 0 || new Set(tools).size !== tools.length) fail(`${path}.tools`, "must name each tool once");
			hook.tools = tools;
		}
		return hook;
	});
}

function parseTools(value: unknown): ExtensionRuntimeToolDeclaration[] {
	const names = new Set<string>();
	return list(value, "runtime.tools", RUNTIME_V2_LIMITS.tools).map((item, index) => {
		const path = `runtime.tools[${index}]`;
		const raw = record(item, path, ["name", "description", "inputSchema", "actionClass", "timeoutMs"]);
		// Single underscores only: the qualified name joins the package id with a double one.
		const name = named(raw.name, `${path}.name`, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 40);
		if (names.has(name)) fail(`${path}.name`, `repeats '${name}'`);
		names.add(name);
		const schema = raw.inputSchema;
		if (
			schema === null ||
			typeof schema !== "object" ||
			Array.isArray(schema) ||
			(schema as { type?: unknown }).type !== "object"
		)
			fail(`${path}.inputSchema`, "must be an object schema");
		return {
			name,
			description: text(raw.description, `${path}.description`, 1000),
			inputSchema: schema as Record<string, unknown>,
			actionClass: choice(raw.actionClass, `${path}.actionClass`, ["read", "execute"], "execute"),
			timeoutMs: milliseconds(
				raw.timeoutMs,
				`${path}.timeoutMs`,
				RUNTIME_V2_LIMITS.toolMs,
				100,
				RUNTIME_V2_LIMITS.toolMsMax,
			),
		};
	});
}

function parseWorkspaces(value: unknown): ExtensionWorkspaceDeclaration[] {
	const ids = new Set<string>();
	return list(value, "runtime.workspaces", RUNTIME_V2_LIMITS.workspaces).map((item, index) => {
		const path = `runtime.workspaces[${index}]`;
		const raw = record(item, path, ["id", "title", "regions", "board", "skin", "keys"]);
		const id = named(raw.id, `${path}.id`, /^[a-z][a-z0-9-]*$/, 40);
		if (ids.has(id)) fail(`${path}.id`, `repeats '${id}'`);
		ids.add(id);
		const regions = choices(raw.regions, `${path}.regions`, REGIONS);
		if (regions.length === 0) fail(`${path}.regions`, "must name at least one region");
		const workspace: ExtensionWorkspaceDeclaration = { id, title: text(raw.title, `${path}.title`, 60), regions };
		if (raw.board !== undefined) {
			if (!regions.includes("board")) fail(`${path}.board`, "needs the board region");
			workspace.board = choice(raw.board, `${path}.board`, ["band", "island"]);
		}
		if (raw.skin !== undefined) {
			const skin = containedPath(raw.skin, `${path}.skin`);
			if (!skin.endsWith(".json")) fail(`${path}.skin`, "must be a .json file in the package");
			workspace.skin = skin;
		}
		if (raw.keys !== undefined) {
			const taken = new Set<string>();
			workspace.keys = list(raw.keys, `${path}.keys`, SURFACE_LIMITS.workspaceKeys).map((entry, at) => {
				const keyPath = `${path}.keys[${at}]`;
				const binding = record(entry, keyPath, ["key", "action", "label"]);
				const key = named(binding.key, `${keyPath}.key`, /^[a-z0-9]$/, 1);
				if (taken.has(key)) fail(`${keyPath}.key`, `repeats '${key}'`);
				taken.add(key);
				return {
					key,
					action: named(binding.action, `${keyPath}.action`, /^[a-z][a-z0-9_.-]*$/, 64),
					label: text(binding.label, `${keyPath}.label`, 60),
				};
			});
		}
		return workspace;
	});
}

function parsePermissions(value: unknown): ExtensionPermissionsDeclaration {
	const raw = record(value ?? {}, "runtime.permissions", ["fs", "exec", "net"]);
	const fs = record(raw.fs ?? {}, "runtime.permissions.fs", ["read", "write"]);
	const read = list(fs.read, "runtime.permissions.fs.read", RUNTIME_V2_LIMITS.fsEntries).map((entry, index) => {
		const path = `runtime.permissions.fs.read[${index}]`;
		if (entry === "workspace" || entry === "home") return entry;
		// An absolute read root is allowed and shown as such at consent; a relative one is under the workspace.
		const root = text(entry, path, 240);
		return root.startsWith("/") ? root : containedPath(root, path);
	});
	const write = list(fs.write, "runtime.permissions.fs.write", RUNTIME_V2_LIMITS.fsEntries).map((entry, index) =>
		entry === "store" ? "store" : containedPath(entry, `runtime.permissions.fs.write[${index}]`),
	);
	if (new Set(read).size !== read.length || new Set(write).size !== write.length)
		fail("runtime.permissions.fs", "lists a root twice");
	return {
		fs: { read, write },
		exec: flag(raw.exec, "runtime.permissions.exec", false),
		net: flag(raw.net, "runtime.permissions.net", false),
	};
}

function parseConfig(value: unknown): ExtensionConfigField[] {
	const keys = new Set<string>();
	return list(value, "runtime.config", RUNTIME_V2_LIMITS.configFields).map((item, index) => {
		const path = `runtime.config[${index}]`;
		const raw = record(item, path, ["key", "type", "default", "description", "options"]);
		const key = named(raw.key, `${path}.key`, /^[a-zA-Z][a-zA-Z0-9]*$/, 40);
		if (keys.has(key)) fail(`${path}.key`, `repeats '${key}'`);
		keys.add(key);
		const type = choice(raw.type, `${path}.type`, ["string", "number", "boolean"]);
		const fallback = raw.default;
		if (typeof fallback !== type || (type === "number" && !Number.isFinite(fallback)))
			fail(`${path}.default`, `must be a ${type}`);
		if (type === "string" && (fallback as string).length > 240) fail(`${path}.default`, "is longer than 240 characters");
		const field: ExtensionConfigField = {
			key,
			type,
			default: fallback as string | number | boolean,
			description: text(raw.description, `${path}.description`, 240),
		};
		if (raw.options !== undefined) {
			if (type !== "string") fail(`${path}.options`, "applies only to a string field");
			const options = list(raw.options, `${path}.options`, RUNTIME_V2_LIMITS.configOptions).map((option, at) =>
				text(option, `${path}.options[${at}]`, 80),
			);
			if (!options.includes(fallback as string)) fail(`${path}.default`, "must be one of the options");
			field.options = options;
		}
		return field;
	});
}

export function parseExtensionRuntimeV2(value: unknown): ExtensionRuntimeDeclarationV2 {
	const raw = record(value, "runtime", [
		"api",
		"entrypoint",
		"commands",
		"events",
		"watch",
		"hooks",
		"tools",
		"ui",
		"workspaces",
		"access",
		"permissions",
		"state",
		"config",
	]);
	if (raw.api !== 2) fail("runtime.api", "must be 2");
	const entrypoint = containedPath(raw.entrypoint, "runtime.entrypoint");
	if (!ENTRYPOINT_SUFFIXES.some((suffix) => entrypoint.endsWith(suffix)))
		fail("runtime.entrypoint", `must end in ${ENTRYPOINT_SUFFIXES.join(", ")}`);
	const watch = list(raw.watch, "runtime.watch", SURFACE_LIMITS.watchGlobs).map((glob, index) =>
		containedPath(glob, `runtime.watch[${index}]`),
	);
	if (new Set(watch).size !== watch.length) fail("runtime.watch", "lists a glob twice");
	const state = record(raw.state ?? {}, "runtime.state", ["session", "store"]);
	const declaration: ExtensionRuntimeDeclarationV2 = {
		api: 2,
		entrypoint,
		commands: parseCommands(raw.commands),
		...parseEvents(raw.events),
		watch,
		hooks: parseHooks(raw.hooks),
		tools: parseTools(raw.tools),
		ui: choices(raw.ui, "runtime.ui", SLOTS),
		workspaces: parseWorkspaces(raw.workspaces),
		access: choices(raw.access, "runtime.access", ACCESS),
		permissions: parsePermissions(raw.permissions),
		state: {
			session: flag(state.session, "runtime.state.session", false),
			store: flag(state.store, "runtime.state.store", false),
		},
		config: parseConfig(raw.config),
	};

	// Cross-field rules: each one keeps a declared capability honest about what it needs.
	if (watch.length > 0 !== declaration.events.includes("fs_changed"))
		fail("runtime.watch", "and the fs_changed event must be declared together");
	const usesWorkspaceEvents = declaration.events.some(
		(event) => event === "workspace_enter" || event === "workspace_leave",
	);
	if (usesWorkspaceEvents && declaration.workspaces.length === 0)
		fail("runtime.events", "names a workspace event but the package declares no workspace");
	const writesBeyondStore = declaration.permissions.fs.write.some((root) => root !== "store");
	for (const [index, tool] of declaration.tools.entries())
		if (tool.actionClass === "read" && (declaration.permissions.exec || writesBeyondStore))
			fail(`runtime.tools[${index}].actionClass`, "cannot be read in a package that may execute or write files");
	return declaration;
}

export function capabilityEnvelope(declaration: ExtensionRuntimeDeclarationV2): ExtensionCapabilityEnvelope {
	return {
		commands: declaration.commands.map((command) => command.name),
		events: declaration.events,
		...(declaration.tickMs !== undefined ? { tickMs: declaration.tickMs } : {}),
		watch: declaration.watch,
		hooks: declaration.hooks,
		tools: declaration.tools.map((tool) => ({ name: tool.name, actionClass: tool.actionClass })),
		ui: declaration.ui,
		workspaces: declaration.workspaces.map((workspace) => ({
			id: workspace.id,
			regions: workspace.regions,
			...(workspace.board !== undefined ? { board: workspace.board } : {}),
			...(workspace.keys !== undefined ? { keys: workspace.keys } : {}),
		})),
		access: declaration.access,
		permissions: declaration.permissions,
	};
}

/** Order-insensitive form: reordering a manifest list never changes the digest. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical).sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : 1));
		return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
	}
	return value;
}

export function envelopeDigest(envelope: ExtensionCapabilityEnvelope): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(envelope)))
		.digest("hex");
}

function added(approved: readonly string[], next: readonly string[]): string[] {
	return next.filter((entry) => !approved.includes(entry));
}

function hookCovered(approved: readonly ExtensionHookDeclaration[], hook: ExtensionHookDeclaration): boolean {
	return approved.some(
		(prior) =>
			prior.on === hook.on &&
			(prior.tools === undefined || hook.tools?.every((tool) => prior.tools?.includes(tool) === true) === true) &&
			(prior.onTimeout === "block" || hook.onTimeout === "pass") &&
			(prior.onError === "block" || hook.onError === "pass") &&
			hook.timeoutMs <= prior.timeoutMs,
	);
}

/**
 * Ways `next` reaches further than the envelope the operator approved. An
 * empty list means the same or a smaller envelope, which reloads without
 * asking. Each line is written for the consent card.
 */
export function envelopeGrowth(approved: ExtensionCapabilityEnvelope, next: ExtensionCapabilityEnvelope): string[] {
	const growth: string[] = [];
	const push = (label: string, entries: readonly string[]): void => {
		if (entries.length > 0) growth.push(`${label}: ${entries.join(", ")}`);
	};
	push("new commands", added(approved.commands, next.commands));
	push("new events", added(approved.events, next.events));
	if (next.tickMs !== undefined && approved.tickMs === undefined) growth.push("a timer");
	push("new watched paths", added(approved.watch, next.watch));
	for (const hook of next.hooks) {
		if (hookCovered(approved.hooks, hook)) continue;
		const scope = hook.tools ? ` on ${hook.tools.join(", ")}` : "";
		const gate = hook.onTimeout === "block" || hook.onError === "block" ? ", can refuse the call" : "";
		growth.push(`hook ${hook.on}${scope} (${hook.timeoutMs} ms${gate})`);
	}
	for (const tool of next.tools) {
		const prior = approved.tools.find((entry) => entry.name === tool.name);
		if (!prior) growth.push(`new tool: ${tool.name} (${tool.actionClass})`);
		// A read tool skips the approval an execute tool gets, so that direction is the wider one.
		else if (prior.actionClass === "execute" && tool.actionClass === "read")
			growth.push(`tool ${tool.name} now claims to be read-only`);
	}
	push("new interface slots", added(approved.ui, next.ui));
	for (const workspace of next.workspaces) {
		const prior = approved.workspaces.find((entry) => entry.id === workspace.id);
		if (!prior) {
			growth.push(`new workspace: ${workspace.id} (${workspace.regions.join(", ")})`);
			continue;
		}
		push(`workspace ${workspace.id} regions`, added(prior.regions, workspace.regions));
		const priorKeys = (prior.keys ?? []).map((binding) => `${binding.key}:${binding.action}`);
		const nextKeys = (workspace.keys ?? []).map((binding) => `${binding.key}:${binding.action}`);
		push(`workspace ${workspace.id} keys`, added(priorKeys, nextKeys));
	}
	push("content access", added(approved.access, next.access));
	push("read access", added(approved.permissions.fs.read, next.permissions.fs.read));
	push("write access", added(approved.permissions.fs.write, next.permissions.fs.write));
	if (next.permissions.exec && !approved.permissions.exec) growth.push("may run programs");
	if (next.permissions.net && !approved.permissions.net) growth.push("may use the network");
	return growth;
}
