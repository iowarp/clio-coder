import path from "node:path";
import {
	type DataRefusal,
	type InspectDataOptions,
	type InspectDataResult,
	inspectData,
	isDataRefusal,
	type SelectDataOptions,
	type SelectDataResult,
	selectData,
	type ValidateDataOptions,
	type ValidateDataResult,
	validateData,
} from "../data/index.js";
import {
	commitObservationReservation,
	finalizeObservation,
	type ObservationUnit,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import { resolveToCwd } from "../path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import { DATA_OBSERVATION_SELF_CAP_BYTES } from "./caps.js";
import {
	DATA_OPS,
	DATA_TOOL_NAME,
	type DataOp,
	dataToolSurface,
	headerArg,
	prepareDataAdmissionArguments,
	prepareDataArguments,
} from "./data-surface.js";

export { DATA_OBSERVATION_SELF_CAP_BYTES } from "./caps.js";
export { DATA_TOOL_NAME, dataToolSurface, prepareDataArguments } from "./data-surface.js";

/**
 * The `data` capability: structured-data inspection, selection, and
 * validation over CSV/TSV, JSON, and JSON Lines through the streaming readers
 * in src/tools/data. This module owns only the tool contract: argument
 * normalization, path resolution against the workspace, the observation
 * envelope for large results, and the mapping of a typed refusal to a tool
 * error. Every scientific-integrity rule (exact versus sampled views, large
 * integers reported rather than rounded, sentinels counted rather than
 * converted) lives in the readers and is reported verbatim.
 */

export interface DataToolDeps {
	getCwd?: () => string;
}

interface CountedResult {
	unit: ObservationUnit;
	shownCount: number;
	totalCount: number | null;
	truncated: boolean;
	next?: string;
}

type DataResult = InspectDataResult | SelectDataResult | ValidateDataResult;

function isDataOp(value: string): value is DataOp {
	return (DATA_OPS as ReadonlyArray<string>).includes(value);
}

/** Honest envelope counts read off the reader's own result; the readers never guess. */
function countResult(op: DataOp, payload: DataResult): CountedResult {
	if (op === "select") {
		const result = payload as unknown as Record<string, unknown>;
		const rows = result.rows ?? result.records ?? result.elements;
		const returned = typeof result.returned === "number" ? result.returned : Array.isArray(rows) ? rows.length : 1;
		const offset = typeof result.offset === "number" ? result.offset : 0;
		const limit = typeof result.limit === "number" ? result.limit : returned;
		const hasMore = result.hasMore === true;
		const total = typeof result.total === "number" ? result.total : hasMore ? null : offset + returned;
		return {
			unit: "entries",
			shownCount: returned,
			totalCount: total,
			truncated: hasMore,
			...(hasMore ? { next: `offset=${offset + limit}` } : {}),
		};
	}
	return { unit: "results", shownCount: 1, totalCount: 1, truncated: false };
}

/**
 * One word for the reader's view flags, so a transcript row never calls a
 * budget cut a sample: all three flags false means a value was cut to the
 * capture budget, which is neither a sampled scan nor a converted one.
 */
function describeDataView(view: unknown): string {
	const flags = typeof view === "object" && view !== null ? (view as Record<string, unknown>) : {};
	if (flags.exact === true) return "exact";
	const parts = [...(flags.sampled === true ? ["sampled"] : []), ...(flags.converted === true ? ["converted"] : [])];
	return parts.length > 0 ? parts.join(", ") : "value cut to budget";
}

function refusalResult(op: DataOp, refusal: DataRefusal): ToolResult {
	return {
		kind: "error",
		message: `data: ${op} refused (${refusal.reason}): ${refusal.message}`,
		details: { refusal },
	};
}

export function createDataTool(deps: DataToolDeps = {}): ToolSpec {
	const getCwd = deps.getCwd ?? (() => process.cwd());
	return {
		...dataToolSurface,
		prepareAdmissionArguments: (args) => prepareDataAdmissionArguments(args, getCwd()),
		async run(rawArgs, options?: ToolInvokeOptions): Promise<ToolResult> {
			const args = prepareDataArguments(rawArgs);
			const op = typeof args.op === "string" ? args.op : "";
			if (!isDataOp(op)) {
				return { kind: "error", message: `data: op must be inspect, select, or validate; got '${op}'` };
			}
			if (typeof args.path !== "string" || args.path.trim().length === 0) {
				return { kind: "error", message: "data: path is required" };
			}
			const target = resolveToCwd(args.path.trim(), getCwd());
			const reservation = reserveObservation(DATA_OBSERVATION_SELF_CAP_BYTES, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: DATA_TOOL_NAME,
					unit: op === "select" ? "entries" : "results",
					reservation,
					subject: `${op} ${path.relative(getCwd(), target) || target}`,
					hint: "Continue in a follow-up turn.",
				});
			}
			// The readers stream and await between reserve and finalize, so the
			// cap is charged up front and reconciled when the result settles.
			commitObservationReservation(reservation);
			try {
				const format = typeof args.format === "string" ? args.format : undefined;
				const delimiter = typeof args.delimiter === "string" ? args.delimiter : undefined;
				const header = headerArg(args.header);
				const signal = options?.signal;
				let result: DataResult | DataRefusal;
				if (op === "inspect") {
					const inspectOptions: InspectDataOptions = {
						...(format !== undefined ? { format } : {}),
						...(delimiter !== undefined ? { delimiter } : {}),
						...(header !== undefined ? { header } : {}),
						...(typeof args.sample_rows === "number" ? { sampleRows: args.sample_rows } : {}),
						...(args.max_rows === null || typeof args.max_rows === "number" ? { maxRows: args.max_rows } : {}),
						signal,
					};
					result = await inspectData(target, inspectOptions);
				} else if (op === "select") {
					const selectOptions: SelectDataOptions = {
						...(format !== undefined ? { format } : {}),
						...(delimiter !== undefined ? { delimiter } : {}),
						...(header !== undefined ? { header } : {}),
						...(typeof args.offset === "number" ? { offset: args.offset } : {}),
						...(typeof args.limit === "number" ? { limit: args.limit } : {}),
						...(Array.isArray(args.columns) ? { columns: args.columns as Array<string | number> } : {}),
						...(typeof args.pointer === "string" ? { pointer: args.pointer } : {}),
						signal,
					};
					result = await selectData(target, selectOptions);
				} else {
					const validateOptions: ValidateDataOptions = {
						...(format !== undefined ? { format } : {}),
						...(delimiter !== undefined ? { delimiter } : {}),
						...(header !== undefined ? { header } : {}),
						...(args.max_rows === null || typeof args.max_rows === "number" ? { maxRows: args.max_rows } : {}),
						signal,
					};
					result = await validateData(target, validateOptions);
				}
				if (isDataRefusal(result)) {
					releaseObservation(reservation);
					return refusalResult(op, result);
				}
				const counted = countResult(op, result);
				return finalizeObservation({
					tool: DATA_TOOL_NAME,
					unit: counted.unit,
					format: "json",
					output: JSON.stringify(result),
					shownCount: counted.shownCount,
					totalCount: counted.totalCount,
					truncated: counted.truncated,
					...(counted.next !== undefined ? { next: counted.next } : {}),
					details: { op, path: target, format: result.format, view: result.view, viewLabel: describeDataView(result.view) },
					reservation,
					...(options ? { options } : {}),
				});
			} catch (error) {
				releaseObservation(reservation);
				return { kind: "error", message: `data: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}

export const dataTool: ToolSpec = createDataTool();
