import { equal, ok } from "node:assert/strict";

const EXPECTED_ASSETS = new Map([
	["clio-coder-logo-64.webp", "35ad057367ed924a3b5be022a624b263521128ff38a34942c96eedc9523f71b4"],
	["clio-coder-logo-128.webp", "ad7c5736458496bc65da8544db780bd11bb4c71ab1e138ece5946445c0ca83ac"],
]);
const NON_PRODUCT_DIRECTORIES = new Set([".artifacts", ".workbench-data", ".desktop", "dist", "node_modules", "tests"]);

function bytesToHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function* appSourceFiles(directory: URL): AsyncGenerator<URL> {
	for await (const entry of Deno.readDir(directory)) {
		if (entry.isDirectory && !NON_PRODUCT_DIRECTORIES.has(entry.name)) {
			yield* appSourceFiles(new URL(`${entry.name}/`, directory));
		} else if (entry.isFile && /\.(?:ts|tsx)$/u.test(entry.name)) {
			yield new URL(entry.name, directory);
		}
	}
}

Deno.test("app-local Clio marks remain byte-identical to the approved owned assets", async () => {
	for (const [name, expectedHash] of EXPECTED_ASSETS) {
		const bytes = await Deno.readFile(new URL(`../public/assets/${name}`, import.meta.url));
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		equal(bytesToHex(digest), expectedHash, `${name} drifted from the approved Clio-owned asset`);
	}
});

Deno.test("document shell provides the keyboard skip link before the React root", async () => {
	const document = await Deno.readTextFile(new URL("../index.html", import.meta.url));
	ok(document.indexOf('class="skip-link"') < document.indexOf('id="root"'));
	ok(document.includes('href="#conversation"'));
});

Deno.test("Workbench source has no root runtime or sibling-app imports", async () => {
	for await (const file of appSourceFiles(new URL("../", import.meta.url))) {
		const source = await Deno.readTextFile(file);
		ok(!/(?:\.\.\/){2,}src\//u.test(source), `${file.pathname} imports the root Clio runtime`);
		ok(!source.includes("../trace-viewer"), `${file.pathname} imports the sibling Trace Viewer app`);
	}
});
