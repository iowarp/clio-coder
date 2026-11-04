/** Every decision point. Adding one is a module here, one export below and one `ask` at a place that already waits. */

export { boundedHead, boundedTail, boundedTailLines, probability, round2, withoutQuotedCode } from "./bounds.js";
export type {
	ConsultFilterMatch,
	ConsultFilterObject,
	ConsultFilterValue,
	ConsultObject,
	ConsultReading,
	ConsultValue,
} from "./consult.js";
export {
	CONSULT_DEADLINE_MS,
	CONSULT_FILTER_MAX_CHARS,
	CONSULT_MAX_FILE_CHARS,
	CONSULT_MAX_FILES,
	consultFilterPoint,
	consultPoint,
	fitFilterItems,
	smallestRequestWindow,
} from "./consult.js";
