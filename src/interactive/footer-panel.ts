import type { ModesContract } from "../domains/modes/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { Text } from "../engine/tui.js";

export interface FooterDeps {
	modes: ModesContract;
	providers: ProvidersContract;
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

export function buildFooter(deps: FooterDeps): FooterPanel {
	const view = new Text("");
	const refresh = (): void => {
		const mode = deps.modes.current();
		const providers = deps.providers.list();
		const active = providers.find((p) => p.available) ?? providers[0];
		const modelName = active ? `${active.id}/${active.displayName}` : "no-provider";
		view.setText(`  mode=${mode}  provider=${modelName}`);
		view.invalidate();
	};
	refresh();
	return { view, refresh };
}
