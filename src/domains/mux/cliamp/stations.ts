import { readClioVersion } from "../../../core/package-root.js";

/** One playable station: what the pane shows and what cliamp opens. */
export interface MusicStation {
	title: string;
	url: string;
}

/**
 * Focus stations `/music next` cycles through after the chosen one. All are
 * MP3 streams, which cliamp decodes without ffmpeg, and each one played in
 * cliamp 1.63.2 when this list was written.
 */
export const FOCUS_STATIONS: ReadonlyArray<MusicStation> = [
	// cliamp's own lo-fi radio, the default station.
	{ title: "cliamp Lofi", url: "http://radio.cliamp.stream/lofi/stream" },
	{ title: "REYFM Lofi", url: "https://listen.reyfm.de/lofi_320kbps.mp3" },
	{ title: "Lofi 24/7", url: "http://usa9.fastcast4u.com/proxy/jamz?mp=/1" },
	{ title: "Box Lofi Radio", url: "https://stream.zeno.fm/tabzverz0fctv" },
	{ title: "SomaFM Groove Salad", url: "https://ice1.somafm.com/groovesalad-128-mp3" },
	{ title: "SomaFM Drone Zone", url: "https://ice1.somafm.com/dronezone-128-mp3" },
];

/** Radio Browser's round-robin host; it redirects to a live mirror. */
const RADIO_BROWSER_SEARCH = "https://all.api.radio-browser.info/json/stations/search";
const LOOKUP_TIMEOUT_MS = 5_000;

export type StationFetch = (
	url: string,
	init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

function isStreamUrl(value: string): boolean {
	return /^https?:\/\/\S+$/i.test(value);
}

/** A readable title for a bare URL: the last path segment, else the host. */
function titleForUrl(url: string): string {
	const known = FOCUS_STATIONS.find((station) => station.url === url);
	if (known) return known.title;
	try {
		const parsed = new URL(url);
		const tail = parsed.pathname.split("/").filter(Boolean).pop();
		return tail ? decodeURIComponent(tail) : parsed.host;
	} catch {
		// isStreamUrl already admitted it; an unparsable URL still plays under its own text.
		return url;
	}
}

/**
 * Turn what the operator typed into a station: a URL plays as given, a name
 * matches the focus list first, and anything else is looked up by name in the
 * Radio Browser directory (most-voted working match). The lookup is the only
 * network call here, and it runs only for an explicit `/music station <name>`.
 */
export async function resolveStation(
	input: string,
	fetchImpl: StationFetch = fetch as unknown as StationFetch,
): Promise<MusicStation | { error: string }> {
	const wanted = input.trim();
	if (wanted.length === 0) return { error: "name a station or paste a stream URL" };
	if (isStreamUrl(wanted)) return { title: titleForUrl(wanted), url: wanted };
	const needle = wanted.toLowerCase();
	const local = FOCUS_STATIONS.find((station) => station.title.toLowerCase().includes(needle));
	if (local) return local;
	const query = new URLSearchParams({
		name: wanted,
		order: "votes",
		reverse: "true",
		hidebroken: "true",
		limit: "1",
	});
	try {
		const response = await fetchImpl(`${RADIO_BROWSER_SEARCH}?${query.toString()}`, {
			// Radio Browser asks every client to identify itself.
			headers: { "User-Agent": `clio-coder/${readClioVersion()}` },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		if (!response.ok) return { error: `Radio Browser answered HTTP ${response.status} for "${wanted}"` };
		const body = await response.json();
		const first = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
		const url = typeof first?.url_resolved === "string" && first.url_resolved ? first.url_resolved : first?.url;
		if (typeof url !== "string" || !isStreamUrl(url)) return { error: `no station named "${wanted}" in Radio Browser` };
		const title = typeof first?.name === "string" && first.name.trim() ? first.name.trim() : titleForUrl(url);
		return { title, url };
	} catch (err) {
		return { error: `station lookup failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** The playlist `/music` loads: the chosen station first, then the focus list. */
export function stationPlaylist(first: MusicStation): MusicStation[] {
	return [first, ...FOCUS_STATIONS.filter((station) => station.url !== first.url)];
}
