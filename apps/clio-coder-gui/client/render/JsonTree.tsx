import { type ReactNode, useState } from "react";
import { JSON_TREE_PAGE, type JsonContainer, jsonScalar, jsonSummary } from "./json-tree-model.js";

/**
 * A JSON value as nested native disclosures: the top level opens, everything below starts folded and
 * says how much it holds. Children render only while their node is open, and a long node shows them a
 * page at a time, so a large payload costs what is on screen.
 */
export default function JsonTree({ value }: { value: JsonContainer }) {
	return (
		<div className="json-tree">
			<JsonNode name={null} value={value} depth={0} />
		</div>
	);
}

function JsonNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
	const label = name === null ? null : <span className="json-tree__key">{name}</span>;
	if (typeof value !== "object" || value === null) {
		const scalar = jsonScalar(value);
		return (
			<div className="json-tree__leaf">
				{label}
				{label === null ? null : <span className="json-tree__colon">: </span>}
				<span className={`json-tree__${scalar.kind}`}>{scalar.text}</span>
			</div>
		);
	}
	return <JsonBranch label={label} value={value as JsonContainer} depth={depth} />;
}

function JsonBranch({ label, value, depth }: { label: ReactNode; value: JsonContainer; depth: number }) {
	const [open, setOpen] = useState(depth === 0);
	const [shown, setShown] = useState(JSON_TREE_PAGE);
	const entries: [string, unknown][] = Array.isArray(value)
		? value.slice(0, open ? shown : 0).map((item, index) => [String(index), item])
		: Object.entries(value).slice(0, open ? shown : 0);
	const total = Array.isArray(value) ? value.length : Object.keys(value).length;
	const rest = total - shown;
	return (
		<details className="json-tree__branch" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				{label}
				{label === null ? null : <span className="json-tree__colon">: </span>}
				<span className="json-tree__count">{jsonSummary(value)}</span>
			</summary>
			{open ? (
				<div className="json-tree__children">
					{entries.map(([key, item]) => (
						<JsonNode key={key} name={key} value={item} depth={depth + 1} />
					))}
					{rest > 0 ? (
						<button type="button" className="json-tree__more" onClick={() => setShown((current) => current + JSON_TREE_PAGE)}>
							Show {Math.min(rest, JSON_TREE_PAGE)} more of {rest}
						</button>
					) : null}
				</div>
			) : null}
		</details>
	);
}
