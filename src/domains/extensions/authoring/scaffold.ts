import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { parseExtensionManifest } from "../discovery.js";

const TEMPLATES = ["status", "hook", "panel", "tool", "workspace"] as const;

export function scaffoldExtension(
	id: string,
	options: { template?: string; dir?: string; workspace?: string } = {},
): string {
	const identity = parseExtensionManifest(
		{ id, name: id, version: "0.1.0", description: "An authoring template." },
		"<id>",
	);
	if (!identity.manifest || identity.manifest.id !== id)
		throw new Error(identity.diagnostics.map((entry) => entry.message).join("; ") || "invalid extension id");
	const template = options.template ?? "status";
	if (!TEMPLATES.includes(template as (typeof TEMPLATES)[number]))
		throw new Error(`unknown template '${template}'; choose ${TEMPLATES.join(", ")}`);
	const workspace = options.workspace ?? process.cwd();
	const target = resolve(workspace, options.dir ?? join(".clio-coder", "dev", "extensions", id));
	const existing = lstatSync(target, { throwIfNoEntry: false });
	if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || readdirSync(target).length > 0))
		throw new Error(`refusing non-empty or non-directory target: ${target}`);
	const install = resolvePackageRoot();
	const source = join(install, "src/domains/extensions/authoring/templates", template);
	const files = readdirSync(source, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => ({
			path: join(entry.parentPath, entry.name).slice(source.length + 1),
			text: readFileSync(join(entry.parentPath, entry.name), "utf8").replaceAll("__EXTENSION_ID__", id),
		}));
	files.push({
		path: "package.json",
		text: `${JSON.stringify({ name: id, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
	});
	files.push({
		path: "tsconfig.json",
		text: `${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					paths: {
						"@iowarp/clio-coder/extensions": [join(install, "src/domains/extensions/public-api.ts")],
						"@iowarp/clio-coder/extensions/testing": [join(install, "src/domains/extensions/authoring/test-api.ts")],
					},
				},
				include: ["runtime/**/*.ts"],
				exclude: ["runtime/**/*.test.ts"],
			},
			null,
			2,
		)}\n`,
	});
	mkdirSync(target, { recursive: true });
	for (const file of files) safeResourceWrite(join(target, file.path), file.text);
	return target;
}
