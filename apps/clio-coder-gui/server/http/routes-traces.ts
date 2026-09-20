import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { routes } from "../../contracts/routes.js";
import { TraceLiveBatch } from "../../contracts/traces.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem, problemOf } from "../services/problem.js";
import type { TraceService } from "../services/traces.js";
import { register } from "./validate.js";

export function traceRoutes(app: Hono, hub: EventHub, traces: TraceService) {
	register(app, hub, routes.traceStatus, () => traces.read({ kind: "status" }, routes.traceStatus.response));
	register(app, hub, routes.traceRuns, ({ query }) => traces.read({ kind: "runs", query }, routes.traceRuns.response));
	register(app, hub, routes.traceRun, ({ params }) => traces.read({ kind: "run", ...params }, routes.traceRun.response));
	register(app, hub, routes.tracePhases, ({ params }) =>
		traces.read({ kind: "phases", ...params }, routes.tracePhases.response),
	);
	register(app, hub, routes.traceGates, ({ params }) =>
		traces.read({ kind: "gates", ...params }, routes.traceGates.response),
	);
	register(app, hub, routes.traceEnvelopes, ({ params }) =>
		traces.read({ kind: "envelopes", ...params }, routes.traceEnvelopes.response),
	);
	register(app, hub, routes.traceProcesses, ({ params }) =>
		traces.read({ kind: "processes", ...params }, routes.traceProcesses.response),
	);
	register(app, hub, routes.traceReceipt, ({ params, query }) =>
		traces.read({ kind: "receipt", ...params, full: query.include === "full" }, routes.traceReceipt.response),
	);
	register(app, hub, routes.traceEvents, ({ params, query }) =>
		traces.read(
			{ kind: "events", ...params, after: query.after ?? 0, limit: query.limit ?? 500 },
			routes.traceEvents.response,
		),
	);
	register(app, hub, routes.traceLive, async ({ params, query }, context) => {
		const last = context.req.header("Last-Event-ID");
		if (last !== undefined && (!/^\d+$/.test(last) || !Number.isSafeInteger(Number(last))))
			throw new AppProblem("validation", "Invalid trace event cursor.");
		let after = last === undefined ? (query.after ?? 0) : Number(last);
		await traces.read({ kind: "run", ...params }, routes.traceRun.response);
		return streamSSE(context, async (stream) => {
			await stream.writeSSE({ event: "ready", data: JSON.stringify({ after }) });
			let idle = 0;
			try {
				while (!stream.aborted) {
					const batch = await traces.read({ kind: "live", ...params, after, limit: 500 }, TraceLiveBatch);
					for (const event of batch.events) {
						await stream.writeSSE({ event: "trace.event", id: String(event.rowid), data: JSON.stringify(event) });
						after = event.rowid;
					}
					const terminal = batch.run.status === "success" || batch.run.status === "fail";
					idle = terminal && !batch.events.length ? idle + 1 : 0;
					if (idle >= 2) {
						await stream.writeSSE({ event: "finished", data: JSON.stringify(batch.run) });
						break;
					}
					await stream.sleep(500);
				}
			} catch (error) {
				if (!stream.aborted) await stream.writeSSE({ event: "problem", data: JSON.stringify(problemOf(error)) });
			}
		});
	});
}
