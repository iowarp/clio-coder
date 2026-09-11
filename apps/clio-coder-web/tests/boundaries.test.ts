import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const app = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(app, "../..");
const httpModules = new Map([
	["src/engine/acp/transport.ts", new Set(["createStdioTransport", "AcpJsonRpcTransport"])],
	["src/engine/acp/errors.ts", new Set(["AcpProcessError", "AcpTimeoutError", "AcpRequestError", "AcpProtocolError"])],
	["src/engine/acp/types.ts", new Set(["*"])],
	["src/core/xdg.ts", new Set(["clioStateDir", "clioDataDir", "clioConfigDir", "resolveClioDirs"])],
	["src/core/package-root.ts", new Set(["resolvePackageRoot"])],
	["src/core/process-identity.ts", new Set(["processAlive", "processBirthToken"])],
	["src/domains/lifecycle/version.ts", new Set(["getVersionInfo"])],
]);
const adapters = new Set([
	"src/domains/eval/inventory.ts",
	"src/domains/eval/artifacts/store.ts",
	"src/domains/evidence/store.ts",
	"src/domains/evidence/provenance.ts",
	"src/domains/evidence/trust-projection.ts",
	"src/domains/evidence/types.ts",
	"src/domains/dispatch/state.ts",
	"src/domains/dispatch/types.ts",
	"src/domains/dispatch/council-topology.ts",
	"src/domains/dispatch/gate-topology.ts",
	"src/core/settings-layers.ts",
	"src/cli/config-inspect.ts",
	"src/core/package-root.ts",
	"src/domains/toolchain/index.ts",
	"src/core/xdg.ts",
	"src/domains/observability/trace-store.ts",
	"src/domains/observability/evidence-index.ts",
	"src/domains/session/history.ts",
]);
// Test-only root seams are intentionally enumerated independently of production.
const testModules = new Set([
	"src/domains/eval/artifacts/store.ts",
	"src/domains/eval/schema/artifact.ts",
	"src/domains/eval/store.ts",
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
	"src/core/workspace-trust.ts",
	"src/cli/config-inspect.ts",
	"src/domains/providers/auth/index.ts",
	"src/domains/toolchain/index.ts",
	"src/domains/observability/trace-store.ts",
	"tests/harness/openai-compat-fixture.ts",
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
		if (rootTarget.startsWith("src/") || rootTarget.startsWith("tests/")) {
			if (!existsSync(target)) errors.push(`root target does not exist: ${rootTarget}`);
			if (name === "server/clio/http-shims.ts") {
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
		'import { createStdioTransport as spawnAcp } from "../clio/http-shims.js";',
	])
		assert.ok(violations(resolve(app, "server/http/escape.ts"), source).length > 0, source);
});
