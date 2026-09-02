/**
 * First-turn envelope measurement: what Clio actually puts on the wire.
 *
 * The compiled system prompt is roughly a third of what the model reads. The
 * rest is attached tool definitions, their descriptions and prompt hints, and
 * whatever skill routing material rides along. None of that appears in the
 * prompt manifest, so `tokenEstimate` cannot be gated on the budget the mandate
 * actually sets, and `tokens.input` from a trial record is worse still: it is
 * summed across every assistant message, so a run that made more calls looks
 * like it had a bigger prompt.
 *
 * The instrument here is a recording proxy plus differential probing.
 *
 *   1. A pass-through HTTP proxy sits between an arm and the real endpoint and
 *      writes every request body to disk verbatim. The arm is not modified and
 *      does not know. The first `POST /v1/chat/completions` of a fresh session
 *      *is* the first-turn wire payload, with no inference required.
 *   2. That captured payload is replayed against the same endpoint with
 *      `max_tokens: 1`, once whole and once per component with the component
 *      removed. The provider reports `prompt_tokens` each time, so the marginal
 *      cost of a component is a subtraction under the model's own tokenizer and
 *      chat template rather than a `chars/4` guess.
 *
 * Two consequences worth stating because they are easy to get wrong:
 *
 *   - Per-component marginals do not sum to the whole. Dropping every tool also
 *     drops the template's tool scaffolding, so `toolsBlockTotal` exceeds the
 *     sum of the per-tool marginals. The difference is reported as `scaffold`
 *     rather than silently distributed, because it is real and it is not
 *     attributable to any one tool.
 *   - A truncated or refused replay is never folded into a number. `probe`
 *     returns null and the report says so.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

/** One request the proxy saw, in order. */
export interface EnvelopeCapturedRequest {
	index: number;
	method: string;
	path: string;
	/** Parsed body when it was JSON; the raw text is always kept alongside. */
	body: Record<string, unknown> | null;
	raw: string;
	/** `usage` block echoed by the upstream response, when the response carried one. */
	responseUsage: Record<string, number> | null;
	/**
	 * llama.cpp's `timings` block (`prompt_n`, `cache_n`, `prompt_ms`, ...) from
	 * the final SSE frame or the nonstream body. LM Studio omits it. This is the
	 * one direct observation of how much of a request's prefix the backend
	 * reused, so the proxy keeps it next to the request it answered.
	 */
	responseTimings: Record<string, number> | null;
	at: string;
}

export interface RecordingProxy {
	/** Base URL an arm should be pointed at, e.g. `http://127.0.0.1:41234`. */
	url: string;
	requests: EnvelopeCapturedRequest[];
	close: () => Promise<void>;
}

/**
 * A transparent recording proxy in front of one OpenAI-compatible endpoint.
 *
 * It rewrites nothing. Bodies are buffered because the point is to keep them,
 * and response bytes are piped straight through so a streaming run behaves
 * exactly as it would without the proxy. Usage is scraped from the response
 * opportunistically: a streaming run may not emit one, which is precisely why
 * the authoritative number comes from the replay probe instead.
 */
export async function startRecordingProxy(upstream: string): Promise<RecordingProxy> {
	const target = new URL(upstream);
	const requests: EnvelopeCapturedRequest[] = [];
	let index = 0;

	const server: Server = createServer((clientReq, clientRes) => {
		const chunks: Buffer[] = [];
		clientReq.on("data", (chunk: Buffer) => chunks.push(chunk));
		clientReq.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const record: EnvelopeCapturedRequest = {
				index: index++,
				method: clientReq.method ?? "GET",
				path: clientReq.url ?? "/",
				body: parseJsonObject(raw),
				raw,
				responseUsage: null,
				responseTimings: null,
				at: new Date().toISOString(),
			};
			requests.push(record);

			const isHttps = target.protocol === "https:";
			const send = isHttps ? httpsRequest : httpRequest;
			const headers = { ...clientReq.headers, host: target.host };
			delete headers["content-length"];
			const upstreamReq = send(
				{
					protocol: target.protocol,
					hostname: target.hostname,
					port: target.port || (isHttps ? 443 : 80),
					method: record.method,
					path: joinPath(target.pathname, record.path),
					headers: { ...headers, "content-length": Buffer.byteLength(raw).toString() },
				},
				(upstreamRes: IncomingMessage) => {
					clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
					const seen: Buffer[] = [];
					upstreamRes.on("data", (chunk: Buffer) => {
						// Bounded from the front: usage and timings ride in the tail of
						// a stream, so a long generation must keep its last chunks, not
						// its first. An unbounded copy is a memory hazard for no gain.
						seen.push(chunk);
						if (seen.length > 512) seen.shift();
						clientRes.write(chunk);
					});
					upstreamRes.on("end", () => {
						const text = Buffer.concat(seen).toString("utf8");
						record.responseUsage = usageFrom(text);
						record.responseTimings = timingsFrom(text);
						clientRes.end();
					});
				},
			);
			upstreamReq.on("error", () => {
				if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "application/json" });
				clientRes.end('{"error":"prompt-ab envelope proxy: upstream unreachable"}');
			});
			if (raw.length > 0) upstreamReq.write(raw);
			upstreamReq.end();
		});
	});

	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("envelope proxy did not bind a TCP port");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.();
				server.close(() => done());
			}),
	};
}

function joinPath(base: string, path: string): string {
	const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
	return `${trimmed}${path}`;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
	if (raw.trim().length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Usage from a JSON body or from the last `data:` frame of an SSE stream. */
function usageFrom(text: string): Record<string, number> | null {
	const direct = parseJsonObject(text);
	if (direct !== null && isRecord(direct.usage)) return numericFields(direct.usage);
	let found: Record<string, number> | null = null;
	for (const line of text.split(/\r?\n/u)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]" || payload.length === 0) continue;
		const frame = parseJsonObject(payload);
		if (frame !== null && isRecord(frame.usage)) found = numericFields(frame.usage);
	}
	return found;
}

/** llama.cpp `timings` from a JSON body or from the last `data:` frame that carries one. */
function timingsFrom(text: string): Record<string, number> | null {
	const direct = parseJsonObject(text);
	if (direct !== null && isRecord(direct.timings)) return numericFields(direct.timings);
	let found: Record<string, number> | null = null;
	for (const line of text.split(/\r?\n/u)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]" || payload.length === 0) continue;
		const frame = parseJsonObject(payload);
		if (frame !== null && isRecord(frame.timings)) found = numericFields(frame.timings);
	}
	return found;
}

function numericFields(value: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
	}
	return out;
}

/** The first chat completion of the session: the first-turn wire payload. */
export function firstTurnRequest(requests: readonly EnvelopeCapturedRequest[]): EnvelopeCapturedRequest | null {
	for (const record of requests) {
		if (record.method !== "POST") continue;
		if (!record.path.includes("chat/completions")) continue;
		if (record.body === null) continue;
		return record;
	}
	return null;
}

/**
 * One addressable piece of the wire payload.
 *
 * `owner` is the question the budget actually asks. Clio-controlled material is
 * what an optimization pass may shrink; variable material is the user's turn,
 * the repository, memory, and retrieved content, and shrinking the harness must
 * never be credited with a reduction that came from a smaller fixture.
 */
export interface EnvelopeComponent {
	id: string;
	kind: "system-section" | "tool" | "tool-description" | "tool-schema" | "message" | "injected-reminder" | "other";
	owner: "clio" | "variable";
	chars: number;
	sha256: string;
	/** Exact marginal `prompt_tokens` cost, filled in by `attributeExact`. */
	tokens: number | null;
}

const REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;

/**
 * The text of one message, whether it arrived as a string or as content parts.
 *
 * Clio sends the first user turn as a parts array, so stringifying the array
 * wholesale counts JSON punctuation as user text and makes the reminder below
 * unfindable. Only text-bearing parts contribute.
 */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("");
}

/**
 * Split a user turn into Clio's injected reminders and the operator's own text.
 *
 * Clio wraps the first turn in a `<system-reminder>` block carrying skill
 * routing instructions. That is harness-controlled instruction material on the
 * wire and belongs in the budget; charging it to the user's prompt would let a
 * harness cost hide inside variable content, and would credit a prompt
 * reduction with a saving it did not make.
 */
export function splitInjectedReminders(text: string): { reminders: string[]; remainder: string } {
	const reminders = [...text.matchAll(REMINDER_PATTERN)].map((match) => match[0]);
	return { reminders, remainder: text.replace(REMINDER_PATTERN, "") };
}

export interface EnvelopeInventory {
	components: EnvelopeComponent[];
	systemChars: number;
	toolCount: number;
	toolNames: string[];
	payloadBytes: number;
}

/**
 * Split the compiled system prompt at its top-level headers.
 *
 * Clio compiles the prompt from named fragments and the manifest records their
 * ids, but the manifest is not on the wire and its `ceil(chars/4)` estimate is
 * not what the model reads. Splitting the wire text on `#`/`##` headers gives
 * boundaries that are both real and probe-able, so every section gets an exact
 * token cost that can be compared against the manifest's estimate for the same
 * name. Text before the first header is `preamble`.
 */
export function splitSystemSections(text: string): Array<{ id: string; text: string }> {
	const lines = text.split("\n");
	const sections: Array<{ id: string; text: string }> = [];
	let currentId = "preamble";
	let buffer: string[] = [];
	const flush = (): void => {
		if (buffer.length === 0 && sections.length > 0) return;
		sections.push({ id: currentId, text: buffer.join("\n") });
		buffer = [];
	};
	for (const line of lines) {
		const header = /^(#{1,2})\s+(.+?)\s*$/u.exec(line);
		if (header !== null) {
			flush();
			currentId = header[2] ?? "unnamed";
		}
		buffer.push(line);
	}
	flush();
	return sections.filter((section) => section.text.trim().length > 0);
}

/**
 * Decompose a captured payload into components.
 *
 * `deep` additionally addresses each tool's description and JSON schema
 * separately. That distinction is the one the optimization needs: a description
 * is prose an optimizer may rewrite, a schema carries constraints it may not
 * remove, and pooling them hides which half the tokens are in.
 */
export function inventoryFrom(body: Record<string, unknown>, deep: boolean): EnvelopeInventory {
	const components: EnvelopeComponent[] = [];
	const messages = Array.isArray(body.messages) ? body.messages : [];
	let systemChars = 0;

	for (const [position, message] of messages.entries()) {
		if (!isRecord(message)) continue;
		const content = messageText(message.content);
		if (message.role === "system") {
			systemChars += content.length;
			for (const section of splitSystemSections(content)) {
				components.push(component(`system[${position}]/${section.id}`, "system-section", "clio", section.text));
			}
			continue;
		}
		const { reminders, remainder } = splitInjectedReminders(content);
		for (const [index, reminder] of reminders.entries()) {
			components.push(component(`message[${position}]#reminder[${index}]`, "injected-reminder", "clio", reminder));
		}
		components.push(component(`message[${position}]:${String(message.role)}`, "message", "variable", remainder));
	}

	const tools = Array.isArray(body.tools) ? body.tools : [];
	const toolNames: string[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) continue;
		const fn = isRecord(tool.function) ? tool.function : tool;
		const name = typeof fn.name === "string" ? fn.name : `tool[${toolNames.length}]`;
		toolNames.push(name);
		components.push(component(`tool:${name}`, "tool", "clio", JSON.stringify(tool)));
		if (!deep) continue;
		const description = typeof fn.description === "string" ? fn.description : "";
		components.push(component(`tool:${name}#description`, "tool-description", "clio", description));
		components.push(component(`tool:${name}#schema`, "tool-schema", "clio", JSON.stringify(fn.parameters ?? {})));
	}

	return {
		components,
		systemChars,
		toolCount: toolNames.length,
		toolNames,
		payloadBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
	};
}

function component(
	id: string,
	kind: EnvelopeComponent["kind"],
	owner: EnvelopeComponent["owner"],
	text: string,
): EnvelopeComponent {
	return {
		id,
		kind,
		owner,
		chars: text.length,
		sha256: createHash("sha256").update(text, "utf8").digest("hex"),
		tokens: null,
	};
}

/**
 * Ask the provider what a payload costs, without generating anything.
 *
 * Returns null rather than a number whenever the answer would be invented: a
 * non-200, a body with no usage, or a usage block with no prompt-token field.
 * A budget gate reading a fabricated zero is worse than a budget gate that
 * reports it could not measure.
 */
export async function probePromptTokens(
	upstream: string,
	body: Record<string, unknown>,
): Promise<{ tokens: number | null; status: number; detail: string }> {
	const payload = { ...body, stream: false, max_tokens: 1, n: 1 };
	delete (payload as Record<string, unknown>).stream_options;
	let response: Response;
	try {
		response = await fetch(`${upstream.replace(/\/$/u, "")}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (err) {
		return { tokens: null, status: 0, detail: err instanceof Error ? err.message : String(err) };
	}
	const text = await response.text();
	if (!response.ok) return { tokens: null, status: response.status, detail: text.slice(0, 400) };
	const parsed = parseJsonObject(text);
	const usage = parsed !== null && isRecord(parsed.usage) ? numericFields(parsed.usage) : null;
	const tokens = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
	if (tokens === undefined || tokens === null) {
		return { tokens: null, status: response.status, detail: "response carried no prompt-token count" };
	}
	return { tokens, status: response.status, detail: "ok" };
}

/** Remove one addressed component from a payload, returning a new body. */
export function withoutComponent(body: Record<string, unknown>, id: string): Record<string, unknown> {
	const next: Record<string, unknown> = JSON.parse(JSON.stringify(body));
	const toolMatch = /^tool:(.+?)(#description|#schema)?$/u.exec(id);
	if (toolMatch !== null) {
		const name = toolMatch[1] as string;
		const part = toolMatch[2];
		const tools = Array.isArray(next.tools) ? next.tools : [];
		if (part === undefined) {
			next.tools = tools.filter((tool) => nameOf(tool) !== name);
			return next;
		}
		next.tools = tools.map((tool) => {
			if (nameOf(tool) !== name || !isRecord(tool)) return tool;
			const fn = isRecord(tool.function) ? { ...tool.function } : null;
			if (fn === null) return tool;
			// Emptied rather than deleted: a tool entry missing `description` or
			// `parameters` is a different shape to the template, and the diff would
			// then measure the shape change as well as the text.
			if (part === "#description") fn.description = "";
			else fn.parameters = { type: "object", properties: {} };
			return { ...tool, function: fn };
		});
		return next;
	}

	const systemMatch = /^system\[(\d+)\]\/(.*)$/u.exec(id);
	if (systemMatch !== null) {
		const position = Number(systemMatch[1]);
		const sectionId = systemMatch[2] as string;
		const messages = Array.isArray(next.messages) ? next.messages : [];
		const message = messages[position];
		if (isRecord(message) && typeof message.content === "string") {
			const kept = splitSystemSections(message.content)
				.filter((section) => section.id !== sectionId)
				.map((section) => section.text);
			message.content = kept.join("\n");
		}
		return next;
	}

	const reminderMatch = /^message\[(\d+)\]#reminder\[(\d+)\]$/u.exec(id);
	if (reminderMatch !== null) {
		const position = Number(reminderMatch[1]);
		const which = Number(reminderMatch[2]);
		editMessageText(next, position, (text) => {
			let seen = -1;
			return text.replace(REMINDER_PATTERN, (block) => {
				seen += 1;
				return seen === which ? "" : block;
			});
		});
		return next;
	}

	const messageMatch = /^message\[(\d+)\]:/u.exec(id);
	if (messageMatch !== null) {
		const position = Number(messageMatch[1]);
		// Only the operator's own text is dropped; the reminders keep their own
		// components, and removing them here would double-count their cost.
		editMessageText(next, position, (text) => text.match(REMINDER_PATTERN)?.join("\n") ?? "");
		return next;
	}

	if (id === "*tools") {
		delete next.tools;
		delete next.tool_choice;
		return next;
	}
	return next;
}

/**
 * Rewrite one message's text while preserving how it was carried.
 *
 * A parts array replaced by a bare string is a different shape to the chat
 * template, and the probe would then be measuring the shape change as well as
 * the text it meant to remove.
 */
function editMessageText(body: Record<string, unknown>, position: number, transform: (text: string) => string): void {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const message = messages[position];
	if (!isRecord(message)) return;
	if (typeof message.content === "string") {
		message.content = transform(message.content);
		return;
	}
	if (!Array.isArray(message.content)) return;
	let applied = false;
	message.content = message.content.map((part) => {
		if (typeof part === "string") {
			applied = true;
			return transform(part);
		}
		if (isRecord(part) && typeof part.text === "string") {
			applied = true;
			return { ...part, text: transform(part.text) };
		}
		return part;
	});
	if (!applied) message.content = transform(messageText(message.content));
}

function nameOf(tool: unknown): string | null {
	if (!isRecord(tool)) return null;
	const fn = isRecord(tool.function) ? tool.function : tool;
	return typeof fn.name === "string" ? fn.name : null;
}

export interface EnvelopeAttribution {
	/** `prompt_tokens` for the payload exactly as sent. The budget number. */
	totalTokens: number | null;
	/** `prompt_tokens` with every tool removed; the difference is the whole tool block. */
	noToolsTokens: number | null;
	/** Tool-block cost the per-tool marginals do not account for: chat-template scaffolding. */
	toolScaffoldTokens: number | null;
	components: EnvelopeComponent[];
	unmeasured: string[];
}

/**
 * Exact per-component token cost by differential probing.
 *
 * Sequential on purpose. The endpoint is a single-slot local server, and firing
 * these concurrently would queue them anyway while making a partial failure much
 * harder to attribute.
 */
export async function attributeExact(
	upstream: string,
	body: Record<string, unknown>,
	inventory: EnvelopeInventory,
	onProgress?: (done: number, total: number, id: string) => void,
): Promise<EnvelopeAttribution> {
	const unmeasured: string[] = [];
	const baseline = await probePromptTokens(upstream, body);
	if (baseline.tokens === null) unmeasured.push(`baseline: ${baseline.detail}`);

	const noTools = await probePromptTokens(upstream, withoutComponent(body, "*tools"));
	if (noTools.tokens === null) unmeasured.push(`*tools: ${noTools.detail}`);

	const components = inventory.components.map((entry) => ({ ...entry }));
	let done = 0;
	for (const entry of components) {
		const probe = await probePromptTokens(upstream, withoutComponent(body, entry.id));
		done += 1;
		onProgress?.(done, components.length, entry.id);
		if (probe.tokens === null || baseline.tokens === null) {
			unmeasured.push(`${entry.id}: ${probe.detail}`);
			continue;
		}
		entry.tokens = baseline.tokens - probe.tokens;
	}

	const perToolSum = components
		.filter((entry) => entry.kind === "tool" && entry.tokens !== null)
		.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
	const toolBlock = baseline.tokens !== null && noTools.tokens !== null ? baseline.tokens - noTools.tokens : null;

	return {
		totalTokens: baseline.tokens,
		noToolsTokens: noTools.tokens,
		toolScaffoldTokens: toolBlock === null ? null : toolBlock - perToolSum,
		components,
		unmeasured,
	};
}

export function writeEnvelopeArtifact(dir: string, name: string, value: unknown): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
