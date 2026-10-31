import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const app = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(app, "../..");
const httpModules = new Map([
	// Cost display stays on the server; browser contracts carry only rendered strings (#434).
	[
		"src/domains/telemetry/cost.ts",
		new Set(["aggregateCostAmounts", "renderCostAggregate", "renderUsdLimit", "CostAggregate"]),
	],
	// The server records its loaded build and reads activation so live status can report a pending upgrade.
	// The context ledger's and fleet frames' counts are worded by the canonical renderer on the server (#434).
	["src/core/telemetry/render.ts", new Set(["renderCompactCount", "renderCount", "renderFact"])],
	["src/core/running-build.ts", new Set(["registerRunningBuild", "pendingInstalledVersion"])],
	["src/engine/acp/transport.ts", new Set(["createStdioTransport", "AcpJsonRpcTransport"])],
	["src/engine/acp/errors.ts", new Set(["AcpProcessError", "AcpTimeoutError", "AcpRequestError", "AcpProtocolError"])],
	["src/engine/acp/types.ts", new Set(["*"])],
	["src/core/xdg.ts", new Set(["clioStateDir", "clioDataDir", "clioConfigDir", "resolveClioDirs"])],
	["src/core/package-root.ts", new Set(["resolvePackageRoot"])],
	["src/core/context-operation.ts", new Set(["ACP_CONTEXT_STATUS_METHOD"])],
	["src/core/process-identity.ts", new Set(["processAlive", "processBirthToken"])],
	["src/domains/lifecycle/version.ts", new Set(["getVersionInfo"])],
	// A bundle's sealed token total with its coverage marker, worded once for the TUI and the GUI (#434).
	["src/domains/evidence/index.ts", new Set(["renderEvidenceTokens"])],
]);
// The read-model DTO schemas and types cross into the browser contract through wire-shims (#434). dto.ts keeps a
// typebox-only value-import closure, which the closure test below holds for the whole contract directory.
const wireDtoNames = new Set([
	"CacheReportV1",
	"CallFilter",
	"CallRowV1",
	"CallsReportV1",
	"CostReportV1",
	"ExplanationV1",
	"FactRef",
	"Quantity",
	"ReceiptEvidenceV1",
	"RunRowV1",
	"RunTelemetryV1",
	"RunTimelineEntry",
	"RunTimelineV1",
	"SessionTelemetryV1",
	"TelemetryTopic",
	"TelemetryUpdateV1",
	"TimelineEntry",
	"TimelineV1",
	"WhyStoppedV1",
	"CallFilterSchema",
	"FactRefSchema",
	"parseFactRef",
	"TELEMETRY_DTO_SCHEMAS",
	"TELEMETRY_TOPICS",
]);
const adapters = new Set([
	"src/domains/interop/index.ts",
	"src/domains/lifecycle/doctor.ts",
	"src/domains/resources/library-inventory.ts",
	"src/domains/resources/library-actions.ts",
	"src/domains/extensions/manager.ts",
	"src/domains/evidence/store.ts",
	"src/domains/evidence/provenance.ts",
	"src/domains/evidence/trust-projection.ts",
	"src/domains/evidence/types.ts",
	"src/domains/dispatch/state.ts",
	"src/domains/dispatch/types.ts",
	"src/domains/dispatch/council-topology.ts",
	"src/domains/dispatch/gate-topology.ts",
	"src/core/settings-layers.ts",
	"src/core/settings-controls.ts",
	"src/core/settings-navigation.ts",
	"src/core/config.ts",
	"src/domains/config/classify.ts",
	"src/domains/providers/registry.ts",
	"src/domains/providers/runtimes/builtins.ts",
	"src/domains/providers/support.ts",
	"src/domains/providers/auth/index.ts",
	"src/domains/providers/auth/storage.ts",
	"src/cli/config-inspect.ts",
	"src/core/package-root.ts",
	"src/domains/toolchain/index.ts",
	"src/core/xdg.ts",
	"src/core/workspace-files.ts",
	"src/domains/telemetry/evidence-index.ts",
	"src/domains/session/history.ts",
	// The telemetry read model and its cold loader; the adapter serves their DTOs unchanged (#434).
	"src/domains/telemetry/read-model.ts",
	"src/domains/session/telemetry-source.ts",
	// The repository window `usage report` folds, so a repo reference explains to the CLI's number (#434 §11.4).
	"src/domains/telemetry/usage-window.ts",
	// Every receipt read follows a pruned receipt's tombstone to its evidence copy (#434).
	"src/domains/dispatch/receipt-store.ts",
]);
// Test-only root seams are intentionally enumerated independently of production.
const testModules = new Set([
	"src/domains/extensions/manager.ts",
	"src/engine/session.ts",
	"src/domains/session/entries.ts",
	"tests/harness/receipt.ts",
	"src/domains/dispatch/receipt-integrity.ts",
	"src/domains/evidence/index.ts",
	"src/domains/dispatch/state.ts",
	"src/domains/dispatch/types.ts",
	"src/domains/dispatch/gate-decisions.ts",
	"src/core/settings-layers.ts",
	"src/core/init.ts",
	"src/core/settings-controls.ts",
	"src/core/workspace-trust.ts",
	"src/cli/config-inspect.ts",
	"src/domains/providers/auth/index.ts",
	"src/domains/toolchain/index.ts",
	"tests/harness/openai-compat-fixture.ts",
	"tests/harness/telemetry-view.ts",
	"tests/harness/telemetry-lies.ts",
	"src/domains/telemetry/call-journal.ts",
]);
function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.name === "node_modules" || entry.name === "dist"
			? []
			: entry.isDirectory()
				? files(resolve(directory, entry.name))
				: /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(entry.name)
					? [resolve(directory, entry.name)]
					: [],
	);
}

function violations(file: string, source: string): string[] {
	const name = relative(app, file),
		errors: string[] = [];
	const production = !name.startsWith("tests/") && !name.startsWith("scripts/");
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const check = (specifier: string, names: string[], typeOnly = false) => {
		if (
			production &&
			/^(node:)?(http|https|http2|net|tls|dgram)$/.test(specifier) &&
			!typeOnly &&
			!(name === "server/local-server.ts" && specifier === "node:http" && names.every((name) => name === "request"))
		)
			errors.push("direct socket access outside the pinned downloader and HTTP server dependency");
		if (production && /^(node:)?child_process$/.test(specifier) && name !== "server/process-policy.ts")
			errors.push("process creation outside chokepoint");
		if (
			production &&
			/^(node:)?worker_threads$/.test(specifier) &&
			names.some((symbol) => !["parentPort", "workerData", "threadId", "isMainThread"].includes(symbol)) &&
			!typeOnly &&
			name !== "server/process-policy.ts"
		)
			errors.push("Worker outside chokepoint");
		if (production && /^(?:client|contracts)\//.test(name) && /^(node:)/.test(specifier) && !typeOnly)
			errors.push("Node runtime dependency on browser surface");
		if (!specifier.startsWith(".")) return;
		const target = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
		const localTarget = relative(app, target),
			rootTarget = relative(root, target);
		if (
			production &&
			localTarget === "server/clio/http-shims.ts" &&
			name !== "server/process-policy.ts" &&
			!typeOnly &&
			names.some((symbol) => symbol === "createStdioTransport" || symbol === "*")
		)
			errors.push("ACP process creation outside chokepoint");
		if (production && /^(?:client|contracts)\//.test(name) && localTarget === "server/clio/http-shims.ts" && !typeOnly)
			errors.push("process shim on browser surface");
		if (rootTarget.startsWith("src/") || rootTarget.startsWith("tests/")) {
			if (!existsSync(target)) errors.push(`root target does not exist: ${rootTarget}`);
			if (name === "server/clio/wire-shims.ts") {
				const sharedContextTypes = new Map([
					["src/core/context-operation.ts", new Set(["ContextOperation", "ContextOperationFact", "ContextOperationStatus"])],
					["src/core/telemetry/live-events.ts", new Set(["ContextActivityPayload"])],
				]);
				const contextTypes = sharedContextTypes.get(rootTarget);
				const dtoNames = rootTarget === "src/core/telemetry/dto.ts" ? wireDtoNames : undefined;
				if (
					!(
						(rootTarget === "src/engine/acp/types.ts" && names.every((symbol) => symbol === "*")) ||
						(typeOnly && contextTypes && names.every((symbol) => contextTypes.has(symbol))) ||
						(dtoNames && names.every((symbol) => dtoNames.has(symbol)))
					)
				)
					errors.push(`wire shim allowlist: ${rootTarget} ${names}`);
			} else if (name === "server/clio/http-shims.ts") {
				const allowed = httpModules.get(rootTarget);
				if (!allowed || names.some((symbol) => !allowed.has(symbol)))
					errors.push(`HTTP shim allowlist: ${rootTarget} ${names}`);
				if (rootTarget === "src/engine/acp/types.ts" && !typeOnly) errors.push("wire types must be type-only");
			} else if (name.startsWith("server/clio/adapters/")) {
				if (!adapters.has(rootTarget)) errors.push(`adapter allowlist: ${rootTarget}`);
			} else if (name.startsWith("tests/harness/") || name.startsWith("tests/fixtures/")) {
				if (!testModules.has(rootTarget)) errors.push(`test seam allowlist: ${rootTarget}`);
			} else errors.push(`root import outside clio seam: ${rootTarget}`);
		}
		if (
			localTarget.startsWith("server/clio/adapters/") &&
			!name.startsWith("server/clio/adapters/") &&
			!["server/worker/reads-main.ts", "server/worker/ops-main.ts", "tests/harness/adapter.ts"].includes(name)
		)
			errors.push("blocking adapter outside worker entry");
		if (
			production &&
			localTarget.startsWith("tests/") &&
			!["server/worker/reads-main.ts", "server/worker/ops-main.ts"].includes(name)
		)
			errors.push("test dependency outside fixture-enabled worker entry");
	};
	const walk = (node: ts.Node) => {
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
			check(node.argument.literal.text, ["*"], true);
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
			const names =
				bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
					? bindings.elements.map((entry) => entry.propertyName?.text ?? entry.name.text)
					: ["*"];
			check(
				node.moduleSpecifier.text,
				names,
				ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly,
			);
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))
		) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteral(argument)) check(argument.text, ["*"]);
			else errors.push("nonliteral module import");
		}
		ts.forEachChild(node, walk);
	};
	walk(tree);
	return errors;
}

test("source import targets, shim exports, worker ownership, and process chokepoint", () => {
	const errors = files(app).flatMap((file) =>
		violations(file, readFileSync(file, "utf8")).map((error) => `${relative(app, file)}: ${error}`),
	);
	assert.deepEqual(errors, []);
});

test("boundary checker rejects representative bypasses", () => {
	for (const source of [
		'import { toolStatuses } from "../../../../src/domains/toolchain/index.js";',
		'import { Worker as Thread } from "node:worker_threads";',
		'export * from "../clio/adapters/toolchain.js";',
		"const module = await import(path);",
		'import cp from "child_process";',
		'import { request } from "node:https";',
		'import { createStdioTransport as spawnAcp } from "../clio/http-shims.js";',
	])
		assert.ok(violations(resolve(app, "server/http/escape.ts"), source).length > 0, source);
});

test("the browser contract reaches no Node builtin through its value imports, root modules included", () => {
	const seen = new Set<string>();
	const reached: string[] = [];
	const visit = (file: string) => {
		if (seen.has(file) || !existsSync(file)) return;
		seen.add(file);
		const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		ts.forEachChild(tree, (node) => {
			if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) return;
			if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
			if (ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly) return;
			const specifier = node.moduleSpecifier.text;
			if (/^node:|^(?:async_hooks|child_process|crypto|fs|http|https|net|os|path|tls|worker_threads)$/.test(specifier))
				reached.push(`${relative(root, file)} -> ${specifier}`);
			if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier).replace(/\.js$/, ".ts"));
		});
	};
	for (const file of files(resolve(app, "contracts"))) visit(file);
	assert.deepEqual(reached, []);
});

test("the browser sums no telemetry quantity: no accumulation over tokens, cost, calls or missing-usage counts", () => {
	const sums: string[] = [];
	// The read model's quantity names; plain counters such as a tool tally or an attachment size are not these.
	const telemetry = /\b(?:tokens|totalTokens|tokenCount|usd|costUsd|knownUsd|missingTokenCalls|apiCalls)\b/;
	for (const file of files(resolve(app, "client"))) {
		const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		const walk = (node: ts.Node) => {
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
				telemetry.test(node.left.getText(tree))
			)
				sums.push(`${relative(app, file)}: ${node.getText(tree)}`);
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "reduce" &&
				telemetry.test(node.arguments.map((argument) => argument.getText(tree)).join(" "))
			)
				sums.push(`${relative(app, file)}: ${node.expression.getText(tree)}(…)`);
			ts.forEachChild(node, walk);
		};
		walk(tree);
	}
	assert.deepEqual(sums, []);
});
