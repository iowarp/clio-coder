import type { ClioSettings } from "../core/config.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { Text } from "../engine/tui.js";

export interface FooterDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

function orchestratorTarget(settings: Readonly<ClioSettings>): string | null {
	const providerId = settings.orchestrator?.provider?.trim();
	const modelId = settings.orchestrator?.model?.trim();
	if (!providerId || !modelId) return null;
	const endpoint = settings.orchestrator?.endpoint?.trim();
	return endpoint ? `${providerId}/${endpoint}/${modelId}` : `${providerId}/${modelId}`;
}

function thinkingSuffix(settings: Readonly<ClioSettings>): string {
	const level = settings.orchestrator?.thinkingLevel;
	return level && level !== "off" ? `:${level}` : "";
}

export function buildFooter(deps: FooterDeps): FooterPanel {
	const view = new Text("");
	const refresh = (): void => {
		const mode = deps.modes.current();
		const settings = deps.getSettings?.();
		const target = settings ? orchestratorTarget(settings) : null;
		const suffix = settings ? thinkingSuffix(settings) : "";
		if (target) {
			view.setText(`  mode=${mode}  provider=${target}${suffix}`);
			view.invalidate();
			return;
		}
		const providers = deps.providers.list();
		const active = providers.find((p) => p.available) ?? providers[0];
		const modelName = active ? `${active.id}/${active.displayName}` : "no-provider";
		view.setText(`  mode=${mode}  provider=${modelName}${suffix}`);
		view.invalidate();
	};
	refresh();
	return { view, refresh };
}
