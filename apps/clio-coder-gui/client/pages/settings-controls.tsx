import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { SettingControl, SettingsControls, SettingWritten } from "../../contracts/settings-controls.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import {
	emptyMeaning,
	groupControls,
	matchesControl,
	selectOptions,
	sentence,
	sourceLabel,
	TIMING_LABEL,
	TIMING_SENTENCE,
	writtenSentences,
} from "./settings-control-model.js";
import "./settings-controls.css";

function ControlRow({
	control,
	save,
}: {
	control: SettingControl;
	save: (write: { path: string; value: string; confirmed?: boolean }) => Promise<SettingWritten>;
}) {
	const fieldId = useId(),
		helpId = useId();
	const [draft, setDraft] = useState<string | null>(null),
		[confirmed, setConfirmed] = useState(false),
		[saved, setSaved] = useState<string[] | null>(null);
	const write = useMutation({
		mutationFn: save,
		onSuccess: (result) => {
			setSaved(writtenSentences(result.changed, result.controls.controls, control.path));
			setDraft(null);
			setConfirmed(false);
		},
	});
	const value = draft ?? control.value;
	const dirty = draft !== null && draft !== control.value;
	const options = selectOptions(control);
	const edit = (next: string) => {
		setDraft(next);
		setSaved(null);
		write.reset();
	};
	const writable = control.access === "writable";
	return (
		<div className="setting-control" data-access={control.access}>
			<div className="setting-control__about">
				<label htmlFor={writable ? fieldId : undefined}>{control.label}</label>
				<p id={helpId}>{control.description}</p>
				{control.help && <p className="setting-control__help">{control.help}</p>}
				{control.note && <p className="setting-control__note">{control.note}</p>}
				<small>
					<code>{control.path}</code> · {sourceLabel(control.source)} · {TIMING_LABEL[control.timing]}
				</small>
			</div>
			<div className="setting-control__edit">
				{!writable ? (
					<>
						<output>{control.value || emptyMeaning(control)}</output>
						<p className="setting-control__reason">{control.reason}</p>
					</>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (dirty) write.mutate({ path: control.path, value, ...(control.confirm ? { confirmed } : {}) });
						}}
					>
						{options ? (
							<select id={fieldId} aria-describedby={helpId} value={value} onChange={(event) => edit(event.target.value)}>
								{options.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						) : (
							<input
								id={fieldId}
								aria-describedby={helpId}
								type={control.kind === "number" ? "number" : "text"}
								step={control.kind === "number" ? "any" : undefined}
								value={value}
								placeholder={emptyMeaning(control)}
								list={control.suggestions ? `${fieldId}-suggestions` : undefined}
								onChange={(event) => edit(event.target.value)}
							/>
						)}
						{control.suggestions && !options && (
							<datalist id={`${fieldId}-suggestions`}>
								{control.suggestions.map((suggestion) => (
									<option key={suggestion} value={suggestion} />
								))}
							</datalist>
						)}
						{control.valueHelp[value] && <p className="setting-control__help">{sentence(control.valueHelp[value])}</p>}
						{control.kind === "list" && <small>Separate values with commas.</small>}
						{dirty && control.confirm && (
							<label className="setting-control__confirm">
								<input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
								<span>{control.confirm} I understand.</span>
							</label>
						)}
						{dirty && (
							<div className="setting-control__actions">
								<button type="submit" className="primary" disabled={write.isPending || (!!control.confirm && !confirmed)}>
									{write.isPending ? "Saving…" : "Save"}
								</button>
								<button type="button" onClick={() => edit(control.value)}>
									Revert
								</button>
							</div>
						)}
						{write.error && (
							<p className="setting-control__error" role="alert">
								{write.error.message}
								{write.error instanceof ApiProblem && write.error.problem.code === "conflict"
									? " A project file sets this value."
									: ""}
							</p>
						)}
						{saved && (
							<p className="setting-control__saved" role="status">
								{saved.join(" ")} {TIMING_SENTENCE[control.timing]}
							</p>
						)}
					</form>
				)}
			</div>
		</div>
	);
}

export function SettingsControlsView({ client, workspaceId }: { client: Client; workspaceId: string }) {
	const queries = useQueryClient();
	const [section, setSection] = useState<string | null>(null),
		[filter, setFilter] = useState("");
	const key = ["settings-controls", workspaceId];
	const report = useQuery({
		queryKey: key,
		queryFn: () => client.call(routes.settingsControls, { ...emptyInput, params: { id: workspaceId } }),
	});
	if (report.isPending) return <p>Reading settings…</p>;
	if (report.error) return <p role="alert">{report.error.message}</p>;
	const save = async (body: { path: string; value: string; confirmed?: boolean }) => {
		const result = await client.call(routes.writeSetting, { params: { id: workspaceId }, query: {}, body });
		queries.setQueryData<SettingsControls>(key, result.controls);
		for (const stale of ["workspace-settings", "config-graph", "targets", "routing"])
			void queries.invalidateQueries({ queryKey: [stale] });
		return result;
	};
	const { sections, controls, userFile } = report.data;
	const active = filter.trim() ? null : (section ?? sections[0]?.id ?? null);
	const visible = controls.filter((control) => (active ? control.section === active : matchesControl(control, filter)));
	const current = sections.find((candidate) => candidate.id === active);
	return (
		<>
			<p>
				Changes are checked against the whole configuration and saved to your user settings
				{userFile && (
					<>
						{" "}
						at <code className="inline-path">{userFile}</code>
					</>
				)}
				. Project files are never written from here.
			</p>
			<label className="settings-filter">
				Find a setting
				<input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
			</label>
			<nav className="settings-tabs" aria-label="Settings sections">
				{sections.map((candidate) => (
					<button
						type="button"
						key={candidate.id}
						aria-pressed={active === candidate.id}
						onClick={() => {
							setSection(candidate.id);
							setFilter("");
						}}
					>
						{candidate.label} · {controls.filter((control) => control.section === candidate.id).length}
					</button>
				))}
			</nav>
			<h2>{current ? current.label : `Matches · ${visible.length}`}</h2>
			{current && <p>{current.description}</p>}
			{!visible.length && <p>No settings match.</p>}
			{groupControls(visible).map(({ group, controls: rows }) => (
				<section key={group} className="setting-group" aria-label={group}>
					<h3>{group}</h3>
					{rows.map((control) => (
						<ControlRow key={control.path} control={control} save={save} />
					))}
				</section>
			))}
		</>
	);
}
