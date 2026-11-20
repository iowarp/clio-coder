/**
 * `clio-coder session history|show|export|artifacts|rename|fork|rm|compact`: persisted sessions from the shell (SPEC L3, L3c).
 * `session list` and `terminate` stay in session.ts and are untouched; session.ts answers `--help` for these leaves
 * before this module loads (C1).
 *
 * | Leaf                                                      | Writes                  | Live owner (6.7)   | Exits                                  |
 * |-----------------------------------------------------------|-------------------------|--------------------|----------------------------------------|
 * | history [--all-projects] [--limit N] [--json]             | nothing                 | reported as `live` | 0; 2 usage                             |
 * | show <s> [--all-projects] [--transcript] [--json]         | nothing                 | allowed            | 0; 1 not_found/ambiguous; 2 usage      |
 * | export <s> [--format md|html|jsonl] [--out p] [--json]    | the export file only    | allowed            | 0; 1 not_found/ambiguous/io; 2 usage   |
 * | artifacts <s> [read <id>] [--all-projects] [--json]       | nothing                 | allowed            | 0; 1 not_found/ambiguous; 2 usage      |
 * | rename <s> <name> [--json]                                | name entry and meta.json| 1 session_live     | 0; 1 not_found/ambiguous; 2 usage      |
 * | fork <s> [--at <turnId>] [--name <n>] [--json]            | a new session           | allowed            | 0; 1 not_found/ambiguous/io; 2 usage   |
 * | rm <s> [--yes] [--json]                                   | removes the session     | 1 session_live     | 0; 1 not_found/ambiguous/session_has_children/declined; 2 usage/confirmation_required |
 * | compact <s> [--instructions <text>] [--json]              | one compactionSummary   | 1 session_live     | 0; 1 not_found/ambiguous/io; 2 usage   |
 *
 * `<s>` is an id, unique id prefix or name (C13), resolved among this directory's sessions; `--all-projects`
 * widens reads only and is refused with exit 2 on rename, fork, rm and compact. `--yes` skips rm's question and never
 * overrides `session_live` or `session_has_children`.
 *
 * compact (SPEC L3c) boots a headless session on `<s>` that sends no turn and runs the `/context compact` summarizer
 * once (`runHeadlessCompaction`). `before` and `after` count the entries the next resumed request replays; an exit 0
 * with `compacted: false` means the summarizer found nothing to cut, and its notice says why.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { removeSessionAtRest, renameSessionAtRest, sessionRemovalRefusal } from "../domains/session/at-rest.js";
import type { SessionMeta } from "../domains/session/contract.js";
import { type HeadlessCompactionOutcome, replayedContextSize } from "../domains/session/headless-compact.js";
import { listSessionsForCwd, listSessionWorkspaces } from "../domains/session/history.js";
import { sessionLiveOwner } from "../domains/session/live-owner.js";
import { resolveSessionTarget } from "../domains/session/names.js";
import { foldSessionArtifacts, resolveSessionArtifactPath } from "../domains/session/session-artifacts.js";
import { renderTranscriptMarkdown, writeTranscriptExport } from "../domains/session/transcript-export.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import { forkSessionAtRest } from "../domains/session/tree/fork.js";
import { readTreeBundle } from "../domains/session/tree/manager.js";
import type { ClioSessionOwner } from "../engine/session.js";
import { confirmAction } from "./kit/confirm.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { type FlagDeclarations, parseCommandFlags } from "./kit/flags.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

export type SessionHistoryVerb = "history" | "show" | "export" | "artifacts" | "rename" | "fork" | "rm" | "compact";
type Verb = SessionHistoryVerb;

const FLAGS = {
	history: { "all-projects": { kind: "boolean" }, limit: { kind: "value" }, json: { kind: "boolean" } },
	show: { "all-projects": { kind: "boolean" }, transcript: { kind: "boolean" }, json: { kind: "boolean" } },
	export: {
		"all-projects": { kind: "boolean" },
		format: { kind: "value" },
		out: { kind: "value" },
		json: { kind: "boolean" },
	},
	artifacts: { "all-projects": { kind: "boolean" }, json: { kind: "boolean" } },
	rename: { "all-projects": { kind: "boolean" }, json: { kind: "boolean" } },
	fork: {
		"all-projects": { kind: "boolean" },
		at: { kind: "value" },
		name: { kind: "value" },
		json: { kind: "boolean" },
	},
	rm: { "all-projects": { kind: "boolean" }, yes: { kind: "boolean", short: "y" }, json: { kind: "boolean" } },
	compact: { "all-projects": { kind: "boolean" }, instructions: { kind: "value" }, json: { kind: "boolean" } },
} as const satisfies Record<Verb, FlagDeclarations>;

const ARITY: Record<Verb, { min: number; max: number; usage: string }> = {
	history: { min: 0, max: 0, usage: "history takes no positional argument" },
	show: { min: 1, max: 1, usage: "show takes one session" },
	export: { min: 1, max: 1, usage: "export takes one session" },
	artifacts: { min: 1, max: 3, usage: "artifacts takes a session and optionally read <id>" },
	rename: { min: 2, max: 2, usage: "rename takes a session and a name" },
	fork: { min: 1, max: 1, usage: "fork takes one session" },
	rm: { min: 1, max: 1, usage: "rm takes one session" },
	compact: { min: 1, max: 1, usage: "compact takes one session" },
};

class Failure {
	constructor(
		readonly slug: ErrorSlug,
		readonly message: string,
		readonly exitCode: number,
	) {}
}

const usage = (message: string): Failure => new Failure("usage", message, EXIT_CODES.notStarted);

function ownerText(owner: ClioSessionOwner): string {
	return `pid ${owner.pid} on ${owner.host}`;
}

function allSessions(): SessionMeta[] {
	return listSessionWorkspaces().flatMap((workspace) => listSessionsForCwd(workspace.cwd));
}

function resolveSession(target: string, allProjects: boolean): SessionMeta {
	const candidates = allProjects ? allSessions() : listSessionsForCwd(process.cwd());
	const match = resolveSessionTarget(candidates, target);
	if ("miss" in match) {
		const none = candidates.every((meta) => !meta.id.startsWith(target) && meta.name !== target);
		return fail(none ? "not_found" : "ambiguous", match.miss, EXIT_CODES.failed);
	}
	return candidates.find((meta) => meta.id === match.id) as SessionMeta;
}

function fail(slug: ErrorSlug, message: string, exitCode: number): never {
	throw new Failure(slug, message, exitCode);
}

function artifactId(path: string, workspace: string): string {
	return createHash("sha256")
		.update(resolveSessionArtifactPath(path, workspace) ?? path)
		.digest("hex")
		.slice(0, 8);
}

function localDate(at: Date): string {
	return [at.getFullYear(), String(at.getMonth() + 1).padStart(2, "0"), String(at.getDate()).padStart(2, "0")].join("-");
}

export async function runSessionHistoryCommand(verb: Verb, args: ReadonlyArray<string>): Promise<number> {
	const parsed = parseCommandFlags(args, FLAGS[verb]);
	const json = args.includes("--json");
	const path = ["session", verb];
	try {
		if (!parsed.ok) throw new Failure(parsed.slug, parsed.message, EXIT_CODES.notStarted);
		const flags = parsed.flags as Record<string, string | boolean | undefined>;
		const positional = parsed.positional;
		const arity = ARITY[verb];
		if (positional.length < arity.min || positional.length > arity.max) throw usage(arity.usage);
		const allProjects = flags["all-projects"] === true;
		if (allProjects && (verb === "rename" || verb === "fork" || verb === "rm" || verb === "compact"))
			throw usage(`--all-projects is read-only; ${verb} resolves only among this directory's sessions`);
		const out = (document: object, text: string): number => {
			if (flags.json === true) writeJson(process.stdout, jsonDocument(document));
			else process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
			return EXIT_CODES.success;
		};
		switch (verb) {
			case "history":
				return history(flags, allProjects, out);
			case "show":
				return show(resolveSession(positional[0] as string, allProjects), flags, out);
			case "export":
				return exportSession(resolveSession(positional[0] as string, allProjects), flags, out);
			case "artifacts":
				return artifacts(resolveSession(positional[0] as string, allProjects), positional.slice(1), out);
			case "rename":
				return rename(resolveSession(positional[0] as string, false), positional[1] as string, out);
			case "fork":
				return await fork(resolveSession(positional[0] as string, false), flags, out);
			case "rm":
				return await remove(resolveSession(positional[0] as string, false), flags.yes === true, out);
			case "compact":
				return await compact(resolveSession(positional[0] as string, false), flags, out);
		}
	} catch (error) {
		const failure =
			error instanceof Failure
				? error
				: new Failure("io", error instanceof Error ? error.message : String(error), EXIT_CODES.failed);
		writeCliFailure({ path, slug: failure.slug, message: failure.message, json });
		return failure.exitCode;
	}
}

type Out = (document: object, text: string) => number;

function history(flags: Record<string, string | boolean | undefined>, allProjects: boolean, out: Out): number {
	let limit: number | undefined;
	if (typeof flags.limit === "string") {
		limit = Number(flags.limit);
		if (!Number.isSafeInteger(limit) || limit < 1) throw usage(`--limit takes a positive integer, not ${flags.limit}`);
	}
	const metas = allProjects ? allSessions() : listSessionsForCwd(process.cwd());
	const rows = metas
		.map((meta) => {
			const owner = sessionLiveOwner(meta);
			return {
				id: meta.id,
				name: meta.name ?? null,
				cwd: meta.cwd,
				createdAt: meta.createdAt,
				updatedAt: meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt,
				endedAt: meta.endedAt,
				parentSessionId: meta.parentSessionId ?? null,
				live: owner !== null,
				owner: owner === null ? null : { host: owner.host, pid: owner.pid },
			};
		})
		.sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt > b.updatedAt ? -1 : 1))
		.slice(0, limit);
	const text = rows
		.map((row) =>
			[row.id, row.updatedAt, row.live ? "live" : "-", row.name ?? "-", ...(allProjects ? [row.cwd] : [])].join("  "),
		)
		.join("\n");
	return out({ cwd: allProjects ? null : process.cwd(), sessions: rows }, rows.length === 0 ? "no sessions\n" : text);
}

function show(meta: SessionMeta, flags: Record<string, string | boolean | undefined>, out: Out): number {
	const bundle = readTreeBundle(meta.id);
	const owner = sessionLiveOwner(bundle.meta);
	const leaf = bundle.meta.pinnedLeafTurnId ?? null;
	if (flags.transcript === true && flags.json !== true) {
		const rendered = renderTranscriptMarkdown({
			sessionId: meta.id,
			exportedAt: new Date().toISOString(),
			entries: bundle.entries,
			leafTurnId: leaf,
		});
		process.stdout.write(rendered.text.endsWith("\n") ? rendered.text : `${rendered.text}\n`);
		return EXIT_CODES.success;
	}
	const messages = bundle.entries.filter((entry) => entry.kind === "message").length;
	const text = [
		`session ${bundle.meta.id}${meta.name ? ` (${meta.name})` : ""}`,
		`cwd: ${bundle.meta.cwd}`,
		`created: ${bundle.meta.createdAt}${bundle.meta.endedAt ? `, ended: ${bundle.meta.endedAt}` : ""}`,
		...(bundle.meta.parentSessionId ? [`forked from: ${bundle.meta.parentSessionId}`] : []),
		`entries: ${bundle.entries.length}, messages: ${messages}`,
		`live: ${owner ? ownerText(owner) : "no"}`,
	].join("\n");
	return out(
		{
			meta: { ...bundle.meta, ...(meta.name ? { name: meta.name } : {}) },
			live: owner !== null,
			owner: owner === null ? null : { host: owner.host, pid: owner.pid },
			entries: bundle.entries,
		},
		text,
	);
}

function exportSession(meta: SessionMeta, flags: Record<string, string | boolean | undefined>, out: Out): number {
	const requestedOut = typeof flags.out === "string" ? flags.out : undefined;
	const inferred = requestedOut?.toLowerCase().endsWith(".md")
		? "md"
		: requestedOut?.toLowerCase().endsWith(".jsonl")
			? "jsonl"
			: "html";
	const format = typeof flags.format === "string" ? flags.format : inferred;
	if (format !== "md" && format !== "html" && format !== "jsonl")
		throw usage(`--format takes md, html or jsonl, not ${format}`);
	const bundle = readTreeBundle(meta.id);
	if (format === "jsonl") {
		const target = resolve(
			process.cwd(),
			requestedOut ?? join(".clio-coder", "exports", `${meta.id}-${localDate(new Date())}.jsonl`),
		);
		safeResourceWrite(target, bundle.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
			encoding: "utf8",
		});
		return out(
			{ sessionId: meta.id, format, path: target, entries: bundle.entries.length },
			`wrote ${bundle.entries.length} entries to ${target}`,
		);
	}
	const result = writeTranscriptExport({
		sessionId: meta.id,
		leafTurnId: () => bundle.meta.pinnedLeafTurnId ?? null,
		readEntries: () => bundle.entries,
		cwd: process.cwd(),
		format,
		...(requestedOut !== undefined ? { path: requestedOut } : {}),
	});
	if (result.level === "error") fail("io", result.text, EXIT_CODES.failed);
	return out({ sessionId: meta.id, format, message: result.text }, result.text);
}

function artifacts(meta: SessionMeta, rest: ReadonlyArray<string>, out: Out): number {
	if (rest.length > 0 && (rest[0] !== "read" || rest.length !== 2)) throw usage(ARITY.artifacts.usage);
	const bundle = readTreeBundle(meta.id);
	const workspace = bundle.meta.cwd;
	const entries = filterEntriesToActivePath(bundle.entries, bundle.meta.pinnedLeafTurnId ?? undefined);
	const rows = foldSessionArtifacts(entries, { workspace }).map((artifact) => ({
		id: artifactId(artifact.path, workspace),
		...artifact,
	}));
	if (rest.length === 2) {
		const wanted = rest[1] as string;
		const row = rows.find((candidate) => candidate.id === wanted || candidate.path === wanted);
		if (!row) return fail("not_found", `session ${meta.id} has no artifact ${wanted}`, EXIT_CODES.failed);
		const file = resolveSessionArtifactPath(row.path, workspace);
		let content: string;
		try {
			content = readFileSync(file ?? row.path, "utf8");
		} catch {
			return fail("not_found", `artifact ${row.id} is no longer at ${row.path}`, EXIT_CODES.failed);
		}
		return out({ sessionId: meta.id, artifact: row, content }, content);
	}
	const text = rows.map((row) => `${row.id}  ${row.artifactKind ?? row.tool}  ${row.timestamp}  ${row.path}`).join("\n");
	return out({ sessionId: meta.id, artifacts: rows }, rows.length === 0 ? "no artifacts\n" : text);
}

function rename(meta: SessionMeta, name: string, out: Out): number {
	if (name.trim().length === 0) throw usage("rename takes a non-empty name");
	const owner = renameSessionAtRest(meta.id, name);
	if (owner)
		fail("session_live", `session ${meta.id} is open in another process (${ownerText(owner)})`, EXIT_CODES.failed);
	return out({ sessionId: meta.id, name: name.trim() }, `renamed ${meta.id} to ${name.trim()}`);
}

function fork(
	meta: SessionMeta,
	flags: Record<string, string | boolean | undefined>,
	out: Out,
): Promise<number> | number {
	const atTurnId = typeof flags.at === "string" ? flags.at : undefined;
	const name = typeof flags.name === "string" ? flags.name : undefined;
	if (name !== undefined && name.trim().length === 0) throw usage("--name takes a non-empty name");
	let result: ReturnType<typeof forkSessionAtRest>;
	try {
		result = forkSessionAtRest(meta.id, {
			...(atTurnId !== undefined ? { atTurnId } : {}),
			...(name !== undefined ? { name } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail(atTurnId !== undefined ? "not_found" : "io", message, EXIT_CODES.failed);
	}
	const child = result.next.meta;
	return result.next.writer.close().then(() =>
		out(
			{
				sessionId: child.id,
				parentSessionId: meta.id,
				parentTurnId: result.parentTurnId,
				name: child.name ?? null,
			},
			`forked ${meta.id} at ${result.parentTurnId} into ${child.id}`,
		),
	);
}

async function remove(meta: SessionMeta, yes: boolean, out: Out): Promise<number> {
	const refusal = sessionRemovalRefusal(meta.id);
	if (refusal?.kind === "live")
		fail("session_live", `session ${meta.id} is open in another process (${ownerText(refusal.owner)})`, 1);
	if (refusal?.kind === "children")
		fail(
			"session_has_children",
			`session ${meta.id} has forks: ${refusal.children.join(", ")}; remove them first or keep the parent`,
			EXIT_CODES.failed,
		);
	const confirmed = await confirmAction({ question: `Remove session ${meta.id}?`, yes });
	if (!confirmed.proceed)
		fail(
			confirmed.slug,
			confirmed.slug === "declined" ? "declined" : "removing a session needs --yes without a terminal",
			confirmed.exitCode,
		);
	removeSessionAtRest(meta.id);
	return out({ sessionId: meta.id, removed: true }, `removed ${meta.id}`);
}

function replayed(sessionId: string): ReturnType<typeof replayedContextSize> {
	const bundle = readTreeBundle(sessionId);
	return replayedContextSize(bundle.entries, bundle.meta.pinnedLeafTurnId ?? undefined);
}

async function compact(
	meta: SessionMeta,
	flags: Record<string, string | boolean | undefined>,
	out: Out,
): Promise<number> {
	const instructions = typeof flags.instructions === "string" ? flags.instructions : undefined;
	if (instructions !== undefined && instructions.trim().length === 0) throw usage("--instructions takes non-empty text");
	const owner = sessionLiveOwner(meta);
	if (owner)
		fail("session_live", `session ${meta.id} is open in another process (${ownerText(owner)})`, EXIT_CODES.failed);
	const before = replayed(meta.id);
	const [{ runClioCommand }, { restoreStdout, takeOverStdout }] = await Promise.all([
		import("./clio.js"),
		import("./output-guard.js"),
	]);
	// The boot's shutdown ends in process.exit, so the document is written from inside the boot, once, with stdout
	// handed back for that write only; everything else the boot prints goes to stderr.
	let reported = false;
	const report = (document: () => number): number => {
		if (reported) return EXIT_CODES.failed;
		reported = true;
		restoreStdout();
		try {
			return document();
		} catch (error) {
			const failure =
				error instanceof Failure
					? error
					: new Failure("io", error instanceof Error ? error.message : String(error), EXIT_CODES.failed);
			writeCliFailure({
				path: ["session", "compact"],
				slug: failure.slug,
				message: failure.message,
				json: flags.json === true,
			});
			return failure.exitCode;
		} finally {
			takeOverStdout();
		}
	};
	const notCompacted = (why: string): never => fail("io", `session ${meta.id} was not compacted: ${why}`, 1);
	// A boot that refuses the session (unreadable ledger, no route) exits from inside; this still says so.
	const onExit = (code: number): void => {
		report(() => notCompacted(`its headless session ended with exit ${code}`));
	};
	process.once("exit", onExit);
	takeOverStdout();
	try {
		const code = await runClioCommand({
			headless: {
				prompt: "",
				mode: "text",
				resumeSession: { kind: "id", id: meta.id },
				compact: {
					...(instructions !== undefined ? { instructions } : {}),
					onSettled: (outcome) => report(() => compactReport(meta.id, before, outcome, out)),
				},
			},
		});
		return reported ? code : report(() => notCompacted(`its headless session ended with exit ${code}`));
	} finally {
		process.off("exit", onExit);
		restoreStdout();
	}
}

/** The document `session compact` prints once the summarizer settled, read back from the ledger on disk. */
function compactReport(
	sessionId: string,
	before: ReturnType<typeof replayedContextSize>,
	outcome: HeadlessCompactionOutcome,
	out: Out,
): number {
	if (outcome.failed)
		return fail("io", outcome.errors.join("\n") || `compacting session ${sessionId} failed`, EXIT_CODES.failed);
	const after = replayed(sessionId);
	const compacted = after.checkpointTurnId !== null && after.checkpointTurnId !== before.checkpointTurnId;
	// A notice explains an empty cut; beside a real one it is only boot chatter (an unknown window, a route note).
	const notice = compacted ? "" : outcome.notices.join("\n");
	return out(
		{
			sessionId,
			compacted,
			before: { entries: before.entries, tokens: compacted ? after.tokensBefore : null },
			after: { entries: after.entries, tokens: compacted ? after.tokensAfter : null },
			...(notice !== "" ? { notice } : {}),
		},
		compacted
			? `compacted ${sessionId}: ${before.entries} -> ${after.entries} replayed entries`
			: `nothing compacted in ${sessionId}${notice !== "" ? `: ${notice}` : ""}`,
	);
}
