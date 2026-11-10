import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { observeFileHash } from "../../core/run-records.js";
import { isRecordsTag, validateBlobName, validateTagName } from "../../core/store-paths.js";
import { openStoreBackend, type StoreBackend, type StoreBlobStat, StoreRefusal } from "../../domains/store/index.js";
import { buildPutRecord } from "../../domains/store/provenance.js";
import {
	appendRecord,
	currentState,
	driftOf,
	readBlobHistory,
	type StoreRecord,
	summarizeRecords,
} from "../../domains/store/records.js";
import { STORE_OBSERVATION_SELF_CAP_BYTES } from "../gateway/caps.js";
import {
	commitObservationReservation,
	finalizeObservation,
	type ObservationUnit,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import {
	prepareStoreAdmissionArguments,
	prepareStoreArguments,
	STORE_OPS,
	STORE_TOOL_NAME,
	type StoreOp,
	storeToolSurface,
} from "./surface.js";

/**
 * The `store` capability over the project's store backend. This module owns
 * the tool contract only: name validation, the workspace confinement of a
 * put's source, the observation envelope, and the mapping of a
 * `StoreRefusal` to a tool error. Bytes live in the backend; what Clio
 * observed about them lives in the records (`src/domains/store/records.ts`).
 */

export interface StoreToolDeps {
	getCwd?: () => string;
	/** False in a worker: the dispatching session puts results. */
	writable: boolean;
}

const WRITE_OPS: ReadonlySet<StoreOp> = new Set(["create", "put", "note", "remove"]);
const READ_ONLY_REFUSAL =
	"store: this session can read the store but not write to it; the dispatching session puts results";
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

interface OpResult {
	payload: unknown;
	unit: ObservationUnit;
	shown: number;
	total: number | null;
	truncated?: boolean;
	next?: string;
}

class StoreToolError extends Error {}

function isStoreOp(value: string): value is StoreOp {
	return (STORE_OPS as ReadonlyArray<string>).includes(value);
}

function requireString(args: Record<string, unknown>, key: string, op: StoreOp): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) throw new StoreToolError(`store: ${op} needs ${key}`);
	return value;
}

function checkTag(tag: string): string {
	const problem = validateTagName(tag);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
	return tag;
}

function checkBlob(blob: string): string {
	const problem = validateBlobName(blob);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
	return blob;
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `<tag>:<blob>` refs split at the first `:`, each blob confirmed to exist. */
async function derivedRefs(backend: StoreBackend, refs: string[]): Promise<Array<{ tag: string; blob: string }>> {
	const out: Array<{ tag: string; blob: string }> = [];
	for (const ref of refs) {
		const colon = ref.indexOf(":");
		if (colon <= 0 || colon === ref.length - 1) {
			throw new StoreRefusal("invalid-name", `derived_from entry '${ref}' is not <tag>:<blob>.`);
		}
		const tag = checkTag(ref.slice(0, colon));
		const blob = checkBlob(ref.slice(colon + 1));
		if ((await backend.statBlob(tag, blob)) === null) {
			throw new StoreRefusal("not-found", `derived_from names ${tag}:${blob}, which is not in the store.`);
		}
		out.push({ tag, blob });
	}
	return out;
}

async function requireTag(backend: StoreBackend, tag: string): Promise<void> {
	if (!(await backend.tagExists(tag))) {
		throw new StoreRefusal("not-found", `tag '${tag}' does not exist; create it with op=create.`);
	}
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The put's source: a regular file whose real path stays inside the workspace root. */
function workspaceSource(cwd: string, given: string): { abs: string; rel: string; bytes: number } {
	const resolved = path.resolve(cwd, given);
	let real: string;
	let root: string;
	try {
		root = realpathSync(cwd);
		real = realpathSync(resolved);
	} catch {
		throw new StoreRefusal("not-found", `${given} does not exist.`);
	}
	if (!isInside(root, real)) {
		throw new StoreRefusal("not-a-file", `${given} resolves outside the workspace; put stores workspace files only.`);
	}
	const stat = statSync(real);
	if (!stat.isFile()) throw new StoreRefusal("not-a-file", `${given} is not a regular file.`);
	return { abs: real, rel: path.relative(root, real), bytes: stat.size };
}

async function backendSummary(backend: StoreBackend): Promise<{ kind: string; tier: null; reason: string }> {
	const facts = await backend.facts();
	return {
		kind: facts.kind,
		tier: null,
		reason: facts.tiers === false ? "this backend has no storage tiers" : "tier placement is not reported yet",
	};
}

/** The `stat` shape: what Clio recorded and whether the bytes still match it. No path: `get` produces one. */
async function statShape(backend: StoreBackend, tag: string, blob: string, stat: StoreBlobStat | null) {
	const state = currentState((await readBlobHistory(backend, tag, blob)).records);
	const put = state.put;
	if (stat === null && put === null) {
		const removed = state.removed ? "; it was removed and its records remain" : "";
		throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store${removed}.`);
	}
	return {
		ref: `${tag}:${blob}`,
		bytes: stat?.bytes ?? null,
		modified: stat === null ? null : new Date(stat.modifiedMs).toISOString(),
		drift: driftOf(put, stat),
		identity: put?.identity ?? null,
		generatedBy: put?.generatedBy ?? "no producing run on record",
		used: put?.used ?? [],
		producedBy: put?.producedBy ?? null,
		notes: state.notes.map((record: StoreRecord) => ({
			at: record.at,
			...(record.note !== undefined ? { note: record.note } : {}),
			...(record.used !== undefined ? { used: record.used } : {}),
		})),
		receipt: put?.receipt ?? null,
		...(state.removed ? { removed: true } : {}),
		backend: await backendSummary(backend),
	};
}

async function runOp(
	op: StoreOp,
	args: Record<string, unknown>,
	cwd: string,
	backend: StoreBackend,
	options: ToolInvokeOptions | undefined,
): Promise<OpResult> {
	const signal = options?.signal;
	const ids = {
		...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
	};
	const producedBy = { actor: "main" as const, ...ids };
	if (op === "tags") {
		const names = (await backend.listTags()).filter((tag) => !isRecordsTag(tag));
		const tags = [];
		for (const tag of names) {
			const xattrs = await backend.getTagXattrs(tag);
			tags.push({
				tag,
				...(xattrs["clio.description"] !== undefined ? { description: xattrs["clio.description"] } : {}),
				...(xattrs["clio.class"] !== undefined ? { class: xattrs["clio.class"] } : {}),
			});
		}
		return {
			payload: {
				tags,
				...(tags.length === 0 ? { hint: "The store has no tags yet; create one with op=create." } : {}),
				backend: await backend.facts(),
			},
			unit: "entries",
			shown: tags.length,
			total: tags.length,
		};
	}
	const tag = checkTag(requireString(args, "tag", op));
	if (op === "create") {
		const { created } = await backend.getOrCreateTag(tag);
		if (created) {
			const description = typeof args.description === "string" ? args.description : "";
			const tagClass = typeof args.class === "string" ? args.class : "output";
			await backend.setTagXattr(tag, "clio.description", description);
			await backend.setTagXattr(tag, "clio.class", tagClass);
			await backend.setTagXattr(tag, "clio.createdAt", new Date().toISOString());
		}
		return {
			payload: { tag, created, xattrs: await backend.getTagXattrs(tag) },
			unit: "results",
			shown: 1,
			total: 1,
		};
	}
	if (op === "list") {
		await requireTag(backend, tag);
		const offset = intArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = intArg(args.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT);
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : undefined;
		const { names, hasMore } = await backend.listBlobs(tag, {
			...(pattern !== undefined ? { pattern } : {}),
			offset,
			limit,
		});
		const summary = await summarizeRecords(backend, tag, names);
		const blobs = [];
		for (const blob of names) {
			const stat = await backend.statBlob(tag, blob);
			blobs.push({ blob, bytes: stat?.bytes ?? null, recorded: summary.get(blob)?.recorded ?? null });
		}
		return {
			payload: { tag, offset, blobs, hasMore },
			unit: "entries",
			shown: blobs.length,
			total: hasMore ? null : offset + blobs.length,
			truncated: hasMore,
			...(hasMore ? { next: `offset=${offset + blobs.length}` } : {}),
		};
	}
	if (op === "put") {
		const source = workspaceSource(cwd, requireString(args, "path", op));
		const blob = checkBlob(typeof args.blob === "string" && args.blob.length > 0 ? args.blob : path.basename(source.rel));
		await requireTag(backend, tag);
		const derived = await derivedRefs(backend, stringList(args.derived_from));
		const replaced = (await backend.statBlob(tag, blob)) !== null;
		const stored = await backend.putBlobFromFile(tag, blob, source.abs, signal);
		try {
			const { path: storedPath } = await backend.getBlobAsPath(tag, blob, signal);
			const hash = await observeFileHash(storedPath, stored.bytes, signal);
			const record = await buildPutRecord({
				backend,
				cwd,
				tag,
				blob,
				sourceAbs: source.abs,
				stat: stored,
				hash,
				receipt: { backend: backend.kind, key: storedPath, version: stored.version },
				actor: "main",
				ids,
				...(typeof args.note === "string" ? { note: args.note } : {}),
				derivedFrom: derived,
			});
			await appendRecord(backend, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new StoreToolError(
				`store: put stored ${tag}:${blob} but could not record it (${reason}); stat will show drift "unrecorded".`,
			);
		}
		return {
			payload: {
				...(await statShape(backend, tag, blob, stored)),
				replaced,
				source: { path: source.rel, bytes: source.bytes },
			},
			unit: "results",
			shown: 1,
			total: 1,
		};
	}
	const blob = checkBlob(requireString(args, "blob", op));
	if (op === "stat") {
		return {
			payload: await statShape(backend, tag, blob, await backend.statBlob(tag, blob)),
			unit: "results",
			shown: 1,
			total: 1,
		};
	}
	if (op === "get") {
		const got = await backend.getBlobAsPath(tag, blob, signal);
		const stat = await backend.statBlob(tag, blob);
		return {
			payload: { ref: `${tag}:${blob}`, path: got.path, copied: got.copied, bytes: stat?.bytes ?? null },
			unit: "results",
			shown: 1,
			total: 1,
		};
	}
	if (op === "note") {
		if ((await backend.statBlob(tag, blob)) === null) {
			throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store.`);
		}
		const derived = await derivedRefs(backend, stringList(args.derived_from));
		const record = await appendRecord(backend, {
			kind: "note",
			tag,
			blob,
			producedBy,
			...(typeof args.note === "string" ? { note: args.note } : {}),
			...(derived.length > 0 ? { used: derived.map((ref) => ({ ...ref, sha256: null })) } : {}),
		});
		return { payload: { ref: `${tag}:${blob}`, noted: record }, unit: "results", shown: 1, total: 1 };
	}
	const last = currentState((await readBlobHistory(backend, tag, blob)).records).put;
	if (!(await backend.delBlob(tag, blob))) {
		throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store.`);
	}
	await appendRecord(backend, {
		kind: "remove",
		tag,
		blob,
		producedBy,
		...(last?.identity !== undefined ? { identity: last.identity } : {}),
	});
	return { payload: { ref: `${tag}:${blob}`, removed: true }, unit: "results", shown: 1, total: 1 };
}

export function createStoreTool(deps: StoreToolDeps): ToolSpec {
	const getCwd = deps.getCwd ?? (() => process.cwd());
	return {
		...storeToolSurface,
		prepareAdmissionArguments: (args) => prepareStoreAdmissionArguments(args, getCwd()),
		async run(rawArgs, options?: ToolInvokeOptions): Promise<ToolResult> {
			const args = prepareStoreArguments(rawArgs);
			const op = typeof args.op === "string" ? args.op : "";
			if (!isStoreOp(op)) {
				return { kind: "error", message: `store: op must be one of ${STORE_OPS.join(", ")}; got '${op}'` };
			}
			if (!deps.writable && WRITE_OPS.has(op)) return { kind: "error", message: READ_ONLY_REFUSAL };
			const reservation = reserveObservation(STORE_OBSERVATION_SELF_CAP_BYTES, options);
			const subject = typeof args.tag === "string" ? `${op} ${args.tag}` : op;
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: STORE_TOOL_NAME,
					unit: op === "list" || op === "tags" ? "entries" : "results",
					format: "json",
					reservation,
					subject,
					hint: "Continue in a follow-up turn.",
				});
			}
			commitObservationReservation(reservation);
			try {
				const cwd = getCwd();
				const result = await runOp(op, args, cwd, await openStoreBackend(cwd), options);
				return finalizeObservation({
					tool: STORE_TOOL_NAME,
					unit: result.unit,
					format: "json",
					output: JSON.stringify(result.payload),
					shownCount: result.shown,
					totalCount: result.total,
					truncated: result.truncated ?? false,
					...(result.next !== undefined ? { next: result.next } : {}),
					details: { op },
					reservation,
					...(options ? { options } : {}),
				});
			} catch (error) {
				releaseObservation(reservation);
				if (error instanceof StoreRefusal) {
					return {
						kind: "error",
						message: `store: ${op} refused (${error.reason}): ${error.message}`,
						details: { reason: error.reason },
					};
				}
				return {
					kind: "error",
					message:
						error instanceof StoreToolError
							? error.message
							: `store: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},
	};
}
