#!/usr/bin/env node
// A loopback alias for the one model the capture harness may use. CLIO Coder
// prints the model id it was given, and the gateway's id names a host, so the
// recorded profile points at this proxy and sees only the alias. The proxy
// forwards chat requests for that alias and a model list holding it; every
// other path or model id is refused. The gateway URL and key come from the
// environment and never reach the profile, the screen, or the repository.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const ALIAS = "qwen3.8-27b";
export const UPSTREAM_MODEL = "mini/qwen3.8-27b-iq4r-v4";
export const DEFAULT_PORT = 43130;

const CHAT_PATHS = new Set(["/v1/chat/completions", "/chat/completions"]);
const LIST_PATHS = new Set(["/v1/models", "/models"]);
const INFO_PATHS = new Set(["/v1/model/info", "/model/info"]);
// Capability fields the litellm runtime reads; anything else (deployment ids,
// upstream addresses) stays behind the proxy.
const INFO_KEYS = /^(?:max_(?:input_|output_)?tokens|supports_[a-z_]+|mode)$/;

const toAlias = (text) => text.split(UPSTREAM_MODEL).join(ALIAS);

function refuse(response, status, message) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message } }));
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

export function startAliasProxy({ gateway, apiKey, port = DEFAULT_PORT, log = () => {} }) {
	if (!gateway) throw new Error("The gateway URL is missing; set CLIO_CAPTURE_GATEWAY_URL.");
	if (!apiKey) throw new Error("The gateway key is missing; set LITELLM_API_KEY.");
	const root = gateway.replace(/\/+$/, "").replace(/\/v1$/, "");
	const upstream = (path, init = {}) =>
		fetch(`${root}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${apiKey}` } });
	const server = createServer(async (request, response) => {
		const path = new URL(request.url, "http://127.0.0.1").pathname;
		try {
			if (request.method === "GET" && LIST_PATHS.has(path)) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ object: "list", data: [{ id: ALIAS, object: "model", owned_by: "capture" }] }));
				return;
			}
			if (request.method === "GET" && INFO_PATHS.has(path)) {
				const reply = await upstream("/v1/model/info");
				const rows = reply.ok ? ((await reply.json()).data ?? []) : [];
				const row = rows.find((item) => item?.model_name === UPSTREAM_MODEL);
				const info = Object.fromEntries(Object.entries(row?.model_info ?? {}).filter(([key]) => INFO_KEYS.test(key)));
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: row ? [{ model_name: ALIAS, model_info: info }] : [] }));
				return;
			}
			if (request.method !== "POST" || !CHAT_PATHS.has(path))
				return refuse(response, 404, "Not served by the capture alias.");
			const body = JSON.parse(await readBody(request));
			if (body.model !== ALIAS) return refuse(response, 400, `Only the model ${ALIAS} is served here.`);
			log(`chat ${body.stream ? "stream" : "single"}`);
			const reply = await upstream("/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...body, model: UPSTREAM_MODEL }),
				signal: AbortSignal.timeout(600_000),
			});
			response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });
			if (!reply.body) return response.end();
			// Rewrite whole lines so an id split across two chunks is still replaced.
			const decoder = new TextDecoder();
			let pending = "";
			for await (const chunk of reply.body) {
				pending += decoder.decode(chunk, { stream: true });
				const cut = pending.lastIndexOf("\n") + 1;
				if (cut) {
					response.write(toAlias(pending.slice(0, cut)));
					pending = pending.slice(cut);
				}
			}
			response.end(toAlias(pending + decoder.decode()));
		} catch (error) {
			// Messages can carry the gateway address; name and code cannot.
			const cause = error?.cause;
			log(`error ${error?.name ?? "Error"} ${error?.code ?? cause?.code ?? ""}`.trimEnd());
			if (!response.headersSent) refuse(response, 502, "The capture alias could not reach the gateway.");
			else response.destroy();
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { values } = parseArgs({ options: { port: { type: "string", default: String(DEFAULT_PORT) } } });
	const server = await startAliasProxy({
		gateway: process.env.CLIO_CAPTURE_GATEWAY_URL,
		apiKey: process.env.LITELLM_API_KEY,
		port: Number(values.port),
		log: (line) => process.stderr.write(`alias-proxy: ${line}\n`),
	});
	process.stdout.write(`Serving ${ALIAS} at http://127.0.0.1:${server.address().port}/v1\n`);
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
