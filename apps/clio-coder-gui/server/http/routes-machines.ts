import { hostname } from "node:os";
import type { Hono } from "hono";
import type { MachineAttachment, MachineAttachmentState } from "../../contracts/machines.js";
import { routes } from "../../contracts/routes.js";
import { clientCredential, dropClientCredential, proxyRequest } from "../local-server.js";
import type { EventHub } from "../services/event-hub.js";
import type { MachinesService } from "../services/machines.js";
import { AppProblem, decodeRequestPath } from "../services/problem.js";
import { requestClient } from "./auth.js";
import { idempotencyKey, register } from "./validate.js";

/** Where a node's GUI answers, once it does: the forward's local port, and the port the node listens on. */
export type MachineRoute =
	| { kind: "ready"; port: number; remotePort: number; token: string }
	| { kind: "pending"; state: Exclude<MachineAttachmentState, "ready"> };

/** What the attach routes and the proxy need from the per-machine supervisor. */
export interface MachineAttachmentsApi {
	list(): Promise<MachineAttachment[]>;
	attach(id: string): Promise<MachineAttachment>;
	/** Null for a node this app has not attached; pending while it is not ready. */
	route(id: string): MachineRoute | null;
	/** Stop and drop the attachment of a node removed from the registry. */
	forget(id: string): void;
}

/** The browser's own credentials and hop-by-hop headers stop here; the proxy sets the remote's own. */
const UNFORWARDED_REQUEST_HEADERS = new Set([
	"authorization",
	"cookie",
	"host",
	"origin",
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
// The node names its own client for this hop; the browser is told the id this app knows it by.
const UNFORWARDED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"set-cookie",
	"x-clio-client",
]);
const MACHINE_ID = /^(?!local$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function machinesRoutes(
	app: Hono,
	hub: EventHub,
	machines?: MachinesService,
	attachments?: MachineAttachmentsApi,
) {
	const service = () => {
		if (!machines) throw new AppProblem("unsupported", "Machine management is not enabled on this host.");
		return machines;
	};
	const attached = () => {
		if (!attachments) throw new AppProblem("unsupported", "Machine attachment is not enabled on this host.");
		return attachments;
	};
	register(app, hub, routes.machines, ({ params }) => service().list(params.id));
	register(app, hub, routes.machineMutation, async ({ params, body }, context) => ({
		operationId: await service().mutate(params.id, body, idempotencyKey(context)),
	}));
	register(app, hub, routes.machineAttachments, async () => ({ attachments: await attached().list() }));
	register(app, hub, routes.machineAttach, ({ params }) => attached().attach(params.id));
	// The node's own API, through its forward. The local auth middleware has already checked this app's
	// origin and the browser client's credential; only machines that are registered and ready are
	// reachable. Each local client is its own client on the node too, so the node attributes and
	// arbitrates its sessions per window exactly as it would for its own windows.
	app.all("/m/:id/api/*", async (context) => {
		const id = context.req.param("id");
		const route = MACHINE_ID.test(id) ? attached().route(id) : null;
		if (!route) throw new AppProblem("not_found", `Machine ${id} is not attached. Open it from Machines first.`);
		if (route.kind === "pending")
			throw new AppProblem(
				"unavailable",
				`Machine ${id} is ${route.state.replace("-", " ")}; its GUI is not reachable yet.`,
			);
		const url = new URL(context.req.url);
		const path = url.pathname.slice(`/m/${id}`.length);
		// Compare the path the node routes, decoded and without a trailing slash, so an encoded name cannot pass.
		const routed = decodeRequestPath(path).replace(/\/+$/u, "");
		// A browser's credentials and tickets belong to this app; the node issues its own.
		if (
			routed === routes.authClients.path ||
			routed === routes.authChallenge.path ||
			routed === routes.authRotate.path ||
			routed === routes.authRevoke.path ||
			routed === routes.eventTicket.path
		)
			throw new AppProblem("not_found", "Credentials and stream tickets are issued by this app, not through it.");
		const client = requestClient(context);
		const refused = () =>
			new AppProblem("unavailable", `Machine ${id}'s GUI refused this app's credentials. Open it again.`, 502);
		let credential: string | null;
		try {
			credential = await clientCredential(
				route.port,
				route.remotePort,
				route.token,
				`${client.label} via ${hostname()}`.slice(0, 80),
				client.clientId,
			);
		} catch {
			credential = null;
		}
		if (credential === null) throw refused();
		// The browser's ticket was spent here. This hop can carry a header, so even a stream travels on
		// this app's bearer at the node.
		url.searchParams.delete("token");
		url.searchParams.delete("ticket");
		const headers: Record<string, string> = {};
		for (const [name, value] of context.req.raw.headers)
			if (!UNFORWARDED_REQUEST_HEADERS.has(name)) headers[name] = value;
		let upstream: Awaited<ReturnType<typeof proxyRequest>>;
		try {
			upstream = await proxyRequest(route.port, route.remotePort, credential, {
				method: context.req.method,
				path: `${path}${url.search}`,
				headers,
				body: context.req.raw.body,
				signal: context.req.raw.signal,
			});
		} catch {
			throw new AppProblem("unavailable", `Machine ${id} did not answer through its SSH forward.`, 502);
		}
		// A remote refusal must not read as this app refusing the browser's token, which the client would drop.
		if (upstream.status === 401 || upstream.status === 421) {
			await upstream.body.cancel().catch(() => {});
			// The next request exchanges the node's launch token again rather than repeating the refusal.
			dropClientCredential(route.port, route.remotePort, route.token, client.clientId);
			throw refused();
		}
		// Headers go in at construction: a response built without a content type takes the adaptor's
		// text/plain default, and one appended afterwards would only join it.
		const answered = new Headers();
		for (const [name, value] of upstream.headers)
			if (!UNFORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) answered.append(name, value);
		return new Response(upstream.body, { status: upstream.status, headers: answered });
	});
}
