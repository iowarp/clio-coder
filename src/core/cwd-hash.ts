import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The session store's bucket for a working directory: its resolved path, hashed. */
export function cwdHash(cwd: string): string {
	const normalized = resolve(cwd);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
