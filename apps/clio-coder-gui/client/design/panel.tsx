import type { ReactNode } from "react";
import type { PanelCopy } from "./panel-model.js";
import "./panel.css";

/**
 * The opening of an inspector panel: an eyebrow naming scope and mutability, the title, and an
 * optional action slot on the same line. Every word comes from panel-model.ts, so this component
 * decides layout and nothing else.
 */
export function PanelHeading({
	panel,
	title,
	level = 2,
	action,
	eyebrow = true,
}: {
	panel: PanelCopy;
	title?: ReactNode;
	level?: 1 | 2 | 3;
	action?: ReactNode;
	/** The conversation's own pages speak without the inspector's scope line. */
	eyebrow?: boolean;
}) {
	const Title = `h${level}` as "h1" | "h2" | "h3";
	return (
		<div className="panel-heading">
			<div>
				{eyebrow ? <p className="eyebrow">{panel.eyebrow}</p> : null}
				<Title>{title ?? panel.title}</Title>
			</div>
			{action ? <div className="panel-heading__action">{action}</div> : null}
		</div>
	);
}

/** The closing sentence of a panel, naming what stays on this machine. */
export function Boundary({ panel }: { panel: PanelCopy }) {
	return <p className="panel-boundary">{panel.boundary}</p>;
}

/** One of the four empty states, or a bounded-view sentence. Always a sentence, never a blank. */
export function PanelEmpty({ children, role }: { children: ReactNode; role?: "status" }) {
	return (
		<p className="panel-empty" role={role}>
			{children}
		</p>
	);
}
