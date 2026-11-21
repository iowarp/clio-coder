/**
 * The browser tool's host-driver protocol: one NDJSON object per line on the driver's stdin and stdout. Types only;
 * the driver process imports nothing else from Clio.
 */

export interface BrowserViewport {
	width: number;
	height: number;
}

export interface BrowserInit {
	op: "init";
	id: number;
	playwrightEntry: string;
	browsersPath: string;
	channel?: "msedge";
	/** Session scratch: screenshots, offloaded snapshots, the browser profile. */
	scratchDir: string;
	/** Relative `file` scripts resolve here. */
	workspace: string;
	viewport: BrowserViewport;
	/** Hosts besides loopback the page may reach. */
	grantedHosts: string[];
}

export interface BrowserOpenRequest {
	op: "open";
	id: number;
	url: string;
	page?: string;
	viewport?: BrowserViewport;
	grantHosts?: string[];
}

export interface BrowserRunRequest {
	op: "run";
	id: number;
	script?: string;
	file?: string;
	page?: string;
	timeoutMs: number;
}

export interface BrowserLookRequest {
	op: "look";
	id: number;
	page?: string;
	target?: string;
	snapshot: boolean;
	screenshot: boolean;
	fullPage: boolean;
}

export interface BrowserCloseRequest {
	op: "close";
	id: number;
	page?: string;
}

export interface BrowserCancelRequest {
	op: "cancel";
	id: number;
	target: number;
}

export type BrowserRequest =
	| BrowserInit
	| BrowserOpenRequest
	| BrowserRunRequest
	| BrowserLookRequest
	| BrowserCloseRequest
	| BrowserCancelRequest;

export interface BrowserConsoleRecord {
	level: string;
	text: string;
	url?: string;
	line?: number;
	count: number;
}

export interface BrowserRequestRecord {
	method: string;
	url: string;
	status?: number;
	error?: string;
	resource?: string;
	count: number;
}

/** Page events since the previous call: errors and warnings, uncaught exceptions, failed requests. */
export interface BrowserEventDelta {
	console: BrowserConsoleRecord[];
	exceptions: BrowserConsoleRecord[];
	failedRequests: BrowserRequestRecord[];
	/** Records past the per-kind cap. */
	dropped: number;
}

export interface BrowserShot {
	path: string;
	viewport: string;
}

export interface BrowserPageFacts {
	page: string;
	url: string;
	title: string;
	status?: number;
}

export interface BrowserSnapshot {
	text: string;
	lines: number;
	shownLines: number;
	/** Full snapshot when it was larger than the cap. */
	offloadPath?: string;
	/** Search mode: how many nodes matched the target. */
	matches?: number;
}

export interface BrowserReplyBody {
	pageFacts?: BrowserPageFacts;
	pages?: BrowserPageFacts[];
	snapshot?: BrowserSnapshot;
	/** JSON text of a script's return value, capped. */
	value?: string;
	logs?: string[];
	actions?: string[];
	shots?: BrowserShot[];
	events?: BrowserEventDelta;
	closed?: "page" | "session";
	engine?: string;
}

export type BrowserReply =
	| ({ id: number; ok: true } & BrowserReplyBody)
	| ({ id: number; ok: false; error: string; cancelled?: boolean; timedOut?: boolean } & BrowserReplyBody);
