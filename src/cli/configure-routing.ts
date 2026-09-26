import {
	readSettings,
	SettingsValidationError,
	updateSavedSettingsDocument,
	validateSettings,
} from "../core/config.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import type { ConfigurePrompts } from "./configure-prompts.js";
import { inventoryNote, resolveSupportedWireModels } from "./configure-target.js";

interface RouteSelectionIo {
	rl: Pick<ConfigurePrompts, "choose">;
	out: NodeJS.WritableStream;
	ok: (text: string) => void;
	warn: (text: string) => void;
}

// Effective settings resolve null to the connection default. Patch the saved
// document directly so selecting inheritance stays null even after validation.
function saveRoute(role: "chat" | "fleet" | "memory", target: string | null, model: string | null): void {
	updateSavedSettingsDocument((saved) => {
		const document = saved as {
			chat?: Record<string, unknown>;
			fleet?: Record<string, unknown> & { default?: Record<string, unknown> };
			context?: Record<string, unknown> & { memory?: Record<string, unknown> };
		};
		if (role === "chat") document.chat = { ...document.chat, target, model };
		else if (role === "fleet")
			document.fleet = { ...document.fleet, default: { ...document.fleet?.default, target, model } };
		else document.context = { ...document.context, memory: { ...document.context?.memory, target, model } };
		const validation = validateSettings(document);
		if (validation.issues.length) throw new SettingsValidationError(validation.issues);
		return document;
	});
}

export async function assignTarget(io: RouteSelectionIo, role: "chat" | "fleet" | "memory"): Promise<void> {
	const settings = readSettings();
	const targets = settings.targets.filter((target) => {
		const runtime = getRuntimeRegistry().get(target.runtime);
		return role === "fleet" || (runtime !== null && isOrchestratorEligibleRuntime(runtime));
	});
	if (targets.length === 0 && role !== "memory") {
		io.warn("No eligible connections yet. Open Connections and add one first.");
		return;
	}
	const currentTarget =
		role === "chat"
			? settings.chat.target
			: role === "fleet"
				? settings.fleet.default.target
				: settings.context.memory.target;
	const label = role === "chat" ? "Chat" : role === "fleet" ? "Fleet" : "Proactive memory";
	const targetChoices = targets.map(
		(target) =>
			`${target.id} · ${getRuntimeRegistry().get(target.runtime)?.displayName ?? target.runtime} · ${
				target.defaultModel ?? "no default model"
			}`,
	);
	const rulesOnly = "Rules only · no background model call";
	const currentChoice =
		role === "memory" && !currentTarget
			? rulesOnly
			: (targetChoices[targets.findIndex((target) => target.id === currentTarget)] ?? targetChoices[0] ?? "");
	const choice = await io.rl.choose(
		`${label} connection`,
		role === "memory" ? [rulesOnly, ...targetChoices] : targetChoices,
		currentChoice,
		true,
	);
	if (choice === rulesOnly) {
		saveRoute("memory", null, null);
		io.ok("Proactive memory set to rules only; it will not make a background model call");
		return;
	}
	const target = targets[targetChoices.indexOf(choice)];
	if (choice === null) return;
	if (!target) {
		io.warn("Choose one of the listed connections; nothing changed.");
		return;
	}
	const runtime = getRuntimeRegistry().get(target.runtime);
	if (!runtime) {
		io.warn(`Connection ${target.id} uses unknown runtime ${target.runtime}; repair it in Connections first.`);
		return;
	}
	io.out.write(`  Checking ${target.id} for selectable models…\n`);
	const inventory = await resolveSupportedWireModels(runtime, target, target);
	const note = inventoryNote(runtime, inventory);
	io.out.write(
		`  Model list: ${
			inventory.source === "probe" ? `${inventory.models.length} read live now` : (note ?? "no model list available")
		}\n`,
	);
	const defaultIsSelectable =
		target.defaultModel !== undefined && (inventory.source !== "probe" || inventory.models.includes(target.defaultModel));
	if (inventory.models.length === 0 && !defaultIsSelectable) {
		io.warn(
			`No selectable models could be read for ${target.id}. Open Connections, edit it, and retry after the endpoint is available.`,
		);
		return;
	}
	const useDefault = `Use connection default · ${target.defaultModel ?? "automatic"}`;
	const modelChoices = inventory.models.map((model) => {
		const display = inventory.labels?.[model];
		return display && display !== model ? `${model} — ${display}` : model;
	});
	const choices = [...(defaultIsSelectable ? [useDefault] : []), ...modelChoices];
	const currentModel =
		role === "chat"
			? settings.chat.model
			: role === "fleet"
				? settings.fleet.default.model
				: settings.context.memory.model;
	const initial =
		currentModel === null || currentModel === target.defaultModel
			? defaultIsSelectable
				? useDefault
				: (modelChoices[0] ?? "")
			: (modelChoices[inventory.models.indexOf(currentModel ?? "")] ?? choices[0] ?? "");
	const modelChoice = await io.rl.choose(`${label} model`, choices, initial, choices.length > 8);
	if (modelChoice === null) return;
	const modelIndex = modelChoices.indexOf(modelChoice);
	const model = modelChoice === useDefault ? null : modelIndex >= 0 ? (inventory.models[modelIndex] ?? null) : null;
	if (modelChoice !== useDefault && modelIndex < 0) {
		io.warn("Choose a model from the listed inventory; nothing changed.");
		return;
	}
	saveRoute(role, target.id, model);
	io.ok(`${label} set to ${target.id}/${model ?? target.defaultModel ?? "automatic"}`);
}
