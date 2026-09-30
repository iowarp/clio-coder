import { useEffect, useId, useState } from "react";
import { STRUCTURED_SETTINGS, type StructuredField } from "../../contracts/structured-settings.js";

type Row = { id: string; name: string; values: Record<string, unknown>; members?: Row[] };
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function rowsFrom(path: string, value: string): Row[] {
	try {
		const editor = STRUCTURED_SETTINGS[path];
		if (!editor) return [];
		const data: unknown = JSON.parse(value);
		const row = (value: unknown, name = ""): Row => ({ id: crypto.randomUUID(), name, values: record(value) });
		if (editor.kind === "list") return Array.isArray(data) ? data.map((item) => row(item)) : [];
		return Object.entries(record(data)).map(([name, item]) =>
			editor.kind === "values"
				? row({ value: item }, name)
				: editor.kind === "rosters"
					? {
							...row({}, name),
							members: Array.isArray(record(item).members)
								? (record(item).members as unknown[]).map((member) => row(member))
								: [],
						}
					: row(item, name),
		);
	} catch {
		return [];
	}
}
function asJson(kind: string, rows: Row[]): string {
	const clean = (values: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
	return JSON.stringify(
		kind === "list"
			? rows.map((row) => clean(row.values))
			: Object.fromEntries(
					rows.map((row) => [
						row.name.trim(),
						kind === "values"
							? (row.values.value ?? "")
							: kind === "rosters"
								? { members: row.members?.map((member) => clean(member.values)) ?? [] }
								: clean(row.values),
					]),
				),
	);
}

export function StructuredSettingsEditor({
	path,
	value,
	disabled,
	onChange,
	suggestions,
	onValidityChange,
	describedBy,
}: {
	path: string;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
	suggestions?: readonly string[] | undefined;
	onValidityChange: (valid: boolean) => void;
	describedBy: string;
}) {
	const editor = STRUCTURED_SETTINGS[path];
	const [rows, setRows] = useState(() => rowsFrom(path, value));
	const [fieldText, setFieldText] = useState<Record<string, string>>({});
	const id = useId();
	const names = rows.map((row) => row.name.trim());
	const invalidName = editor?.kind !== "list" && names.some((name, index) => !name || names.indexOf(name) !== index);
	useEffect(() => {
		onValidityChange(!invalidName);
	}, [invalidName, onValidityChange]);
	if (!editor) return null;
	const update = (next: Row[]) => {
		setRows(next);
		onChange(asJson(editor.kind, next));
	};
	const change = (rowId: string, key: string, value: unknown, parent?: string) => {
		const amend = (row: Row) => (row.id === rowId ? { ...row, values: { ...row.values, [key]: value } } : row);
		update(
			rows.map((row) => (parent && row.id === parent ? { ...row, members: (row.members ?? []).map(amend) } : amend(row))),
		);
	};
	const fields = (row: Row, parent?: string) =>
		editor.fields.map((field: StructuredField) => {
			const raw = row.values[field.key];
			const key = `${id}-${row.id}-${field.key}`;
			const text =
				fieldText[key] ?? (Array.isArray(raw) ? raw.join(", ") : raw === undefined || raw === null ? "" : String(raw));
			return (
				<div key={field.key} className="structured-settings__field">
					<label htmlFor={key}>{field.label}</label>
					{field.choices ? (
						<select id={key} value={text} onChange={(event) => change(row.id, field.key, event.target.value, parent)}>
							<option value="">Default</option>
							{!field.choices.includes(text) && text ? <option value={text}>{text}</option> : null}
							{field.choices.map((choice) => (
								<option key={choice} value={choice}>
									{choice}
								</option>
							))}
						</select>
					) : (
						<input
							id={key}
							type={field.kind === "number" ? "number" : "text"}
							min={field.kind === "number" ? 1 : undefined}
							value={text}
							list={field.key === "target" ? `${id}-connections` : undefined}
							placeholder={field.kind === "list" ? "Comma-separated values" : "Default"}
							onChange={(event) => {
								const input = event.target.value;
								// Keep the user's punctuation and partial numbers while serializing the runtime value.
								setFieldText((previous) => ({ ...previous, [key]: input }));
								change(
									row.id,
									field.key,
									field.kind === "number" && input !== ""
										? Number(input)
										: field.kind === "list"
											? input
													.split(",")
													.map((value) => value.trim())
													.filter(Boolean)
											: input,
									parent,
								);
							}}
						/>
					)}
				</div>
			);
		});
	return (
		<fieldset className="structured-settings" disabled={disabled} aria-describedby={describedBy}>
			<legend className="sr-only">Edit {editor.name.toLowerCase()} collection</legend>
			{rows.map((row, index) => (
				<div className="structured-settings__row" key={row.id}>
					<div className="structured-settings__row-heading">
						<strong>
							{editor.name} {index + 1}
						</strong>
						<button
							type="button"
							onClick={() => update(rows.filter((item) => item.id !== row.id))}
							aria-label={`Remove ${editor.name.toLowerCase()} ${row.name || index + 1}`}
						>
							Remove
						</button>
					</div>
					{editor.kind !== "list" ? (
						<label>
							{editor.kind === "values" ? "Agent ID" : `${editor.name} name`}
							<input
								value={row.name}
								required
								onChange={(event) => {
									const name = event.target.value;
									update(rows.map((item) => (item.id === row.id ? { ...item, name } : item)));
								}}
							/>
						</label>
					) : null}
					{editor.kind === "rosters" ? (
						<div className="structured-settings__members">
							{row.members?.map((member, index) => (
								<div key={member.id}>
									<div className="structured-settings__row-heading">
										<strong>Member {index + 1}</strong>
										<button
											type="button"
											onClick={() =>
												update(
													rows.map((item) =>
														item.id === row.id
															? { ...item, members: (item.members ?? []).filter((candidate) => candidate.id !== member.id) }
															: item,
													),
												)
											}
										>
											Remove member
										</button>
									</div>
									<div className="structured-settings__fields">{fields(member, row.id)}</div>
								</div>
							))}
							<button
								type="button"
								disabled={(row.members?.length ?? 0) >= 5}
								onClick={() =>
									update(
										rows.map((item) =>
											item.id === row.id
												? { ...item, members: [...(item.members ?? []), { id: crypto.randomUUID(), name: "", values: {} }] }
												: item,
										),
									)
								}
							>
								Add member
							</button>
						</div>
					) : (
						<div className="structured-settings__fields">{fields(row)}</div>
					)}
				</div>
			))}
			{invalidName ? <p role="status">Each entry needs a unique, non-empty name before saving.</p> : null}
			{!rows.length ? <p>No entries configured.</p> : null}
			<button
				type="button"
				onClick={() => {
					const prefix = `new-${editor.name.toLowerCase().replaceAll(" ", "-")}-`;
					let number = 1;
					while (names.includes(`${prefix}${number}`)) number++;
					update([
						...rows,
						{
							id: crypto.randomUUID(),
							name: `${prefix}${number}`,
							values: {},
							...(editor.kind === "rosters" ? { members: [] } : {}),
						},
					]);
				}}
			>
				Add {editor.name.toLowerCase()}
			</button>
			{suggestions ? (
				<datalist id={`${id}-connections`}>
					{suggestions.map((target) => (
						<option key={target} value={target} />
					))}
				</datalist>
			) : null}
		</fieldset>
	);
}
