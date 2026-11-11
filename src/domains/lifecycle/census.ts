import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";

/**
 * The opt-in census (R-23): when the operator turned it on and named an endpoint, one GET a calendar month for a static
 * file named by the Clio minor version and the platform. No identifier, query, body or header: the client stamp file is
 * what keeps it to one request a month, so counting requests counts installs. Off, or on without an endpoint, it reads
 * and writes nothing and sends nothing.
 */
export interface CensusSettings {
	census: "off" | "on";
	censusEndpoint: string;
}

export type CensusOutcome = "off" | "no-endpoint" | "disabled" | "counted" | "sent" | "failed";

interface CensusState {
	version: 1;
	lastMonth: string | null;
}

const CENSUS_FILE = "census.json";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function osName(platform: NodeJS.Platform): string {
	return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : "other";
}

/**
 * The exact URL a joined install requests: `<endpoint>/v1/<minor>/<os>.txt`. Null when the endpoint is empty or not an
 * https URL (http only to loopback) without credentials, query or fragment: an unusable endpoint fails closed.
 */
export function censusUrl(
	endpoint: string,
	version: string,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const trimmed = endpoint.trim();
	if (trimmed === "") return null;
	const minor = /^(\d+)\.(\d+)\./u.exec(version);
	if (!minor) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
	if (url.username || url.password || url.search || url.hash) return null;
	return `${url.href.replace(/\/+$/u, "")}/v1/${minor[1]}.${minor[2]}/${osName(platform)}.txt`;
}

function readState(path: string): CensusState {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CensusState>;
		return { version: 1, lastMonth: typeof parsed.lastMonth === "string" ? parsed.lastMonth : null };
	} catch {
		return { version: 1, lastMonth: null };
	}
}

/**
 * Count this install once for the current UTC month. The month is claimed in the stamp file under its lock before the
 * request, so concurrent processes send one request and a failed request is a missed month, never a second one.
 */
export async function runCensus(input: {
	stateDir: string;
	settings: CensusSettings | undefined;
	version: string;
	now?: Date;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}): Promise<CensusOutcome> {
	if (input.settings?.census !== "on") return "off";
	const env = input.env ?? process.env;
	if (env.CLIO_CODER_UPDATE_CHECK === "0" || env.NO_UPDATE_NOTIFIER || env.CI) return "disabled";
	const url = censusUrl(input.settings.censusEndpoint, input.version, input.platform);
	if (url === null) return "no-endpoint";
	const month = (input.now ?? new Date()).toISOString().slice(0, 7);
	const path = join(input.stateDir, CENSUS_FILE);
	const claimed = withStateFileLockSync(path, () => {
		if (readState(path).lastMonth === month) return false;
		writeFileSync(path, `${JSON.stringify({ version: 1, lastMonth: month } satisfies CensusState)}\n`, { mode: 0o600 });
		return true;
	});
	if (!claimed) return "counted";
	try {
		await (input.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(2500) });
		return "sent";
	} catch {
		return "failed";
	}
}
