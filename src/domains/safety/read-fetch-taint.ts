import { ToolNames } from "../../core/tool-names.js";
import {
	HOME_AGENT_SECRET_RELATIVE_PATHS,
	HOME_SECRET_RELATIVE_PATHS,
	WORKSPACE_SECRET_PATHS,
} from "./secret-paths.js";

/**
 * Read-then-fetch taint. Once a call that reads a secret-bearing file is
 * admitted, an outbound web_read or web_fetch whose URL has room for data
 * built from local content (a query string, a fragment, userinfo, or a long
 * opaque path segment) asks instead of running unasked. Under yolo the ask
 * goes to the judge, which refuses an exfiltrating fetch. A bare address
 * carries nothing and stays allowed.
 */
export const SECRET_READ_THEN_FETCH_RULE_ID = "secret-read-then-fetch";

const SECRET_PATTERNS: ReadonlyArray<ReadonlyArray<RegExp>> = [
	...WORKSPACE_SECRET_PATHS,
	...HOME_SECRET_RELATIVE_PATHS,
	...HOME_AGENT_SECRET_RELATIVE_PATHS,
].map((pattern) =>
	pattern
		.replace(/\/+$/, "")
		.split("/")
		.map((segment) => new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`)),
);

/** True when some run of the path's segments names a known secret-bearing file or directory. */
export function isSecretBearingPath(target: string): boolean {
	const segments = target.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
	return SECRET_PATTERNS.some((pattern) => {
		for (let start = 0; start + pattern.length <= segments.length; start++) {
			if (pattern.every((re, i) => re.test(segments[start + i] ?? ""))) return true;
		}
		return false;
	});
}

/** An opaque path segment this long can hold an encoded value. */
const CARRIER_SEGMENT_MIN = 20;

/** True when the URL has a place to put data drawn from local content. */
export function urlCouldCarryLocalData(raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		// An address that does not parse cannot be shown to carry nothing.
		return true;
	}
	if (url.search.length > 1 || url.hash.length > 1 || url.username !== "" || url.password !== "") return true;
	return url.pathname
		.split("/")
		.some((segment) => segment.length >= CARRIER_SEGMENT_MIN && /^[A-Za-z0-9+=_%-]+$/.test(segment));
}

export function isOutboundWebTool(tool: string): boolean {
	return tool === ToolNames.WebRead || tool === ToolNames.WebFetch;
}
