/**
 * The one live-disk implementation of `ResultContractFilesystem`.
 *
 * `result-contract.ts` takes filesystem access as an argument so the validators
 * stay deterministic and testable without touching a disk. That leaves every
 * caller to supply the same three accessors, and the worker and the
 * orchestrator had each written their own copy. A capability added to the
 * interface then lands in one of them and not the other, which is how a Scout
 * citation could ground inside the worker's repair rounds and fail the
 * orchestrator's sealed revalidation of the identical result. One factory, both
 * callers, no drift.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ResultContractFilesystem } from "./result-contract.js";

export function nodeResultContractFilesystem(): ResultContractFilesystem {
	return {
		readFile(filePath) {
			try {
				return readFileSync(filePath, "utf8");
			} catch {
				return null;
			}
		},
		pathExists(filePath) {
			return existsSync(filePath);
		},
		isDirectory(filePath) {
			return statSync(filePath, { throwIfNoEntry: false })?.isDirectory() === true;
		},
	};
}
