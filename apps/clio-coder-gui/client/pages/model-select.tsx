import { type ReactNode, useState } from "react";
import { type ModelOption, modelOptions, OTHER_MODEL } from "./model-options.js";
import "./model-select.css";

/**
 * A model field that offers the target's catalog as a select. Without a catalog, or after the
 * operator picks "Another model id…", it is a text field for an exact id, with a way back to the
 * list. The label is the caller's, pointed at `id` with `htmlFor`, because the field is one of two
 * elements.
 */
export function ModelSelect({
	id,
	value,
	models,
	defaultModel = null,
	emptyLabel,
	disabled = false,
	describedBy,
	note,
	onChange,
}: {
	id: string;
	value: string;
	/** The target's catalog, or null when there is no target or it has not been read. */
	models: readonly string[] | null;
	defaultModel?: string | null;
	/** Replaces "Target default" as the empty choice's words. */
	emptyLabel?: string;
	disabled?: boolean;
	describedBy?: string;
	/** Where the catalog came from and how fresh it is, in a sentence. */
	note?: ReactNode;
	onChange: (value: string) => void;
}) {
	const [typing, setTyping] = useState(false);
	const catalog = models !== null && models.length > 0;
	const options: readonly ModelOption[] = catalog ? modelOptions(models, value, defaultModel, emptyLabel) : [];
	return (
		<div className="model-select">
			{catalog && !typing ? (
				<select
					id={id}
					value={value}
					disabled={disabled}
					aria-describedby={describedBy}
					onChange={(event) => {
						if (event.target.value === OTHER_MODEL) setTyping(true);
						else onChange(event.target.value);
					}}
				>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			) : (
				<div className="model-select__typed">
					<input
						id={id}
						value={value}
						maxLength={256}
						disabled={disabled}
						spellCheck={false}
						autoComplete="off"
						placeholder={emptyLabel ?? "Target default"}
						aria-describedby={describedBy}
						onChange={(event) => onChange(event.target.value)}
						// biome-ignore lint/a11y/noAutofocus: the operator just asked to type an id; the field is where they type it.
						autoFocus={typing}
					/>
					{catalog ? (
						<button type="button" className="model-select__back" disabled={disabled} onClick={() => setTyping(false)}>
							Choose from the list
						</button>
					) : null}
				</div>
			)}
			{note ? <small className="model-select__note">{note}</small> : null}
		</div>
	);
}
