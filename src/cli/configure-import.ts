/**
 * `configure --import`: a site or lab publishes one setup file and a user is connected with one command. The file
 * names targets in the settings schema, restricted to where prompts go and which model answers; anything that could
 * carry a secret, widen trust or run code is refused by name, so importing a file is reading a list of addresses.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type { ClioSettings } from "../core/config.js";
import { readSettings, updateSettings, validateSettings } from "../core/config.js";
import { isLoopbackUrl } from "../core/project-target-urls.js";
import { describeMissing } from "../domains/lifecycle/setup-status.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { applyTarget, setOrchestratorPointer, setWorkerDefaultPointer } from "./configure-target.js";
import { firstMissing } from "./default-target.js";

const MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const TOP_KEYS = ["targets", "chat", "fleet", "notes"];
const TARGET_KEYS = ["id", "runtime", "url", "defaultModel", "wireModels", "capabilities", "pricing", "auth"];
const AUTH_KEYS = ["apiKeyEnvVar", "oauthProfile"];
const DEFAULT_KEYS = ["target", "model"];

interface RoleDefault {
	target: string;
	model?: string;
}

export interface SetupFile {
	targets: TargetDescriptor[];
	chat?: RoleDefault;
	fleet?: RoleDefault;
	notes?: string;
}

export type SetupFileParse = { ok: true; file: SetupFile } | { ok: false; errors: string[] };

function isMap(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuseUnknown(errors: string[], path: string, value: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) errors.push(`${path}${key} is not allowed in a setup file`);
	}
}

function roleDefault(errors: string[], name: "chat" | "fleet", value: unknown, ids: string[]): RoleDefault | undefined {
	if (value === undefined) return undefined;
	if (!isMap(value) || typeof value.target !== "string") {
		errors.push(`${name} must name a target: ${name}: { target: <id>, model: <id> }`);
		return undefined;
	}
	refuseUnknown(errors, `${name}.`, value, DEFAULT_KEYS);
	if (!ids.includes(value.target)) errors.push(`${name}.target '${value.target}' is not a target in this file`);
	if (value.model !== undefined && typeof value.model !== "string") errors.push(`${name}.model must be a string`);
	return { target: value.target, ...(typeof value.model === "string" ? { model: value.model } : {}) };
}

/** Read a setup file's text into targets and role defaults, or every reason it is refused. */
export function parseSetupFile(text: string): SetupFileParse {
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (err) {
		return { ok: false, errors: [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`] };
	}
	if (!isMap(raw)) return { ok: false, errors: ["expected a map with a targets list"] };
	const errors: string[] = [];
	refuseUnknown(errors, "", raw, TOP_KEYS);
	if (!Array.isArray(raw.targets) || raw.targets.length === 0)
		return { ok: false, errors: [...errors, "targets must be a non-empty list"] };
	for (const [index, target] of raw.targets.entries()) {
		if (!isMap(target)) {
			errors.push(`targets[${index}] must be a map`);
			continue;
		}
		refuseUnknown(errors, `targets[${index}].`, target, TARGET_KEYS);
		if (target.auth !== undefined) {
			if (isMap(target.auth)) refuseUnknown(errors, `targets[${index}].auth.`, target.auth, AUTH_KEYS);
			else errors.push(`targets[${index}].auth must be a map`);
		}
	}
	if (raw.notes !== undefined && typeof raw.notes !== "string") errors.push("notes must be a string");
	if (errors.length > 0) return { ok: false, errors };

	const validated = validateSettings({ version: 2, targets: raw.targets });
	for (const issue of validated.issues) errors.push(`${issue.path}: ${issue.message}`);
	const targets = validated.settings.targets;
	const ids = targets.map((target) => target.id);
	for (const [index, target] of targets.entries()) {
		if (!getRuntimeRegistry().get(target.runtime))
			errors.push(`targets[${index}].runtime: '${target.runtime}' is not a runtime this Clio knows`);
		if (ids.indexOf(target.id) !== index) errors.push(`targets[${index}].id: '${target.id}' appears twice`);
	}
	const chat = roleDefault(errors, "chat", raw.chat, ids);
	const fleet = roleDefault(errors, "fleet", raw.fleet, ids);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		file: {
			targets,
			...(chat ? { chat } : {}),
			...(fleet ? { fleet } : {}),
			...(typeof raw.notes === "string" && raw.notes.trim() ? { notes: raw.notes.trim() } : {}),
		},
	};
}

function isPrivateHost(url: string): boolean {
	if (isLoopbackUrl(url)) return true;
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	} catch {
		return false;
	}
	if (/^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./u.test(host)) return true;
	return /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe80:/u.test(host);
}

/** A plain-http address that leaves this machine and its private network sends prompts in the clear. */
function plainHttpWarning(target: TargetDescriptor): string | null {
	if (target.url === undefined || !target.url.startsWith("http://") || isPrivateHost(target.url)) return null;
	return `warning: ${target.id} uses plain http to a public address; prompts and keys cross the network unencrypted`;
}

export interface ImportPlan {
	added: TargetDescriptor[];
	replaced: TargetDescriptor[];
	/** Targets whose id is taken by a different saved target, refused without `--replace`. */
	collisions: string[];
	unchanged: TargetDescriptor[];
	setsChat: boolean;
	setsFleet: boolean;
}

function roleModel(file: SetupFile, role: RoleDefault): string | null {
	return role.model ?? file.targets.find((target) => target.id === role.target)?.defaultModel ?? null;
}

export function planImport(settings: Readonly<ClioSettings>, file: SetupFile, replace: boolean): ImportPlan {
	const plan: ImportPlan = {
		added: [],
		replaced: [],
		collisions: [],
		unchanged: [],
		setsChat: false,
		setsFleet: false,
	};
	for (const target of file.targets) {
		const saved = settings.targets.find((entry) => entry.id === target.id);
		if (saved === undefined) plan.added.push(target);
		else if (isDeepStrictEqual(saved, target)) plan.unchanged.push(target);
		else if (replace) plan.replaced.push(target);
		else plan.collisions.push(target.id);
	}
	if (file.chat)
		plan.setsChat =
			settings.chat.target !== file.chat.target || (settings.chat.model ?? null) !== roleModel(file, file.chat);
	if (file.fleet)
		plan.setsFleet =
			settings.fleet.default.target !== file.fleet.target ||
			(settings.fleet.default.model ?? null) !== roleModel(file, file.fleet);
	return plan;
}

/** Apply a planned import in place: the file's targets and its two defaults, nothing else. */
function applySetupFile(settings: ClioSettings, file: SetupFile): void {
	for (const target of file.targets) applyTarget(settings, target);
	const byId = (id: string) => file.targets.find((target) => target.id === id) as TargetDescriptor;
	if (file.chat) setOrchestratorPointer(settings, byId(file.chat.target), roleModel(file, file.chat));
	if (file.fleet) setWorkerDefaultPointer(settings, byId(file.fleet.target), roleModel(file, file.fleet));
}

async function fetchSetupFile(source: string): Promise<string> {
	// The global fetch goes through the proxy the environment names (installProxyFromEnv at CLI start).
	const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
	if (!response.ok) throw new Error(`${source} answered HTTP ${response.status}`);
	if (new URL(response.url || source).protocol !== "https:") throw new Error(`${source} redirected away from https`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > MAX_BYTES) throw new Error(`${source} is larger than ${MAX_BYTES / 1024} KiB`);
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BYTES) {
			await reader.cancel();
			throw new Error(`${source} is larger than ${MAX_BYTES / 1024} KiB`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The setup file's text from a local path or an https URL. Plain http is refused: the file decides where prompts go. */
async function readSetupSource(source: string): Promise<string> {
	if (/^https:\/\//iu.test(source)) return fetchSetupFile(source);
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) throw new Error(`a setup file URL must use https: ${source}`);
	const text = readFileSync(source, "utf8");
	if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${source} is larger than ${MAX_BYTES / 1024} KiB`);
	return text;
}

function keySource(target: TargetDescriptor): string {
	if (target.auth?.apiKeyEnvVar) return `key from $${target.auth.apiKeyEnvVar}`;
	if (target.auth?.oauthProfile) return `sign-in profile ${target.auth.oauthProfile}`;
	return "no key named; Clio uses a stored login if there is one";
}

function describePlan(file: SetupFile, plan: ImportPlan): string[] {
	const lines: string[] = [];
	if (file.notes) lines.push(file.notes, "");
	const verb = (target: TargetDescriptor) => (plan.replaced.includes(target) ? "replace" : "add");
	for (const target of [...plan.added, ...plan.replaced]) {
		lines.push(`  ${verb(target)} target ${target.id} (${target.runtime})`);
		lines.push(`    prompts go to ${target.url ?? "the provider's default address"}`);
		lines.push(`    model ${target.defaultModel ?? "not set"}; ${keySource(target)}`);
		const warning = plainHttpWarning(target);
		if (warning) lines.push(`    ${warning}`);
	}
	for (const target of plan.unchanged) lines.push(`  keep target ${target.id} (already saved, unchanged)`);
	if (plan.setsChat && file.chat)
		lines.push(`  chat uses ${file.chat.target} / ${roleModel(file, file.chat) ?? "its default model"}`);
	if (plan.setsFleet && file.fleet)
		lines.push(`  fleet uses ${file.fleet.target} / ${roleModel(file, file.fleet) ?? "its default model"}`);
	return lines;
}

/** One line per imported target: ready, or what it still needs, in the setup-status words. */
function statusLines(settings: Readonly<ClioSettings>, file: SetupFile): string[] {
	return file.targets.map((target) => {
		const missing = firstMissing({ ...settings, chat: { ...settings.chat, target: target.id } });
		if (missing === null) return `  ${target.id}: ready`;
		const described = describeMissing(missing);
		return `  ${described.sentence}${described.command ? ` Run: ${described.command}` : ""}`;
	});
}

export type PreparedImport =
	| { ok: true; source: string; file: SetupFile; plan: ImportPlan }
	| { ok: false; error: string };

/** Read and check a setup file against the saved settings; nothing is written. */
export async function prepareImport(source: string, replace: boolean): Promise<PreparedImport> {
	let text: string;
	try {
		text = await readSetupSource(source);
	} catch (err) {
		return { ok: false, error: `could not read the setup file: ${err instanceof Error ? err.message : String(err)}` };
	}
	const parsed = parseSetupFile(text);
	if (!parsed.ok)
		return { ok: false, error: `setup file refused; nothing changed:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}` };
	const plan = planImport(readSettings(), parsed.file, replace);
	if (plan.collisions.length > 0)
		return {
			ok: false,
			error: `${plan.collisions.join(", ")} already saved with different settings; nothing changed. Rerun \`clio-coder configure --import ${source} --replace\` to overwrite.`,
		};
	return { ok: true, source, file: parsed.file, plan };
}

export function importChangesNothing(plan: ImportPlan): boolean {
	return plan.added.length === 0 && plan.replaced.length === 0 && !plan.setsChat && !plan.setsFleet;
}

/** What the import will change, one fact per line: each address prompts will go to, its model and key source. */
export function describeImport(prepared: Extract<PreparedImport, { ok: true }>): string[] {
	return describePlan(prepared.file, prepared.plan);
}

/** Write the file's targets and defaults; returns the setup-status line for each imported target. */
export function commitImport(file: SetupFile): string[] {
	return statusLines(
		updateSettings((settings) => applySetupFile(settings, file)),
		file,
	);
}

export interface ImportOptions {
	yes: boolean;
	replace: boolean;
	out: NodeJS.WritableStream;
	/** Asks the one confirmation; absent when there is no terminal to answer it. */
	confirm?: (question: string) => Promise<boolean>;
}

/** `configure --import`: read, show, confirm once, apply, report. Exit 0 applied or nothing to do, 1 refused, 2 usage. */
export async function runConfigureImport(source: string, options: ImportOptions): Promise<number> {
	const { out } = options;
	const prepared = await prepareImport(source, options.replace);
	if (!prepared.ok) {
		process.stderr.write(`error: ${prepared.error}\n`);
		return 1;
	}
	const { file, plan } = prepared;
	if (importChangesNothing(plan)) {
		out.write(`Setup file already imported; nothing changed (${source}).\n`);
		out.write(`${statusLines(readSettings(), file).join("\n")}\n`);
		return 0;
	}
	out.write(`Setup file ${source} will:\n${describeImport(prepared).join("\n")}\n`);
	if (!options.yes && options.confirm === undefined) {
		process.stderr.write("error: --import without a terminal needs --yes; review the changes above, then rerun\n");
		return 2;
	}
	if (!options.yes && !(await options.confirm?.("Apply these changes? [y/N] "))) {
		out.write("Nothing changed.\n");
		return 130;
	}
	let status: string[];
	try {
		status = commitImport(file);
	} catch (err) {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}; nothing changed\n`);
		return 1;
	}
	out.write(`Imported ${file.targets.length === 1 ? "1 target" : `${file.targets.length} targets`}.\n`);
	out.write(`${status.join("\n")}\n`);
	return 0;
}
