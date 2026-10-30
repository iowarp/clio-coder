import type { TSchema } from "typebox";
import { Problem } from "./common.js";
import { Event } from "./events.js";
import { APP_VERSION } from "./meta.js";
import { hoistSharedSchemas } from "./openapi-hoist.js";
import { routes } from "./routes.js";
import { TELEMETRY_DTO_SCHEMAS } from "./wire.js";

function parameters(schema: TSchema, location: "path" | "query") {
	const object = schema as TSchema & { properties?: Record<string, TSchema>; required?: string[] };
	const properties = object.properties ?? {};
	const required = object.required ?? [];
	return Object.entries(properties).map(([name, value]) => ({
		name,
		in: location,
		required: location === "path" || required.includes(name),
		schema: value,
	}));
}
// Every named schema in the document: the read-model DTOs a route or notification serves, under their versioned
// names (#434 §11.2). Quota and health stay live-only.
const components = {
	Problem,
	Event,
	SessionTelemetryV1: TELEMETRY_DTO_SCHEMAS.session,
	CallsReportV1: TELEMETRY_DTO_SCHEMAS.calls,
	CostReportV1: TELEMETRY_DTO_SCHEMAS.cost,
	CacheReportV1: TELEMETRY_DTO_SCHEMAS.cache,
	TimelineV1: TELEMETRY_DTO_SCHEMAS.timeline,
	RunRowV1: TELEMETRY_DTO_SCHEMAS.runs.items,
	RunTelemetryV1: TELEMETRY_DTO_SCHEMAS.run,
	RunTimelineV1: TELEMETRY_DTO_SCHEMAS.runTimeline,
	WhyStoppedV1: TELEMETRY_DTO_SCHEMAS.whyStopped,
	ExplanationV1: TELEMETRY_DTO_SCHEMAS.explanation,
	TelemetryUpdateV1: TELEMETRY_DTO_SCHEMAS.update,
} satisfies Record<string, TSchema>;
export function openapi() {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const [id, route] of Object.entries(routes)) {
		const path = route.path.replace(/:([A-Za-z0-9]+)/g, "{$1}");
		const contentType = route.stream ? "text/event-stream" : "application/json";
		paths[path] ??= {};
		paths[path][route.method.toLowerCase()] = {
			operationId: id,
			summary: route.summary,
			security: route.stream ? [{ bearer: [] }, { eventToken: [] }] : [{ bearer: [] }],
			parameters: [
				...parameters(route.params, "path"),
				...parameters(route.query, "query"),
				...(route.method !== "GET"
					? [
							{
								name: "Idempotency-Key",
								in: "header",
								required: true,
								schema: { type: "string", minLength: 1, maxLength: 128 },
							},
							{
								name: "X-Clio-Epoch",
								in: "header",
								required: false,
								schema: { type: "string" },
								description:
									"Expected server epoch. A mismatch refuses the command before admission; refresh server state before retrying.",
							},
						]
					: []),
				...(route.stream ? [{ name: "Last-Event-ID", in: "header", schema: routes.events.query.properties.after }] : []),
			],
			...(route.method !== "GET"
				? { requestBody: { required: true, content: { "application/json": { schema: route.body } } } }
				: {}),
			responses: {
				[route.status]: {
					description: route.status === 202 ? "Accepted" : "Success",
					content: { [contentType]: { schema: route.response } },
					headers: {
						"X-Clio-Epoch": { schema: { type: "string" }, description: "Server epoch" },
						"X-Clio-Seq": { schema: { type: "integer" }, description: "Sequence before assembling the snapshot" },
						...(id === "operation" || id === "session"
							? { "X-Clio-Revision": { schema: { type: "integer" }, description: "Snapshot revision" } }
							: {}),
					},
				},
				default: { description: "Problem", content: { "application/problem+json": { schema: Problem } } },
			},
		};
	}
	// Named components and every repeated shape are written once and referenced; see openapi-hoist.ts.
	return hoistSharedSchemas({
		openapi: "3.1.0",
		jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
		info: { title: "Clio Coder", version: APP_VERSION },
		paths,
		components: {
			securitySchemes: {
				bearer: { type: "http", scheme: "bearer" },
				eventToken: { type: "apiKey", in: "query", name: "token" },
			},
			schemas: components,
		},
	});
}
export function openapiText() {
	return `${JSON.stringify(openapi(), null, "\t")}\n`;
}
