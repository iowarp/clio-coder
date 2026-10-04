import { isBuiltin } from "node:module";
import type { Codewiki, CodewikiFile, CodewikiSymbol } from "../codewiki/schema.js";

export interface MapArea {
	id: string;
	path: string;
	responsibility: string;
	files: CodewikiFile[];
}
export interface MapRelationship {
	from: string;
	to: string;
	imports: Array<{ path: string; target: string }>;
}
export interface RepoMap {
	title: string;
	areas: MapArea[];
	symbols: CodewikiSymbol[];
	relationships: MapRelationship[];
	dependencies: Array<{ name: string; paths: string[] }>;
	fileCount: number;
}

function areaPath(file: CodewikiFile): string {
	const parts = file.path.split("/");
	if (parts.length === 1) return "root";
	if (["tests", "scripts", "examples"].includes(parts[0] ?? "")) return parts[0] as string;
	const depth = parts[0] === "src" && parts[1] === "domains" ? 3 : 2;
	return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function responsibility(area: string, files: CodewikiFile[]): string {
	const role = area.split("/").at(-1) ?? area;
	const labels: Record<string, string> = {
		cli: "Accept commands and start workflows",
		entry: "Boot sessions and connect interfaces",
		interactive: "Guide the operator in the terminal",
		engine: "Connect models and run the agent loop",
		tools: "Navigate, change and verify the workspace",
		core: "Share configuration and safety primitives",
		worker: "Execute bounded tasks",
		context: "Index and retrieve repository knowledge",
		dispatch: "Route work and track execution",
		session: "Keep session state and evidence",
		resources: "Discover and manage installed capabilities",
		safety: "Enforce permissions and write boundaries",
		server: "Serve browser requests",
		client: "Present the browser interface",
		tests: "Check behavior and contracts",
		scripts: "Build and maintain the package",
		store: "Store and retrieve application data",
		storage: "Store and retrieve application data",
	};
	return (
		labels[role] ??
		(files.every((f) => f.role === "test")
			? "Check behavior and contracts"
			: files.some((f) => f.role === "entry")
				? "Expose application entry points"
				: `Provide ${role.replace(/[-_]/g, " ")} capabilities`)
	);
}

/** Keep every file available while bounding the overview; imports remain directional evidence. */
export function buildRepoMap(wiki: Codewiki, title: string): RepoMap {
	const files = wiki.files.filter((f) => f.lang !== "config");
	const groups = new Map<string, CodewikiFile[]>();
	for (const file of files) {
		const key = areaPath(file);
		groups.set(key, [...(groups.get(key) ?? []), file]);
	}
	const support = (key: string): number => (["tests", "scripts", "examples"].includes(key) ? 1 : 0);
	const sorted = [...groups].sort(
		(a, b) => support(a[0]) - support(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0]),
	);
	const chosen =
		sorted.length > 8
			? [...sorted.slice(0, 7), ["Other areas", sorted.slice(7).flatMap((g) => g[1])] as [string, CodewikiFile[]]]
			: sorted;
	const areas = chosen.map(([key, members], index) => ({
		id: `area-${index + 1}`,
		path: key,
		responsibility: key === "Other areas" ? "Explore supporting modules" : responsibility(key, members),
		files: members.sort((a, b) => a.path.localeCompare(b.path)),
	}));
	const byFile = new Map(areas.flatMap((a) => a.files.map((f) => [f.id, a.id] as const)));
	const paths = new Map(files.map((f) => [f.id, f.path]));
	const relations = new Map<string, MapRelationship>();

	const deps = new Map<string, Set<string>>();
	for (const edge of wiki.edges) {
		const from = byFile.get(edge.fileId);
		const source = paths.get(edge.fileId);
		if (!from || !source) continue;
		if ("toFileId" in edge) {
			const to = byFile.get(edge.toFileId);
			const target = paths.get(edge.toFileId);
			if (!to || !target || from === to) continue;
			const key = `${from}:${to}`;
			const relation = relations.get(key) ?? { from, to, imports: [] };
			relation.imports.push({ path: source, target });
			relations.set(key, relation);
		} else {
			const specifier = edge.externalModule;
			if (isBuiltin(specifier) || specifier.startsWith(".") || specifier.startsWith("/")) continue;
			const name = specifier
				.split("/")
				.slice(0, specifier.startsWith("@") ? 2 : 1)
				.join("/");
			const members = deps.get(name) ?? new Set<string>();
			members.add(source);
			deps.set(name, members);
		}
	}
	return {
		title,
		areas,
		symbols: wiki.symbols.filter((s) => paths.has(s.fileId) && Number.isInteger(s.line) && s.line > 0),
		relationships: [...relations.values()].sort(
			(a, b) => b.imports.length - a.imports.length || `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`),
		),
		dependencies: [...deps]
			.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
			.map(([name, members]) => ({ name, paths: [...members].sort() })),
		fileCount: files.length,
	};
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
	);
}

export interface MapRenderOptions {
	sourceState: "clean" | "dirty" | "unknown";
	repository?: { url: string; revision: string };
}

/** No remote assets, executable repository text, or implied runtime edges. */
export function renderRepoMap(map: RepoMap, options: MapRenderOptions): string {
	const e = escapeHtml;
	const repository =
		options.sourceState === "clean" &&
		options.repository &&
		/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(options.repository.url) &&
		/^[a-f0-9]{40}$/i.test(options.repository.revision)
			? options.repository
			: undefined;
	const location = (file: string, line?: number): string => {
		const text = e(`${file}${line ? `:${line}` : ""}`);
		return repository
			? `<a href="${e(repository.url)}/blob/${repository.revision}/${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}">${text}</a>`
			: `<code>${text}</code>`;
	};
	const areaById = new Map(map.areas.map((a) => [a.id, a]));
	const cards = map.areas
		.map((area, i) => {
			const x = (i % 2) * 490 + 16;
			const y = Math.floor(i / 2) * 136 + 12;
			const words = area.responsibility.split(" ");
			const lines: string[] = [];
			let current = "";
			for (const word of words) {
				if (`${current} ${word}`.length > 36) {
					lines.push(current);
					current = word;
				} else current = current ? `${current} ${word}` : word;
			}
			lines.push(current);
			return `<a href="#${area.id}" aria-label="Explore ${e(area.path)}"><rect x="${x}" y="${y}" width="466" height="120" rx="6"/><text class="num" x="${x + 20}" y="${y + 27}">${String(i + 1).padStart(2, "0")} / ${area.files.length} files</text><text class="label" x="${x + 20}" y="${y + 57}">${lines.map((l, n) => `<tspan x="${x + 20}" dy="${n ? 24 : 0}">${e(l)}</tspan>`).join("")}</text><text class="path" x="${x + 20}" y="${y + 105}">${e(area.path)}</text><text x="${x + 432}" y="${y + 28}" class="num">↗</text></a>`;
		})
		.join("");
	const relationships = (id: string): string =>
		map.relationships
			.filter((r) => r.from === id || r.to === id)
			.map((r) => {
				const from = areaById.get(r.from);
				const to = areaById.get(r.to);
				return `<details class="relation"><summary><a href="#${r.from}">${e(from?.path ?? "")}</a> <span aria-label="imports">→</span> <a href="#${r.to}">${e(to?.path ?? "")}</a> · ${r.imports.length} static references</summary><ul>${r.imports.map((v) => `<li>${location(v.path)} → ${location(v.target)}</li>`).join("")}</ul></details>`;
			})
			.join("") || "<p>No cross-area imports were resolved for this area.</p>";
	const sections = map.areas
		.map(
			(area, i) =>
				`<details class="area" id="${area.id}"><summary><span class="index">${String(i + 1).padStart(2, "0")}</span><span>${e(area.responsibility)}<small>${e(area.path)} · ${area.files.length} files · heading inferred from names and roles</small></span><span class="expand">+</span></summary><div class="area-body"><h3>Relationships observed in imports</h3>${relationships(area.id)}<h3>Files and declared symbols</h3>${area.files
					.map((file) => {
						const symbols = map.symbols.filter((s) => s.fileId === file.id);
						return `<details class="file"><summary>${location(file.path)} <span class="tag">${e(file.role)} · ${symbols.length} symbols</span></summary>${file.summary ? `<p>${e(file.summary)}</p>` : ""}<ul>${symbols.map((s) => `<li><strong>${e(s.name)}</strong> <span class="tag">${e(s.kind)}</span> ${location(file.path, s.line)}</li>`).join("") || "<li>No declarations indexed.</li>"}</ul></details>`;
					})
					.join("")}</div></details>`,
		)
		.join("");
	const strongest = map.relationships
		.slice(0, 4)
		.map(
			(r) =>
				`<li><a href="#${r.from}">${e(areaById.get(r.from)?.path ?? "")}</a> → <a href="#${r.to}">${e(areaById.get(r.to)?.path ?? "")}</a> <span class="tag">${r.imports.length} observed static references</span></li>`,
		)
		.join("");

	const deps =
		map.dependencies
			.map(
				(d) =>
					`<details class="file"><summary>${e(d.name)} <span class="tag">referenced by ${d.paths.length} files</span></summary><ul>${d.paths.map((p) => `<li>${location(p)}</li>`).join("")}</ul></details>`,
			)
			.join("") || "<p>No external imports indexed.</p>";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(map.title)} · Codebase map</title><style>
:root{color-scheme:light;--ink:#192c32;--muted:#52696e;--paper:#f5f3ea;--line:#cbd4cb;--accent:#006b60}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Trebuchet MS",sans-serif;line-height:1.55}main{max-width:1080px;margin:auto;padding:48px 32px}header{border-top:5px solid var(--accent);padding-top:24px}.eyebrow,.index,.tag,.num,.path{font-family:"Courier New",monospace}.eyebrow{letter-spacing:.16em;font-size:12px;color:var(--accent)}h1{font-family:Georgia,serif;font-weight:normal;font-size:clamp(36px,5vw,64px);line-height:1.1;margin:16px 0}h2{font-family:Georgia,serif;font-weight:normal;font-size:30px;margin:36px 0 16px}h3{font-size:16px;margin:24px 0 12px}p{max-width:78ch;color:var(--muted)}.stats{display:flex;flex-wrap:wrap;gap:24px;padding:16px 0;border-block:1px solid var(--line);font-size:14px}.stats strong{color:var(--accent)}.overview{width:100%;height:auto}rect{fill:#fffdf7;stroke:var(--line)}svg a:hover rect,svg a:focus rect{stroke:var(--accent);stroke-width:2}.label{fill:var(--ink);font-family:Georgia,serif;font-size:22px}.num{fill:var(--accent);font-size:12px}.path{fill:var(--muted);font-size:12px}a{color:var(--accent);text-underline-offset:3px}summary{cursor:pointer}.area{border-top:1px solid var(--line);scroll-margin-top:20px}.area>summary{list-style:none;display:flex;align-items:center;gap:20px;padding:20px 8px;font-size:20px}.area>summary::-webkit-details-marker{display:none}.index{font-size:13px;color:var(--accent)}small{display:block;font-size:12px;color:var(--muted);margin-top:4px}.expand{margin-left:auto;color:var(--accent)}.area[open] .expand{transform:rotate(45deg)}.area-body{padding:0 24px 24px 44px}.file,.relation{background:#fffdf7;border:1px solid var(--line);border-radius:4px;margin:8px 0;padding:12px 16px;font-size:14px}.tag{color:var(--muted);font-size:11px;margin-left:10px}code{font-family:"Courier New",monospace;font-size:12px;overflow-wrap:anywhere}li{padding:4px 0;overflow-wrap:anywhere}footer{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--muted)}button{border:1px solid var(--accent);background:transparent;color:var(--accent);padding:8px 16px;border-radius:3px;cursor:pointer}button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}@media(max-width:650px){main{padding:24px 14px}.area-body{padding:0 4px 16px}.area>summary{font-size:17px;gap:10px}.tag{display:block;margin-left:0}.overview{min-width:640px}.canvas{overflow-x:auto}}@media print{button{display:none}details{break-inside:avoid}}
</style></head><body><main><header><div class="eyebrow">CLIO / REPOSITORY ATLAS</div><h1>${e(map.title)}</h1><p>Start with the major responsibilities. Follow an area to its source and import relationships, then expand only the detail you need.</p><div class="stats"><span><strong>${map.fileCount}</strong> source files</span><span><strong>${map.areas.length}</strong> areas</span><span><strong>${map.relationships.length}</strong> area relationships</span><span><strong>${map.dependencies.length}</strong> external import names</span></div></header><h2>The overview</h2><p>Headings suggest responsibilities from directory names and file roles. Import evidence below explains the connections; it does not prove runtime calls.</p><div class="canvas"><svg class="overview" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 996 ${Math.max(1, Math.ceil(map.areas.length / 2)) * 136 + 12}" role="img" aria-labelledby="overview-title"><title id="overview-title">Major codebase areas. Select an area to explore its evidence.</title>${cards}</svg></div><h2>Follow the connections</h2><ul>${strongest || "<li>No cross-area imports resolved.</li>"}</ul><p>Expand an area to see who imports it, what it imports, and where its declarations live.</p><button type="button" id="collapse">Collapse details</button>${sections || "<p>No source files were recognized by the index.</p>"}<h2>External dependencies</h2><p>Names observed in imports, excluding runtime builtins. These may include unresolved aliases; they are not a verified package manifest or deployment inventory.</p>${deps}<footer>Evidence: reconciled working-tree index · source state: ${options.sourceState}. ${repository ? `Remote links pin the verified revision ${repository.revision}.` : "Source locations refer to local files at generation time; no immutable remote revision is claimed."} Language extraction may miss dynamic imports, runtime wiring, and unsupported syntax.</footer></main><script>
function reveal(){var target=document.getElementById(location.hash.slice(1));if(target&&target.tagName==='DETAILS'){target.open=true;target.scrollIntoView({block:'start'});}}window.addEventListener('hashchange',reveal);document.querySelectorAll('svg a').forEach(function(a){a.addEventListener('click',function(){var target=document.getElementById(a.getAttribute('href').slice(1));if(target)target.open=true;});});document.getElementById('collapse').addEventListener('click',function(){document.querySelectorAll('details').forEach(function(d){d.open=false;});});reveal();
</script></body></html>\n`;
}
