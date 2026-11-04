---
title: "GUI wire contracts"
summary: "The shared TypeBox contracts between the Clio Coder GUI server and browser client: the route table, the OpenAPI generator and its schema hoist, and the session projection that folds streamed deltas into a snapshot. Read this when adding a route, changing a DTO, or touching session streaming."
sources:
  - "apps/clio-coder-gui/contracts/routes.ts"
  - "apps/clio-coder-gui/contracts/openapi.ts"
  - "apps/clio-coder-gui/contracts/openapi-hoist.ts"
  - "apps/clio-coder-gui/contracts/session-projection.ts"
  - "apps/clio-coder-gui/contracts/fleet.ts"
  - "apps/clio-coder-gui/contracts/evidence.ts"
  - "apps/clio-coder-gui/server/http/validate.ts"
  - "apps/clio-coder-gui/server/app.ts"
  - "apps/clio-coder-gui/client/api/client.ts"
  - "apps/clio-coder-gui/server/acp/supervisor.ts"
symbols:
  - "routes"
  - "defineRoute"
  - "Route"
  - "openapi"
  - "hoistSharedSchemas"
  - "applySessionDelta"
  - "SessionBuffer"
  - "mergeJob"
  - "mergeJobList"
  - "boundedText"
tests:
  - "apps/clio-coder-gui/tests/openapi.test.ts"
  - "apps/clio-coder-gui/tests/turn-projection.test.ts"
  - "apps/clio-coder-gui/tests/chat-turns.test.ts"
invariants:
  - "Every entry in the routes table is registered on the server, and the generated OpenAPI document contains a matching path and method for each entry (tests/openapi.test.ts)."
  - "Non-GET routes require an Idempotency-Key header and an application/json body, and a mismatched X-Clio-Epoch header refuses the command before admission (server/http/validate.ts register)."
  - "Request query and body values are checked against the route's TypeBox schema before the handler runs; a failure throws a validation problem (server/http/validate.ts parse)."
  - "The OpenAPI hoist is deterministic and idempotent: applying it to an already hoisted document returns the same document, and component names are sorted (tests/openapi.test.ts)."
  - "A session delta with a revision at or below the current revision is ignored, and a revision that skips one throws, requiring a fresh snapshot (contracts/session-projection.ts applySessionDelta)."
  - "A SessionBuffer holds out-of-order deltas and applies them only once contiguous; a snapshot discards pending deltas it already covers (contracts/session-projection.ts SessionBuffer)."
  - "Retained timeline entries are bounded by count (2048) and by serialized bytes (2 MiB), dropping the oldest entries while keeping at least one (turn-projection.test.ts)."
validate:
  - "pnpm --filter @iowarp/clio-coder-gui exec node --import tsx --test tests/openapi.test.ts tests/turn-projection.test.ts tests/chat-turns.test.ts"
---

# GUI wire contracts

This area holds the schemas that the GUI server and the browser client share. A reader needs it when adding or changing an HTTP route, when a DTO shape changes, when the generated OpenAPI document must be regenerated, or when session streaming behaves unexpectedly on the client. The files live in `apps/clio-coder-gui/contracts/` and are imported by both sides, so a change here is a change to the wire format.

## What this area does

The area has four responsibilities, each in its own file:

- `apps/clio-coder-gui/contracts/routes.ts` declares the HTTP route table. Each entry is built with `defineRoute` and records the method, path, `params`, `query`, `body`, `response` schemas, the success status, a summary, and an optional `stream` flag. The exported `routes` object is the single list both sides consume.
- `apps/clio-coder-gui/contracts/openapi.ts` turns that table into an OpenAPI 3.1 document. `hoistSharedSchemas` (in `apps/clio-coder-gui/contracts/openapi-hoist.ts`) then rewrites repeated structured schemas into `components.schemas` entries.
- `apps/clio-coder-gui/contracts/session-projection.ts` folds a stream of session deltas into a `SessionSnapshot`. It is used by the server supervisor and the browser client.
- The domain DTO files (`apps/clio-coder-gui/contracts/fleet.ts`, `apps/clio-coder-gui/contracts/evidence.ts`, and others) define the read-model schemas that routes reference. These files use `Type.Object(..., { additionalProperties: false })` as the closed shape convention.

## Route table

`apps/clio-coder-gui/contracts/routes.ts` declares `Route`, `defineRoute`, `Input`, and `Output`. `Input<R>` is `{ params, query, body }` typed from the route's schemas, and `Output<R>` is the static type of its `response`. A route entry looks like the `evidenceList` and `evidenceDetail` entries, which set `query: FleetPageQuery` and `response: EvidencePage` on a `get` template. The shared templates `get` and `post` in that file supply `method`, `params`, `query`, `body`, and `status` defaults that individual entries override. Changing a status or method is a per-entry edit, not a change to the templates.

Server side, `apps/clio-coder-gui/server/app.ts` calls `register(app, hub, routes.<name>, handler)` for each route it serves. `register` is in `apps/clio-coder-gui/server/http/validate.ts`. For every request it:

1. Sets `Date`, `X-Clio-Epoch`, and `X-Clio-Seq` response headers.
2. For non-GET routes, compares any supplied `X-Clio-Epoch` request header with `hub.epoch` and throws a `conflict` problem on mismatch, before the handler runs.
3. Rejects duplicate query parameters, and rejects a non-integer value for a query property declared `type: "integer"`.
4. For non-GET routes, requires a valid `Idempotency-Key` header and an `application/json` content type, then parses the JSON body.
5. Runs `parse` (a `Value.Check` wrapper that throws a validation problem) on params, the converted query, and the body.
6. Calls the handler, and serializes a non-`Response` result with `context.json(result, route.status)`.

Two parts of `apps/clio-coder-gui/server/app.ts` also use the table. The catch-all `app.all("/api/*")` answers an unmatched path that matches a table route's pattern with a method-level response, and an unknown `/api/` path with `not_found`. `apps/clio-coder-gui/server/http/auth.ts` and the client `apps/clio-coder-gui/client/api/client.ts` also import `routes`. The client `call` method is typed as `call<R extends Route>(route, input: Input<R>)`, so a call site is checked against the same schemas the server validates against.

## OpenAPI generation

`openapi()` in `apps/clio-coder-gui/contracts/openapi.ts` iterates `Object.entries(routes)`, converts `:name` path segments to `{name}`, and emits one operation per route with `operationId` set to the route key. Non-GET operations gain `Idempotency-Key` and `X-Clio-Epoch` header parameters. Streaming routes (`route.stream`) use `text/event-stream` and accept a `Last-Event-ID` header. Every operation has a `default` response referencing `Problem` as `application/problem+json`. The named components (`Problem`, `Event`, and the `*V1` telemetry DTOs taken from `TELEMETRY_DTO_SCHEMAS` in `apps/clio-coder-gui/contracts/wire.ts`) are added to `components.schemas`, and the whole document is passed through `hoistSharedSchemas`.

`openapiText()` serializes the document with tab indentation. The `openapi` script in `apps/clio-coder-gui/package.json` runs `apps/clio-coder-gui/scripts/openapi.ts` and then formats `apps/clio-coder-gui/contracts/openapi.json`. The committed `apps/clio-coder-gui/contracts/openapi.json` is compared with `openapiText()` in `apps/clio-coder-gui/tests/openapi.test.ts`, which also validates the document with `@apidevtools/swagger-parser`.

`hoistSharedSchemas` (`apps/clio-coder-gui/contracts/openapi-hoist.ts`) collects every schema slot (component schemas, parameter schemas, request and response bodies, and response headers). It counts the canonical JSON of each nested object. A shape becomes a component only if it appears at least `MIN_REPEATS` (3) times, its canonical form is at least `MIN_LENGTH` (64) characters, and it is structured (contains `anyOf`, `enum`, `items`, or `properties`). Names combine the kind, the first three property names, and an FNV-1a fingerprint. The file's own header comment states that the TypeBox schemas are not changed, because `$id` references would alter how `Value.Check` resolves them at runtime. `apps/clio-coder-gui/tests/openapi.test.ts` asserts that component names are sorted, that a component named `SessionTelemetryV1` exists, that a hoist of the output returns it unchanged, and that every operation's `default` response is a `$ref` to `Problem`.

## Session projection

`applySessionDelta(current, event)` in `apps/clio-coder-gui/contracts/session-projection.ts` is the pure reducer. The first checks return the current snapshot unchanged when the delta belongs to another resource or its revision is not newer. A revision that is more than one ahead throws `"Session revision gap requires a snapshot."`. Otherwise the reducer switches on `event.type` and returns a new snapshot. Cases include `turn.text`, `turn.thought`, `turn.user` (which build or append timeline items), `turn.tool`, the `permission.*` events, `turn.finished`, `job.changed`, `job.listed`, and `session.reset`, which clears turns, timeline, permissions, and fleet and health lists while keeping the rest of the state.

Narrative chunks append to a single timeline item. `narrativeId` keys the item by turn, kind, and provenance, and starts a new item after an intervening tool call or notice from the same provenance, so text written after a tool call does not land above it. Retained timeline size is kept incrementally: a `WeakMap` caches each item's cost, and `measure` is the single UTF-8 meter counted by `encodeMeter`. When the timeline exceeds 2048 items or 2 MiB, the oldest entries are dropped (`apps/clio-coder-gui/tests/turn-projection.test.ts` asserts a 2100-tool-call run leaves 2048 items with `timelineTruncated` true and the first retained id `turn:tool:52`).

`mergeJob` and `mergeJobList` keep ACP job records keyed by `jobId`. An equal or newer `revision` replaces a held job, an older one is ignored, and the set is capped at `ACP_MAX_JOBS`, dropping the oldest finished job first.

`boundedText(value, limit = 65536)` truncates by UTF-8 bytes and appends a `[… stream truncated …]` marker.

`SessionBuffer` wraps the reducer for out-of-order arrival. `event` stores a delta keyed by revision and drains contiguous revisions after the current snapshot; a duplicate revision drains without re-storing. The buffer overflows (clearing pending deltas and setting `hasGap`) past 4096 pending entries or 8 MiB. `snapshot(value)` replaces the held snapshot when the new revision is not older and removes pending deltas it covers.

Callers:

- `apps/clio-coder-gui/server/acp/supervisor.ts` imports `applySessionDelta`, `boundedText`, and `emptySession`. Its publish path at line 345 calls `applySessionDelta(current, event)` for each delta it stores, then publishes the event. `boundedText` bounds ACP text chunks at 16384 bytes and tool titles at 4096 bytes.
- `apps/clio-coder-gui/client/api/sessions.ts` constructs a `SessionBuffer`.
- `apps/clio-coder-gui/client/api/events.ts` and `apps/clio-coder-gui/tests/stream-load.test.ts` also use the buffer.

## Focused tests

- `apps/clio-coder-gui/tests/openapi.test.ts`: checks that `apps/clio-coder-gui/contracts/openapi.json` equals `openapiText()`, that the document validates as 3.1, that every table route appears under its path and method, and that `/api/events` declares the `after` query parameter. It also checks hoisting determinism and the `Problem` references.
- `apps/clio-coder-gui/tests/turn-projection.test.ts`: builds a 2100-entry tool-call run through `applySessionDelta` and asserts the 2048-entry cap and truncation flag. It also checks that narrative chunks are reattributed after a tool call, and that a `budget` telemetry block is cleared by model text or a tool call. Its `SessionBuffer` section connects the buffer to the hub.
- `apps/clio-coder-gui/tests/chat-turns.test.ts`: imports `applySessionDelta` and `emptySession` and checks that a `turn.finished` delta settles the matching turn's status.
- `apps/clio-coder-gui/tests/stream-load.test.ts`: streams 1,400 chunks through `SessionBuffer` and asserts the projection encodes under 2 MiB, which guards the incremental accounting.

These tests were identified by searching for the symbols under `apps/clio-coder-gui/tests`. Their assertions were read; they were not executed as part of writing this page.

## Things to watch when editing

- Changing a route's `path`, `method`, or schemas changes the generated OpenAPI. Regenerate `apps/clio-coder-gui/contracts/openapi.json` with the package's `openapi` script, or `apps/clio-coder-gui/tests/openapi.test.ts` fails on its first assertion.
- Adding a route to `routes` is not enough by itself: `apps/clio-coder-gui/server/app.ts` must also `register` it, or the request falls through to the `/api/*` catch-all.
- `hoistSharedSchemas` only rewrites positions it finds through the paths and components of the document. A schema placed somewhere else is not hoisted.
- `applySessionDelta` throws on a revision gap. Callers that receive a delta from a stream must go through `SessionBuffer` or fetch a snapshot; calling the reducer directly with a skipped revision is an error by design.
- Keep route `query` and `body` schemas closed with `additionalProperties: false` where the existing DTOs do. The `register` helper converts query values using the declared types, so an integer-typed property rejects decimal strings before schema validation.
- The per-item cost cache is keyed by object identity. Code that copies a timeline item and expects cached costs must produce a new object through the reducer, not mutate an item in place.

Related pages: [Apps clio coder gui client](client.md), [Apps clio coder gui server](server.md), [Apps clio coder gui tests](tests.md).
