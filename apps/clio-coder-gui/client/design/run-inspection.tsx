import type { ReactNode } from "react";
import { useId } from "react";
import { inspectionTabIndex } from "./run-inspection-model.js";

export function InspectionSummary({ figures }: { figures: readonly { label: string; value: string | number }[] }) {
	return (
		<dl className="inspection-summary">
			{figures.map((figure) => (
				<div key={figure.label}>
					<dt>{figure.label}</dt>
					<dd>{figure.value}</dd>
				</div>
			))}
		</dl>
	);
}

export function InspectionError({
	title,
	error,
	retry,
	busy = false,
}: {
	title: string;
	error: Error;
	retry: () => void;
	busy?: boolean;
}) {
	return (
		<div className="inspection-error" role="alert">
			<div>
				<strong>{title}</strong>
				<p>{error.message}</p>
			</div>
			<button type="button" disabled={busy} onClick={retry}>
				{busy ? "Retrying…" : "Try again"}
			</button>
		</div>
	);
}

export function InspectionTabs<T extends string>({
	tabs,
	value,
	onChange,
	label,
	children,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
	label: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<>
			<div
				className="inspection-tabs"
				role="tablist"
				aria-label={label}
				onKeyDown={(event) => {
					const current = tabs.findIndex((tab) => tab.id === value);
					const index = inspectionTabIndex(event.key, current, tabs.length);
					const next = tabs[index];
					if (!next) return;
					event.preventDefault();
					onChange(next.id);
					document.getElementById(`${id}-${next.id}`)?.focus();
				}}
			>
				{tabs.map((tab) => (
					<button
						type="button"
						role="tab"
						key={tab.id}
						id={`${id}-${tab.id}`}
						aria-selected={tab.id === value}
						aria-controls={`${id}-panel`}
						tabIndex={tab.id === value ? 0 : -1}
						onClick={() => onChange(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: A tab panel is keyboard focusable so its content follows the active tab. */}
			<div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>
				{children}
			</div>
		</>
	);
}
