import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const YAZI_STREAM_POLL_MS = 250;
export const YAZI_STREAM_MAX_BYTES = 1024 * 1024;

export interface YaziCdEvent {
	kind: "cd";
	receiver: string;
	sender: string;
	tab: string;
	cwd: string;
}

export interface YaziPickEvent {
	kind: "clio-pick";
	receiver: string;
	sender: string;
	values: ReadonlyArray<string>;
}

export type YaziEvent = YaziCdEvent | YaziPickEvent;
export type YaziEventStreamStopReason = "stopped" | "pane-gone" | "file-missing" | "size-cap";

export interface YaziEventStreamStats {
	bytesRead: number;
	linesRead: number;
	malformedLines: number;
	lastLineAt: number | null;
	stopReason: YaziEventStreamStopReason | null;
}

export type YaziStreamLog = (level: "debug" | "warning", message: string) => void;

export interface YaziEventStreamOptions {
	path: string;
	onEvent: (event: YaziEvent) => void;
	isAlive: () => boolean | Promise<boolean>;
	log?: YaziStreamLog;
	now?: () => number;
	pollMs?: number;
	maxBytes?: number;
	autoStart?: boolean;
}

export interface YaziEventStream {
	poll(): Promise<void>;
	stop(reason?: YaziEventStreamStopReason): void;
	stats(): Readonly<YaziEventStreamStats>;
	done: Promise<YaziEventStreamStopReason>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the four DDS fields with the same three-comma split Yazi uses. */
export function parseYaziEventLine(line: string): YaziEvent | null {
	const first = line.indexOf(",");
	const second = first < 0 ? -1 : line.indexOf(",", first + 1);
	const third = second < 0 ? -1 : line.indexOf(",", second + 1);
	if (first <= 0 || second <= first + 1 || third <= second + 1) return null;
	const kind = line.slice(0, first);
	if (kind !== "cd" && kind !== "clio-pick") return null;
	const receiver = line.slice(first + 1, second);
	const sender = line.slice(second + 1, third);
	try {
		const body: unknown = JSON.parse(line.slice(third + 1));
		if (kind === "cd") {
			if (!record(body) || typeof body.url !== "string") return null;
			const tab = body.tab;
			if (typeof tab !== "number" && typeof tab !== "string") return null;
			return { kind, receiver, sender, tab: String(tab), cwd: body.url };
		}
		if (!Array.isArray(body) || !body.every((value) => typeof value === "string")) return null;
		return { kind, receiver, sender, values: body };
	} catch {
		return null;
	}
}

/** Poll-tail one bounded DDS stdout file without knowing anything about panes or composers. */
export function createYaziEventStream(options: YaziEventStreamOptions): YaziEventStream {
	const log = options.log ?? ((): void => undefined);
	const now = options.now ?? Date.now;
	const maxBytes = options.maxBytes ?? YAZI_STREAM_MAX_BYTES;
	let offset = 0;
	let carry = "";
	let decoder = new StringDecoder("utf8");
	let stopped = false;
	let polling = false;
	let interval: NodeJS.Timeout | null = null;
	let settleDone: (reason: YaziEventStreamStopReason) => void = () => {};
	const done = new Promise<YaziEventStreamStopReason>((resolve) => {
		settleDone = resolve;
	});
	const state: YaziEventStreamStats = {
		bytesRead: 0,
		linesRead: 0,
		malformedLines: 0,
		lastLineAt: null,
		stopReason: null,
	};

	const stop = (reason: YaziEventStreamStopReason = "stopped"): void => {
		if (stopped) return;
		stopped = true;
		state.stopReason = reason;
		if (interval) clearInterval(interval);
		interval = null;
		log(reason === "size-cap" ? "warning" : "debug", `yazi event stream stopped (${reason}): ${options.path}`);
		settleDone(reason);
	};

	const poll = async (): Promise<void> => {
		if (stopped || polling) return;
		polling = true;
		try {
			if (!(await options.isAlive())) {
				stop("pane-gone");
				return;
			}
			const stat = statSync(options.path, { throwIfNoEntry: false });
			if (!stat?.isFile()) {
				stop("file-missing");
				return;
			}
			if (stat.size > maxBytes) {
				stop("size-cap");
				return;
			}
			if (stat.size < offset) {
				offset = 0;
				carry = "";
				decoder = new StringDecoder("utf8");
			}
			const remaining = stat.size - offset;
			if (remaining <= 0) return;
			const bytes = Buffer.allocUnsafe(remaining);
			const fd = openSync(options.path, "r");
			let read = 0;
			try {
				read = readSync(fd, bytes, 0, remaining, offset);
			} finally {
				closeSync(fd);
			}
			offset += read;
			state.bytesRead += read;
			const complete = `${carry}${decoder.write(bytes.subarray(0, read))}`.split("\n");
			carry = complete.pop() ?? "";
			for (const raw of complete) {
				const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
				if (line.length === 0) continue;
				const kind = line.slice(0, line.indexOf(","));
				if (kind !== "cd" && kind !== "clio-pick") continue;
				const event = parseYaziEventLine(line);
				if (!event) {
					state.malformedLines += 1;
					continue;
				}
				state.linesRead += 1;
				state.lastLineAt = now();
				try {
					options.onEvent(event);
				} catch (error) {
					log("warning", `yazi event consumer failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} finally {
			polling = false;
		}
	};

	if (options.autoStart !== false) {
		interval = setInterval(() => void poll(), options.pollMs ?? YAZI_STREAM_POLL_MS);
		interval.unref();
		void poll();
	}
	return { poll, stop, stats: () => ({ ...state }), done };
}
