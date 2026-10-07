import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ClioSettings, updateSettings } from "../core/config.js";

export const SEMANTIC_HELP = `clio-coder semantic configure --target <id> --model <id> --asset-identity <identity>
                            [--projector-identity <identity>] [--modality text|image|audio|mixed ...] [--qualify] [--background]
clio-coder semantic inbox add <root> --id <id> [--scope project|user]
clio-coder semantic inbox list
clio-coder semantic inbox remove <id>
clio-coder semantic inbox preview <root>
clio-coder semantic refresh [--rebuild]
clio-coder semantic reembed --profile <id> [--from <old-profile-sha256>]
clio-coder semantic search <query> [--limit <1..20>] [filters]
clio-coder semantic status
clio-coder semantic qualify

Opt-in semantic indexing beta. Configure pins an explicit target, model and asset
identity. Prefer sha256:<hash> for the GGUF/checkpoint and multimodal projector.
Inbox add previews bounded workload and registers a root; refresh explicitly
extracts and indexes registered sources. No command enables scans on startup.
Reembed is an explicit offline job; changing profiles never migrates live data.
Search returns attributed candidates; inspect original sources before making claims.

Search filters:
  --kind <kind>       source kind; repeat to include multiple kinds
  --project <id>      authorized project identity
  --run <id>          parent run identity
  --since <ISO date>  earliest source date (inclusive)
  --until <ISO date>  latest source date (inclusive)
  --media-type <MIME> media type

All commands accept --json for compact JSON output and --help, -h for this help.
Search defaults to five results. Inbox scope defaults to project.
Ctrl-C cancels active work; interrupted indexing retains its last complete generation.
`;

export type SemanticCliRequest =
	| {
			command: "configure";
			target: string;
			model: string;
			assetIdentity: string;
			projectorIdentity?: string;
			profile?: string;
			modalities?: Array<"text" | "image" | "audio" | "mixed">;
			qualify: boolean;
			background?: boolean;
	  }
	| { command: "inbox-add"; root: string; id: string; scope: "project" | "user" }
	| { command: "inbox-list" }
	| { command: "inbox-remove"; id: string }
	| { command: "inbox-preview"; root: string }
	| { command: "refresh"; rebuild: boolean }
	| { command: "reembed"; profile: string; from?: string }
	| {
			command: "search";
			query: string;
			limit: number;
			kinds?: string[];
			project?: string;
			run?: string;
			since?: string;
			until?: string;
			mediaType?: string;
	  }
	| { command: "status" }
	| { command: "qualify" };

export interface SemanticCliContext {
	cwd: string;
	settings: ClioSettings;
	updateSettings: typeof updateSettings;
	signal: AbortSignal;
}
export type SemanticCliExecutor = (request: SemanticCliRequest, context: SemanticCliContext) => Promise<unknown>;
interface Dependencies {
	execute?: SemanticCliExecutor;
	loadContext?: () => Promise<Omit<SemanticCliContext, "signal">>;
	writeOut?: (text: string) => void;
	writeError?: (text: string) => void;
}

const FLAGS: Readonly<Record<SemanticCliRequest["command"], readonly string[]>> = {
	configure: ["target", "model", "asset-identity", "projector-identity", "profile", "modality", "qualify", "background"],
	"inbox-add": ["id", "scope"],
	"inbox-list": [],
	"inbox-remove": [],
	"inbox-preview": [],
	refresh: ["rebuild"],
	reembed: ["profile", "from"],
	search: ["limit", "kind", "project", "run", "since", "until", "media-type"],
	status: [],
	qualify: [],
};

export function parseSemanticArgs(
	argv: readonly string[],
	cwd: string,
): { request: SemanticCliRequest; json: boolean } {
	const args = [...argv];
	let command = args.shift() ?? "status";
	if (command === "inbox") command = `inbox-${args.shift() ?? "list"}`;
	if (!Object.hasOwn(FLAGS, command)) throw new Error(`Unknown semantic command: ${command}`);
	const allowed = FLAGS[command as SemanticCliRequest["command"]] ?? [];
	const values = new Map<string, string[]>();
	const positional: string[] = [];
	let json = false;
	let rebuild = false;
	let qualify = false;
	let background = false;
	let literal = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (literal) {
			positional.push(arg);
			continue;
		}
		if (arg === "--") {
			literal = true;
			continue;
		}
		if (arg === "--json") {
			if (json) throw new Error("Duplicate --json");
			json = true;
			continue;
		}
		if (!arg.startsWith("-")) {
			positional.push(arg);
			continue;
		}
		const flag = arg.slice(2);
		if (!arg.startsWith("--") || !allowed.includes(flag)) throw new Error(`Unknown ${command} flag: ${arg}`);
		if (flag === "qualify") {
			if (qualify) throw new Error("Duplicate --qualify");
			qualify = true;
			continue;
		}
		if (flag === "background") {
			if (background) throw new Error("Duplicate --background");
			background = true;
			continue;
		}
		if (flag === "rebuild") {
			if (rebuild) throw new Error("Duplicate --rebuild");
			rebuild = true;
			continue;
		}
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
		if (values.has(flag) && flag !== "kind" && flag !== "modality") throw new Error(`Duplicate ${arg}`);
		values.set(flag, [...(values.get(flag) ?? []), value]);
	}
	const get = (key: string) => values.get(key)?.[0];
	const required = (key: string) => {
		const value = get(key);
		if (!value?.trim()) throw new Error(`--${key} is required`);
		return value;
	};
	const one = () => {
		if (positional.length !== 1 || !positional[0]?.trim())
			throw new Error(`${command} requires exactly one ${command === "search" ? "quoted query" : "argument"}`);
		return positional[0];
	};
	const none = () => {
		if (positional.length > 0) throw new Error(`${command} does not accept positional arguments`);
	};
	if (values.get("modality")?.some((value) => !["text", "image", "audio", "mixed"].includes(value)))
		throw new Error("Unknown --modality; expected text, image, audio or mixed");
	if (values.get("kind")?.some((value) => !["code", "wiki", "memory", "evidence", "inbox", "recording"].includes(value)))
		throw new Error("Unknown --kind; expected code, wiki, memory, evidence, inbox or recording");
	let request: SemanticCliRequest;
	switch (command) {
		case "configure":
			none();
			request = {
				command,
				target: required("target"),
				model: required("model"),
				assetIdentity: required("asset-identity"),
				qualify,
				...(background ? { background } : {}),
				...(values.has("modality")
					? { modalities: values.get("modality") as Array<"text" | "image" | "audio" | "mixed"> }
					: {}),
				...(get("projector-identity") ? { projectorIdentity: get("projector-identity") as string } : {}),
				...(get("profile") ? { profile: get("profile") as string } : {}),
			};
			break;
		case "inbox-add": {
			const scope = get("scope") ?? "project";
			if (scope !== "project" && scope !== "user") throw new Error("--scope must be project or user");
			request = { command, root: resolve(cwd, one()), id: required("id"), scope };
			break;
		}
		case "inbox-remove":
			request = { command, id: one() };
			break;
		case "inbox-preview":
			request = { command, root: resolve(cwd, one()) };
			break;
		case "refresh":
			none();
			request = { command, rebuild };
			break;
		case "reembed":
			none();
			request = { command, profile: required("profile"), ...(get("from") ? { from: get("from") as string } : {}) };
			break;
		case "search": {
			const rawLimit = get("limit") ?? "5";
			if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20)
				throw new Error("--limit must be an integer from 1 to 20");
			const dates: { since?: string; until?: string } = {};
			for (const key of ["since", "until"] as const) {
				const date = get(key);
				if (date !== undefined) {
					if (
						!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date) ||
						!Number.isFinite(Date.parse(date)) ||
						new Date(`${date.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== date.slice(0, 10)
					)
						throw new Error(`--${key} requires a valid ISO date`);
					// The index compares canonical UTC strings, and a date-only --until includes its whole UTC day.
					dates[key] = key === "until" && !date.includes("T") ? `${date}T23:59:59.999Z` : new Date(date).toISOString();
				}
			}
			if (dates.since && dates.until && Date.parse(dates.since) > Date.parse(dates.until))
				throw new Error("--since must not be after --until");
			request = {
				command,
				query: one(),
				limit: Number(rawLimit),
				...dates,
				...(values.has("kind") ? { kinds: values.get("kind") as string[] } : {}),
				...(get("project") ? { project: get("project") as string } : {}),
				...(get("run") ? { run: get("run") as string } : {}),
				...(get("media-type") ? { mediaType: get("media-type") as string } : {}),
			};
			break;
		}
		default:
			none();
			request = { command: command as "status" | "inbox-list" | "qualify" };
	}
	return { request, json };
}

async function defaultContext(): Promise<Omit<SemanticCliContext, "signal">> {
	const [{ readStrictLayeredSettings }, { updateSettings }] = await Promise.all([
		import("../core/settings-layers.js"),
		import("../core/config.js"),
	]);
	const cwd = process.cwd();
	return { cwd, settings: readStrictLayeredSettings(cwd).settings, updateSettings };
}

type Modality = "text" | "image" | "audio" | "mixed";
type SourceKind = "code" | "wiki" | "memory" | "evidence" | "inbox" | "recording";
interface SemanticConfiguration {
	enabled: boolean;
	target: string | null;
	model: string | null;
	assetIdentity: string | null;
	projectorIdentity: string | null;
	canaryFingerprint: string | null;
	modalities: Modality[];
	background: boolean;
	inboxes: Array<{ id: string; root: string; scope: "project" | "global"; project: string | null }>;
}
type AppOptions = { projectRoot: string; settings: ClioSettings };
export interface SemanticCliBridge {
	openSemanticApp(options: AppOptions): Promise<{ profile: { id: string }; profileIdentity: string }>;
	previewSemanticInbox(options: AppOptions, id: string): Promise<unknown>;
	refreshSemantic(options: AppOptions, signal?: AbortSignal): Promise<unknown>;
	reembedSemantic(options: AppOptions, signal?: AbortSignal): Promise<unknown>;
	reembedSemanticFrom?(options: AppOptions, oldProfileIdentity: string, signal?: AbortSignal): Promise<unknown>;
	searchSemantic(
		options: AppOptions,
		query: string,
		filters: {
			limit: number;
			kinds?: readonly SourceKind[];
			runId?: string;
			after?: string;
			before?: string;
			mediaType?: string;
		},
		signal?: AbortSignal,
	): Promise<unknown>;
	statusSemantic(options: AppOptions): Promise<unknown>;
	qualifySemantic(options: AppOptions): Promise<{ canaryFingerprint: string | null }>;
}

function semanticConfiguration(settings: ClioSettings): SemanticConfiguration {
	return (settings.context as ClioSettings["context"] & { semantic: SemanticConfiguration }).semantic;
}
function setSemanticConfiguration(settings: ClioSettings, semantic: SemanticConfiguration): void {
	(settings.context as ClioSettings["context"] & { semantic: SemanticConfiguration }).semantic = semantic;
}

export async function executeSemanticRequest(
	request: SemanticCliRequest,
	context: SemanticCliContext,
	bridge: SemanticCliBridge,
): Promise<unknown> {
	const projectRoot = realpathSync(context.cwd);
	const options = { projectRoot, settings: context.settings };
	const config = semanticConfiguration(context.settings);
	context.signal.throwIfAborted();
	if (request.command === "configure") {
		const target = context.settings.targets.find((entry) => entry.id === request.target);
		if (!target || !["llamacpp-embed", "litellm"].includes(target.runtime))
			throw new Error("--target must name a configured llama.cpp embedding or LiteLLM target");
		if (request.profile && request.profile !== "embeddinggemma-2-q8-768")
			throw new Error("Only profile embeddinggemma-2-q8-768 is supported by this bridge");
		const modalities = [...new Set<Modality>(request.modalities ?? ["text"])];
		if (!modalities.includes("text") || modalities.some((value) => !["text", "image", "audio", "mixed"].includes(value)))
			throw new Error("--modality requires text and only qualified text/image/audio/mixed values");
		const next: SemanticConfiguration = {
			enabled: true,
			target: request.target,
			model: request.model,
			assetIdentity: request.assetIdentity,
			projectorIdentity: request.projectorIdentity ?? null,
			// The canary is part of the profile identity: an unchanged recipe keeps its namespace and
			// qualification, while --qualify measures afresh.
			canaryFingerprint:
				!request.qualify &&
				config.target === request.target &&
				config.model === request.model &&
				config.assetIdentity === request.assetIdentity &&
				config.projectorIdentity === (request.projectorIdentity ?? null)
					? config.canaryFingerprint
					: null,
			modalities,
			background: request.background === true,
			inboxes: config?.inboxes ?? [],
		};
		const proposed = structuredClone(context.settings);
		setSemanticConfiguration(proposed, next);
		if (request.qualify) {
			const qualified = await bridge.qualifySemantic({ projectRoot, settings: proposed });
			context.signal.throwIfAborted();
			next.canaryFingerprint = qualified.canaryFingerprint;
		}
		const saved = context.updateSettings((draft) => {
			setSemanticConfiguration(draft, { ...next, inboxes: semanticConfiguration(draft)?.inboxes ?? next.inboxes });
		});
		return { configuration: semanticConfiguration(saved), qualified: request.qualify };
	}
	if (request.command === "status" && !config?.enabled)
		return { enabled: false, configured: false, inboxes: config?.inboxes ?? [] };
	if (!config?.enabled) throw new Error("Semantic indexing is disabled. Run clio-coder semantic configure first.");
	if (request.command === "inbox-list")
		return { inboxes: config.inboxes.filter((inbox) => inbox.scope === "global" || inbox.project === projectRoot) };
	if (request.command === "inbox-remove") {
		if (
			!config.inboxes.some(
				(inbox) => inbox.id === request.id && (inbox.scope === "global" || inbox.project === projectRoot),
			)
		)
			throw new Error("Inbox is not registered for this project");
		context.updateSettings((draft) => {
			const current = semanticConfiguration(draft);
			const kept = current.inboxes.filter(
				(inbox) => !(inbox.id === request.id && (inbox.scope === "global" || inbox.project === projectRoot)),
			);
			// The check above reads the layered view, but only the user file is editable here.
			if (kept.length === current.inboxes.length)
				throw new Error(
					`Inbox ${request.id} is not in the user settings file; remove it from the project settings layer that defines it`,
				);
			current.inboxes = kept;
		});
		return { removed: request.id, refreshRequired: true };
	}
	if (request.command === "inbox-preview" || request.command === "inbox-add") {
		const root = realpathSync(request.root);
		if (!statSync(root).isDirectory()) throw new Error("Inbox root must be a directory");
		const id = request.command === "inbox-add" ? request.id : "clio-cli-preview";
		if (request.command === "inbox-add" && config.inboxes.some((inbox) => inbox.id === id))
			throw new Error("Inbox id is already registered; remove it explicitly before replacing it");
		const registration: SemanticConfiguration["inboxes"][number] = {
			id,
			root,
			scope: request.command === "inbox-add" && request.scope === "user" ? "global" : "project",
			project: request.command === "inbox-add" && request.scope === "user" ? null : projectRoot,
		};
		const proposed = structuredClone(context.settings);
		setSemanticConfiguration(proposed, { ...config, inboxes: [registration] });
		const preview = await bridge.previewSemanticInbox({ projectRoot, settings: proposed }, id);
		context.signal.throwIfAborted();
		if (request.command === "inbox-preview") return { preview };
		context.updateSettings((draft) => {
			const current = semanticConfiguration(draft);
			if (current.inboxes.some((inbox) => inbox.id === id)) throw new Error("Inbox id was registered concurrently");
			current.inboxes.push(registration);
		});
		return { registration, preview, indexed: false };
	}
	if (request.command === "qualify") {
		const pinnedRecipe = JSON.stringify([config.target, config.model, config.assetIdentity, config.projectorIdentity]);
		const qualified = await bridge.qualifySemantic(options);
		context.signal.throwIfAborted();
		const saved = context.updateSettings((draft) => {
			const current = semanticConfiguration(draft);
			if (
				JSON.stringify([current.target, current.model, current.assetIdentity, current.projectorIdentity]) !== pinnedRecipe
			)
				throw new Error("Semantic configuration changed during qualification; qualify the new recipe explicitly");
			current.canaryFingerprint = qualified.canaryFingerprint;
		});
		return { qualified: true, canaryFingerprint: semanticConfiguration(saved).canaryFingerprint };
	}
	if (request.command === "refresh") {
		const refreshed = await bridge.refreshSemantic(options, context.signal);
		return request.rebuild && !semanticOperationIncomplete(refreshed)
			? { refresh: refreshed, reembed: await bridge.reembedSemantic(options, context.signal) }
			: refreshed;
	}
	if (request.command === "reembed") {
		const app = await bridge.openSemanticApp(options);
		if (request.profile !== app.profile.id && request.profile !== app.profileIdentity)
			throw new Error(
				"--profile must match the explicitly configured profile id or exact identity; configure a new recipe before offline reembedding",
			);
		if (request.from) {
			if (!/^[a-f0-9]{64}$/.test(request.from)) throw new Error("--from requires the old SHA-256 profile identity");
			if (!bridge.reembedSemanticFrom) throw new Error("Offline profile transfer is unavailable in this build");
			return bridge.reembedSemanticFrom(options, request.from, context.signal);
		}
		return bridge.reembedSemantic(options, context.signal);
	}
	if (request.command === "search") {
		if (request.project && request.project !== projectRoot)
			throw new Error("--project must match the current canonical project identity");
		const kinds = request.kinds as SourceKind[] | undefined;
		if (kinds?.some((kind) => !["code", "wiki", "memory", "evidence", "inbox", "recording"].includes(kind)))
			throw new Error("Unknown --kind; expected code, wiki, memory, evidence, inbox or recording");
		return bridge.searchSemantic(
			options,
			request.query,
			{
				limit: request.limit,
				...(kinds ? { kinds } : {}),
				...(request.run ? { runId: request.run } : {}),
				...(request.since ? { after: request.since } : {}),
				...(request.until ? { before: request.until } : {}),
				...(request.mediaType ? { mediaType: request.mediaType } : {}),
			},
			context.signal,
		);
	}
	return bridge.statusSemantic(options);
}

async function defaultExecutor(): Promise<SemanticCliExecutor> {
	// The composition bridge is loaded only for an explicit operation, keeping startup and help scan-free.
	const bridge = await import("../domains/semantic-app/index.js");
	return (request, context) => executeSemanticRequest(request, context, bridge);
}

function semanticOperationIncomplete(result: unknown): boolean {
	if (result === null || typeof result !== "object") return false;
	const value = result as Record<string, unknown>;
	return (
		value.complete === false || ["result", "refresh", "reembed"].some((key) => semanticOperationIncomplete(value[key]))
	);
}

export async function runSemanticCommand(argv: readonly string[], dependencies: Dependencies = {}): Promise<number> {
	const out = dependencies.writeOut ?? ((text: string) => process.stdout.write(text));
	const errorOut = dependencies.writeError ?? ((text: string) => process.stderr.write(text));
	if (argv.includes("--help") || argv.includes("-h")) {
		out(SEMANTIC_HELP);
		return 0;
	}
	let parsed: ReturnType<typeof parseSemanticArgs>;
	try {
		parsed = parseSemanticArgs(argv, process.cwd());
	} catch (error) {
		errorOut(`error: ${error instanceof Error ? error.message : String(error)}\n${SEMANTIC_HELP}`);
		return 2;
	}
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const context = await (dependencies.loadContext ?? defaultContext)();
		const execute = dependencies.execute ?? (await defaultExecutor());
		controller.signal.throwIfAborted();
		const result = await execute(parsed.request, { ...context, signal: controller.signal });
		controller.signal.throwIfAborted();
		out(`${JSON.stringify(result ?? null, null, parsed.json ? undefined : 2)}\n`);
		if (semanticOperationIncomplete(result)) {
			errorOut(
				"error: Semantic indexing incomplete; inspect failed, pending and unsupported source states in the result.\n",
			);
			return 1;
		}
		return 0;
	} catch (error) {
		errorOut(
			`error: ${controller.signal.aborted ? "Semantic operation cancelled" : error instanceof Error ? error.message : String(error)}\n`,
		);
		return controller.signal.aborted ? 130 : 1;
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
