import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { resetXdgCache } from "../../core/xdg.js";
import { isSessionJsonlHeader, readSessionFileEntries } from "../../engine/session.js";
import { collectSessionEntries } from "../session/compaction/session-entries.js";
import type { SessionEntry } from "../session/entries.js";
import { payloadObject } from "../session/message-projection.js";
import { loadSessionTelemetrySource } from "../session/telemetry-source.js";
import { loadTokenSourcesReport, type TokenSourcesReportV1 } from "../session/token-sources.js";

/** The loop guard's middleware registration id (`LOOP_GUARD_REGISTRATION_ID` in src/engine/loop-guard.ts). */
const LOOP_GUARD_RULE_ID = "guard.loop";
const EXTENSION_TOOL_PREFIX = "extension_";

/** What one roster entry's run left behind, folded from its session ledger, its journal and C2's attribution. */
export interface CampaignMetrics {
	sessionId: string | null;
	/**
	 * Interviews an extension tool put to the author. `reached` holds the distinct checkpoint ids their questions
	 * declared, in first-asked order; `answered` interviews finished, `unscripted` were cancelled because the
	 * answers file had no answer, and `unanswered` were cancelled any other way.
	 */
	gates: { reached: string[]; interviews: number; answered: number; unscripted: number; unanswered: number };
	/**
	 * Refusals by an extension: `hookBlocks` are its hooks' block_tool effects (journal `hook.ran`), `toolRefusals`
	 * its own tools' calls that returned an error outside an interview (session ledger).
	 */
	refusals: { hookBlocks: number; toolRefusals: number };
	/** Calls the loop guard blocked (journal `middleware.fired` from `guard.loop` with a block_tool effect). */
	loopGuardBlocks: number;
	/** C2's per-session totals: provider-measured input (fresh and cached) and output; null without a session. */
	tokens: {
		usage: TokenSourcesReportV1["basis"]["usage"];
		calls: number;
		unmeasuredCalls: number;
		fresh: number | null;
		cached: number | null;
		input: number;
		output: number;
	} | null;
}

function record(value: unknown): Record<string, unknown> | null {
	return payloadObject(value);
}

/** A result an extension tool returned: the ledger stamps the extension as the call's owner, gateway or not. */
function isExtensionResult(payload: Record<string, unknown> | null, details: Record<string, unknown> | null): boolean {
	if (record(payload?.owner)?.kind === "extension") return true;
	const toolName = payload?.toolName;
	if (typeof toolName === "string" && toolName.startsWith(EXTENSION_TOOL_PREFIX)) return true;
	const capability = details?.capability;
	return typeof capability === "string" && capability.startsWith(EXTENSION_TOOL_PREFIX);
}

/** Pure fold over what a run persisted; the loader below reads those inputs from the entry's own state root. */
export function foldCampaignMetrics(
	sessionId: string | null,
	entries: ReadonlyArray<SessionEntry>,
	records: ReadonlyArray<TelemetryRecord>,
	tokens: TokenSourcesReportV1 | null,
): CampaignMetrics {
	const gates: CampaignMetrics["gates"] = { reached: [], interviews: 0, answered: 0, unscripted: 0, unanswered: 0 };
	const refusals: CampaignMetrics["refusals"] = { hookBlocks: 0, toolRefusals: 0 };
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "tool_result") continue;
		const payload = record(entry.payload);
		const result = record(payload?.result);
		const details = record(result?.details);
		if (!isExtensionResult(payload, details)) continue;
		const interview = record(details?.interview);
		if (interview === null) {
			if (payload?.isError === true) refusals.toolRefusals += 1;
			continue;
		}
		gates.interviews += 1;
		if (interview.outcome === "done") gates.answered += 1;
		else if (interview.reason === "unscripted") gates.unscripted += 1;
		else gates.unanswered += 1;
		const checkpoints = Array.isArray(interview.checkpoints) ? interview.checkpoints : [];
		for (const checkpoint of checkpoints)
			if (typeof checkpoint === "string" && !gates.reached.includes(checkpoint)) gates.reached.push(checkpoint);
	}
	let loopGuardBlocks = 0;
	for (const row of records) {
		const owner = row.ctx.sessionId;
		if (sessionId !== null && owner !== undefined && owner !== null && owner !== sessionId) continue;
		if (row.k === "hook.ran") {
			if (row.data.origin === "extension" && row.data.effectKinds?.includes("block_tool") === true)
				refusals.hookBlocks += 1;
		} else if (row.k === "middleware.fired") {
			if (row.data.ruleId === LOOP_GUARD_RULE_ID && row.data.effects.includes("block_tool")) loopGuardBlocks += 1;
		}
	}
	return {
		sessionId,
		gates,
		refusals,
		loopGuardBlocks,
		tokens:
			tokens === null
				? null
				: {
						usage: tokens.basis.usage,
						calls: tokens.totals.calls,
						unmeasuredCalls: tokens.totals.unmeasuredCalls,
						fresh: tokens.totals.input.fresh,
						cached: tokens.totals.input.cached,
						input: tokens.totals.input.total,
						output: tokens.totals.output,
					},
	};
}

/** The Clio roots one entry's run used: the operator's config, and data, state and cache under the entry's home. */
export interface EntryRoots {
	home: string;
	config: string;
	data: string;
	state: string;
	cache: string;
}

export function entryRoots(home: string, operatorConfig: string): EntryRoots {
	return {
		home,
		config: operatorConfig,
		data: join(home, "data"),
		state: join(home, "state"),
		cache: join(home, "cache"),
	};
}

/** The environment that points a Clio process at these roots and nowhere else. */
export function entryRootEnv(roots: EntryRoots): Record<string, string> {
	return {
		CLIO_CODER_HOME: roots.home,
		CLIO_CODER_CONFIG_DIR: roots.config,
		CLIO_CODER_DATA_DIR: roots.data,
		CLIO_CODER_STATE_DIR: roots.state,
		CLIO_CODER_CACHE_DIR: roots.cache,
	};
}

/**
 * Run `read` with this process's Clio roots pointed at an entry's, then put them back. The session readers resolve
 * the state root from the environment, so the swap is what lets one process read every entry; `read` must be
 * synchronous, so nothing else runs while the roots are swapped.
 */
function withEntryRoots<T>(roots: EntryRoots, read: () => T): T {
	const env = entryRootEnv(roots);
	const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetXdgCache();
	try {
		return read();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		resetXdgCache();
	}
}

interface SessionDir {
	id: string;
	dir: string;
	cwd: string | null;
	createdAt: string;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The run's main session: the earliest one opened in the project copy, else the earliest in the state root. */
function mainSession(stateDir: string, projectDir: string): SessionDir | null {
	const root = join(stateDir, "sessions");
	if (!existsSync(root)) return null;
	const found: SessionDir[] = [];
	for (const bucket of readdirSync(root, { withFileTypes: true })) {
		if (!bucket.isDirectory()) continue;
		for (const session of readdirSync(join(root, bucket.name), { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			const dir = join(root, bucket.name, session.name);
			let meta: Record<string, unknown> | null = null;
			try {
				meta = record(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")));
			} catch {
				continue;
			}
			if (meta === null || typeof meta.id !== "string") continue;
			found.push({
				id: meta.id,
				dir,
				cwd: typeof meta.cwd === "string" ? canonical(meta.cwd) : null,
				createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
			});
		}
	}
	found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const project = canonical(projectDir);
	return found.find((session) => session.cwd === project) ?? found[0] ?? null;
}

/** Fold one entry's metrics from its own state root after its run has exited. */
export function loadCampaignMetrics(roots: EntryRoots, projectDir: string): CampaignMetrics {
	const session = mainSession(roots.state, projectDir);
	if (session === null) return foldCampaignMetrics(null, [], [], null);
	return withEntryRoots(roots, () => {
		const path = join(session.dir, "current.jsonl");
		const raw = existsSync(path) ? readSessionFileEntries(path).filter((entry) => !isSessionJsonlHeader(entry)) : [];
		const entries = collectSessionEntries(raw, path);
		const records = loadSessionTelemetrySource(roots.state, session.id)?.journal.records ?? [];
		const tokens = loadTokenSourcesReport(roots.state, session.id);
		return foldCampaignMetrics(session.id, entries, records, tokens);
	});
}
