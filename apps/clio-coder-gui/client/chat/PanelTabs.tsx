import { useRef } from "react";
import { Icon } from "../design/icons.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";

export function PanelTabs<T extends string>({
	tabs,
	value,
	onChange,
	label,
	id,
}: {
	tabs: readonly { id: T; label: string; icon?: Parameters<typeof Icon>[0]["name"] }[];
	value: T;
	onChange: (value: T) => void;
	label: string;
	id: string;
}) {
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	return (
		<div className="panel-tabs" role="tablist" aria-label={label}>
			{tabs.map((tab, index) => (
				<button
					key={tab.id}
					id={`${id}-${tab.id}`}
					ref={(node) => {
						if (node) buttons.current.set(tab.id, node);
						else buttons.current.delete(tab.id);
					}}
					type="button"
					role="tab"
					aria-selected={tab.id === value}
					aria-controls={`${id}-panel-${tab.id}`}
					tabIndex={tab.id === value ? 0 : -1}
					onClick={() => onChange(tab.id)}
					onKeyDown={(event) => {
						let next: number;
						if (matchesKeybinding(KEYBINDINGS.tabNext, event)) next = (index + 1) % tabs.length;
						else if (matchesKeybinding(KEYBINDINGS.tabPrevious, event)) next = (index + tabs.length - 1) % tabs.length;
						else if (matchesKeybinding(KEYBINDINGS.tabFirst, event)) next = 0;
						else if (matchesKeybinding(KEYBINDINGS.tabLast, event)) next = tabs.length - 1;
						else return;
						event.preventDefault();
						const target = tabs[next];
						if (target) {
							onChange(target.id);
							buttons.current.get(target.id)?.focus();
						}
					}}
				>
					{tab.icon ? <Icon name={tab.icon} /> : null}
					<span>{tab.label}</span>
				</button>
			))}
		</div>
	);
}
