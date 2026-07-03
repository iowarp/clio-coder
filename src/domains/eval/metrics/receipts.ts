import { readFileSync } from "node:fs";

export function receiptTokenTotal(receiptPath: string): number {
	try {
		const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
		const value = parsed.tokenCount ?? parsed.totalTokens;
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	} catch {
		return 0;
	}
}
