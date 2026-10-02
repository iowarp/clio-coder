import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SettingControl, SettingsControls, SettingWritten } from "../../contracts/settings-controls.js";
import { STRUCTURED_SETTINGS } from "../../contracts/structured-settings.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { useOperation } from "../api/queries.js";
import { MODEL_TARGET_PATHS } from "./model-options.js";
import { ModelSelect } from "./model-select.js";
import { StructuredSettingsEditor } from "./StructuredSettingsEditor.js";
import {
	emptyMeaning,
	groupControls,
	inScope,
	matchesControl,
	OPEN_CHOICES,
	type OpenChoice,
	type SettingsScopeId,
	selectOptions,
	sentence,
	sourceLabel,
	TIMING_PHRASE,
	TIMING_SENTENCE,
	writtenSentences,
} from "./settings-control-model.js";
import { useSettingsDrafts } from "./settings-drafts.js";
import { ConnectionSetup } from "./target-onboarding.js";
import "./settings-controls.css";

/** A model setting's catalog: the paired target's models as Clio Coder last read them, and where from. */
interface ModelCatalog {
	readonly models: readonly string[] | null;
	readonly defaultModel: string | null;
	readonly note: ReactNode;
}

const OTHER = "\u0000other";

/**
 * One of the engine's words, or an exact value. A saved exact value opens as the field, so the page
 * never rewrites it, and the field offers a way back to the words.
 */
function OpenChoiceField({
	id,
	describedBy,
	choice,
	value,
	disabled,
	onChange,
}: {
	id: string;
	describedBy: string;
	choice: OpenChoice;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const [typing, setTyping] = useState(value !== "" && !choice.words.includes(value));
	const [asked, setAsked] = useState(false);
	if (!typing)
		return (
			<select
				id={id}
				aria-describedby={describedBy}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					if (event.target.value !== OTHER) onChange(event.target.value);
					else {
						setTyping(true);
						setAsked(true);
					}
				}}
			>
				{choice.words.includes(value) ? null : <option value={value}>{value || "Not set"}</option>}
				{choice.words.map((word) => (
					<option key={word} value={word}>
						{word}
					</option>
				))}
				<option value={OTHER}>{choice.other.label}</option>
			</select>
		);
	return (
		<div className="model-select__typed">
			<input
				id={id}
				aria-describedby={describedBy}
				value={choice.words.includes(value) ? "" : value}
				disabled={disabled}
				spellCheck={false}
				autoComplete="off"
				{...(choice.other.field === "whole-number"
					? { type: "number", min: 1, step: 1, inputMode: "numeric" as const, placeholder: "4" }
					: { type: "text", placeholder: "/absolute/path/to/worktrees" })}
				onChange={(event) => onChange(event.target.value)}
				// biome-ignore lint/a11y/noAutofocus: the operator just asked to type the value; the field is where they type it.
				autoFocus={asked}
			/>
			<button type="button" className="model-select__back" disabled={disabled} onClick={() => setTyping(false)}>
				Choose from the list
			</button>
		</div>
	);
}

function ControlRow({
	control,
	save,
	workspaceId,
	draft,
	expectedValue,
	onDraft,
	catalog,
	showPath = true,
}: {
	control: SettingControl;
	save: (write: { path: string; value: string; confirmed?: boolean; expectedValue?: string }) => Promise<SettingWritten>;
	workspaceId: string;
	draft: string | null;
	expectedValue: string | undefined;
	onDraft: (value: string | null, submittedValue?: string) => void;
	catalog?: ModelCatalog | undefined;
	/** The dotted setting path, for the Advanced page. The calm pages state the label and nothing else. */
	showPath?: boolean;
}) {
	const fieldId = useId(),
		helpId = useId();
	const submitting = useRef(false);
	const [structuredValid, setStructuredValid] = useState(true);
	const [editorRevision, setEditorRevision] = useState(0);
	const [confirmed, setConfirmed] = useState(false),
		[saved, setSaved] = useState<{ sentences: string[]; timing: SettingWritten["timing"] } | null>(null);
	const write = useMutation({
		scope: { id: `settings-write:${workspaceId}` },
		mutationFn: save,
		onSuccess: (result, variables) => {
			setSaved({
				sentences: writtenSentences(result.changed, result.controls.controls, control.path),
				timing: result.timing,
			});
			onDraft(null, variables.value);
			setConfirmed(false);
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const value = draft ?? control.value;
	const dirty = draft !== null && draft !== control.value;
	const options = selectOptions(control);
	const edit = (next: string) => {
		onDraft(next === control.value ? null : next);
		setSaved(null);
		setConfirmed(false);
		write.reset();
	};
	const writable = control.access === "writable";
	const structured = control.kind === "json" && !!STRUCTURED_SETTINGS[control.path];
	return (
		<div className="setting-control" data-access={control.access}>
			<div className="setting-control__about">
				<label htmlFor={writable && !structured ? fieldId : undefined}>{control.label}</label>
				<p id={helpId}>{control.description}</p>
				{control.help && <p className="setting-control__help">{control.help}</p>}
				{control.note && <p className="setting-control__note">{control.note}</p>}
				<small className="setting-control__source">
					{showPath ? <code>{control.path}</code> : null}
					<Link
						to={`/settings/effective?${new URLSearchParams({ workspace: workspaceId, q: control.path })}`}
						title="Inspect the effective value and every layer that sets it"
					>
						{sourceLabel(control.source)}
					</Link>
					<span title={TIMING_SENTENCE[control.timing]}>· {TIMING_PHRASE[control.timing]}</span>
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
							if (dirty && structuredValid && !submitting.current) {
								submitting.current = true;
								write.mutate({
									path: control.path,
									value,
									expectedValue: expectedValue ?? control.value,
									...(control.confirm ? { confirmed } : {}),
								});
							}
						}}
					>
						{structured ? (
							<StructuredSettingsEditor
								key={`${control.value}:${editorRevision}`}
								path={control.path}
								value={value}
								disabled={write.isPending}
								onChange={edit}
								suggestions={control.suggestions}
								onValidityChange={setStructuredValid}
								describedBy={helpId}
							/>
						) : catalog ? (
							<ModelSelect
								id={fieldId}
								describedBy={helpId}
								value={value}
								models={catalog.models}
								defaultModel={catalog.defaultModel}
								disabled={write.isPending}
								note={catalog.note}
								onChange={edit}
							/>
						) : OPEN_CHOICES[control.path] ? (
							<OpenChoiceField
								id={fieldId}
								describedBy={helpId}
								choice={OPEN_CHOICES[control.path] as OpenChoice}
								value={value}
								disabled={write.isPending}
								onChange={edit}
							/>
						) : options ? (
							<select
								id={fieldId}
								aria-describedby={helpId}
								value={value}
								disabled={write.isPending}
								onChange={(event) => edit(event.target.value)}
							>
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
								disabled={write.isPending}
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
								<input
									type="checkbox"
									checked={confirmed}
									disabled={write.isPending}
									onChange={(event) => setConfirmed(event.target.checked)}
								/>
								<span>{control.confirm} I understand.</span>
							</label>
						)}
						{dirty && (
							<div className="setting-control__actions">
								<button
									type="submit"
									className="primary"
									disabled={write.isPending || !structuredValid || (!!control.confirm && !confirmed)}
								>
									{write.isPaused ? "Waiting…" : write.isPending ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									disabled={write.isPending}
									onClick={() => {
										edit(control.value);
										setEditorRevision((previous) => previous + 1);
									}}
								>
									Revert
								</button>
							</div>
						)}
						{write.error && (
							<p className="setting-control__error" role="alert">
								{write.error.message}
							</p>
						)}
						{saved && (
							<p className="setting-control__saved" role="status">
								{saved.sentences.join(" ")} {TIMING_SENTENCE[saved.timing]}
							</p>
						)}
					</form>
				)}
			</div>
		</div>
	);
}

export function SettingsControlsView({
	client,
	workspaceId,
	compact = false,
	scope,
}: {
	client: Client;
	workspaceId: string;
	compact?: boolean;
	/** One calm page of Settings: only its controls, no section tabs, searchable on the Advanced page. */
	scope?: SettingsScopeId;
}) {
	const queries = useQueryClient();
	const selectionId = useId();
	const [search, setSearch] = useSearchParams();
	const [localDiscovery, setLocalDiscovery] = useState<{ section: string | null; q: string }>({ section: null, q: "" });
	const [selectedControl, setSelectedControl] = useState<string | null>(null);
	const section = compact ? localDiscovery.section : search.get("section"),
		filter = compact ? localDiscovery.q : (search.get("q") ?? "");
	const discover = (sectionId: string | null, query: string, replace = false) => {
		if (compact) {
			setLocalDiscovery({ section: sectionId, q: query });
			setSelectedControl(null);
			return;
		}
		setSearch(
			(current) => {
				const next = new URLSearchParams(current);
				if (sectionId) next.set("section", sectionId);
				else next.delete("section");
				if (query) next.set("q", query);
				else next.delete("q");
				return next;
			},
			{ replace },
		);
	};
	const [showDrafts, setShowDrafts] = useState(false);
	const [drafts, setDrafts, updateDraft, originalDraftValue] = useSettingsDrafts(client, workspaceId);
	const key = ["settings-controls", workspaceId];
	const report = useQuery({
		queryKey: key,
		queryFn: () => client.call(routes.settingsControls, { ...emptyInput, params: { id: workspaceId } }),
	});
	useEffect(() => {
		if (!report.data) return;
		setDrafts((current) => {
			const next = { ...current };
			let changed = false;
			for (const control of report.data.controls) {
				if (next[control.path] !== control.value) continue;
				delete next[control.path];
				changed = true;
			}
			return changed ? next : current;
		});
	}, [report.data, setDrafts]);
	// Model settings pick from their target's catalog. The inventory is read only when one is on
	// screen, and "Check again" asks that target's endpoint for its current list.
	const modelsVisible = (report.data?.controls ?? []).some((control) => MODEL_TARGET_PATHS[control.path]);
	const inventory = useQuery({
		queryKey: ["targets", workspaceId],
		queryFn: () => client.call(routes.targetsList, { ...emptyInput, params: { id: workspaceId } }),
		enabled: modelsVisible,
	});
	const [check, setCheck] = useState<{ operationId: string; targetId: string } | null>(null);
	const checkOperation = useOperation(client, check?.operationId ?? null);
	const startCheck = useMutation({
		mutationFn: (targetId: string) =>
			client.call(routes.targetsProbe, { ...emptyInput, params: { id: workspaceId, targetId } }),
		onSuccess: (value, targetId) => setCheck({ operationId: value.operationId, targetId }),
	});
	useEffect(() => {
		const result = checkOperation.data?.status === "succeeded" ? checkOperation.data.result : null;
		if (result && "targets" in result) queries.setQueryData(["targets", workspaceId], result.targets);
	}, [checkOperation.data, queries, workspaceId]);
	const catalogFor = (control: SettingControl): ModelCatalog | undefined => {
		const targetPath = MODEL_TARGET_PATHS[control.path];
		if (!targetPath || control.access !== "writable") return undefined;
		const targetControl = report.data?.controls.find((candidate) => candidate.path === targetPath);
		const targetId = drafts[targetPath] ?? targetControl?.value ?? "";
		if (targetId === "")
			return {
				models: null,
				defaultModel: null,
				note: `${targetControl?.label ?? targetPath} is automatic, so type an exact model id or choose a target first.`,
			};
		if (inventory.isPending) return { models: null, defaultModel: null, note: `Reading ${targetId}'s models…` };
		if (!inventory.data)
			return {
				models: null,
				defaultModel: null,
				note: `The target list could not be read${inventory.error ? `: ${inventory.error.message}` : "."}`,
			};
		const target = inventory.data.targets.find((row) => row.id === targetId);
		if (!target) return { models: null, defaultModel: null, note: `${targetId} is not a configured connection.` };
		const checking =
			check?.targetId === targetId &&
			(startCheck.isPending || checkOperation.data?.status === "queued" || checkOperation.data?.status === "running");
		const checked = check?.targetId === targetId ? checkOperation.data : undefined;
		const source = checking
			? `Asking ${targetId} for its models…`
			: checked?.status === "succeeded"
				? `${targetId} answered at ${formatTime(checked.finishedAt)}: ${target.models.length} ${target.models.length === 1 ? "model" : "models"}.`
				: checked?.status === "failed"
					? `The check did not finish: ${checked.problem.detail} These are the models Clio Coder last read from ${targetId}.`
					: `The models Clio Coder last read from ${targetId}.`;
		return {
			models: target.models.length > 0 ? target.models : target.defaultModel ? [target.defaultModel] : null,
			defaultModel: target.defaultModel,
			note: (
				<>
					{source}
					{target.modelsTruncated
						? " The list shows the first 200; choose Advanced: unverified model id for one not shown."
						: ""}{" "}
					<button
						type="button"
						className="setting-control__check"
						disabled={checking || startCheck.isPending}
						onClick={() => startCheck.mutate(targetId)}
					>
						Check {targetId} again
					</button>
				</>
			),
		};
	};
	if (report.isPending) return <p>Reading settings…</p>;
	if (!report.data)
		return (
			<div role="alert">
				<p>{report.error?.message ?? "Settings are unavailable."}</p>
				<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
					{report.isFetching ? "Trying again…" : "Try again"}
				</button>
			</div>
		);
	const save = async (body: { path: string; value: string; confirmed?: boolean; expectedValue?: string }) => {
		const result = await client.call(routes.writeSetting, { params: { id: workspaceId }, query: {}, body });
		queries.setQueryData<SettingsControls>(key, result.controls);
		for (const stale of ["workspace-settings", "config-graph", "targets", "routing"])
			void queries.invalidateQueries({ queryKey: [stale] });
		return result;
	};
	const { sections, controls: everything, userFile } = report.data;
	// A search on the Advanced page reaches every control, so a link to any setting finds it.
	const controls =
		scope && !(scope === "advanced" && filter.trim())
			? everything.filter((control) => inScope(scope, control))
			: everything;
	const unsaved = controls.filter(
		(control) => drafts[control.path] !== undefined && drafts[control.path] !== control.value,
	);
	const active =
		scope || showDrafts || filter.trim() || (compact && section === "all")
			? null
			: (sections.find((candidate) => candidate.id === section)?.id ?? sections[0]?.id ?? null);
	const visible = showDrafts
		? unsaved
		: controls.filter((control) => (active ? control.section === active : matchesControl(control, filter)));
	const current = sections.find((candidate) => candidate.id === active);
	const chosen = visible.find((control) => control.path === selectedControl) ?? visible[0];
	const editorControls = compact && chosen ? [chosen] : visible;
	return (
		<>
			{report.error ? (
				<div className="settings-refresh" role="alert">
					<span>Could not refresh settings: {report.error.message} Showing the last received values.</span>
					<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
						{report.isFetching ? "Refreshing…" : "Retry refresh"}
					</button>
				</div>
			) : null}
			<div className={`settings-write-scope${scope && scope !== "advanced" ? " settings-write-scope--quiet" : ""}`}>
				{scope && scope !== "advanced" ? null : <strong>Save to your user settings</strong>}
				<p>Saved to your user settings and applied across projects. Project and command-line overrides take precedence.</p>
				{userFile && (
					<details>
						<summary>Saved settings file</summary>
						<code>{userFile}</code>
					</details>
				)}
			</div>
			{scope === undefined || scope === "advanced" ? (
				<label className="settings-filter">
					Find a setting
					<input
						type="search"
						value={filter}
						onChange={(event) => {
							discover(section, event.target.value, true);
							setShowDrafts(false);
						}}
					/>
				</label>
			) : null}
			{compact ? (
				<div className="sidebar-settings__selection">
					<div className="sidebar-settings__field">
						<label htmlFor={`${selectionId}-section`}>Section</label>
						<select
							id={`${selectionId}-section`}
							value={active ?? "all"}
							onChange={(event) => {
								discover(event.target.value, "");
								setShowDrafts(false);
							}}
						>
							<option value="all">All sections</option>
							{sections.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.label}
								</option>
							))}
						</select>
					</div>
					{active !== "targets" && active !== "advanced" && (
						<div className="sidebar-settings__field">
							<label htmlFor={`${selectionId}-setting`}>Setting · {visible.length}</label>
							<select
								id={`${selectionId}-setting`}
								value={chosen?.path ?? ""}
								disabled={!visible.length}
								onChange={(event) => setSelectedControl(event.target.value)}
							>
								{!visible.length && <option value="">No settings match</option>}
								{groupControls(visible).map(({ group, controls: rows }) => (
									<optgroup key={group} label={group}>
										{rows.map((control) => (
											<option key={control.path} value={control.path}>
												{control.label}
												{drafts[control.path] !== undefined ? " · unsaved" : ""}
											</option>
										))}
									</optgroup>
								))}
							</select>
						</div>
					)}
					{unsaved.length > 0 || showDrafts ? (
						<button type="button" aria-pressed={showDrafts} onClick={() => setShowDrafts(!showDrafts)}>
							Unsaved · {unsaved.length}
						</button>
					) : null}
				</div>
			) : scope ? null : (
				<nav className="settings-tabs" aria-label="Settings sections">
					{sections.map((candidate) => (
						<button
							type="button"
							key={candidate.id}
							aria-pressed={active === candidate.id}
							onClick={() => {
								discover(candidate.id, "");
								setShowDrafts(false);
							}}
						>
							{candidate.label}
						</button>
					))}
					{unsaved.length > 0 || showDrafts ? (
						<button
							type="button"
							aria-pressed={showDrafts}
							onClick={() => {
								discover(section, "");
								setShowDrafts(true);
							}}
						>
							Unsaved · {unsaved.length}
						</button>
					) : null}
				</nav>
			)}
			{!compact && !scope && (
				<h2>
					{showDrafts ? `Unsaved changes · ${visible.length}` : current ? current.label : `Matches · ${visible.length}`}
				</h2>
			)}
			{current && !compact && <p>{current.description}</p>}
			{unsaved.length > 0 && (
				<p className="settings-draft-note" role="status">
					{unsaved.length} unsaved {unsaved.length === 1 ? "change" : "changes"}. Save each control to apply it; filtering
					preserves drafts in this workspace.
				</p>
			)}
			{startCheck.error && <p role="alert">Could not start the model check: {startCheck.error.message}</p>}
			{checkOperation.error && <p role="alert">Model check progress is unavailable: {checkOperation.error.message}</p>}
			{active === "targets" && (
				<>
					<ConnectionSetup />
					<Link to={`/settings/targets?workspace=${workspaceId}`}>Manage connections</Link>
				</>
			)}
			{active === "advanced" && (
				<div className="setting-group">
					<p>Inspect saved defaults, effective values, and the sources that set them.</p>
					<p>
						<Link to={`/settings/effective?workspace=${workspaceId}`}>Effective settings</Link>
					</p>
					<p>
						<Link to={`/settings/why?workspace=${workspaceId}`}>Configuration sources and timing</Link>
					</p>
					<p>
						<Link to="/system">Check setup</Link>
					</p>
				</div>
			)}
			{!visible.length && active !== "targets" && active !== "advanced" && (
				<p>{showDrafts ? "No unsaved changes." : "No settings match."}</p>
			)}
			{groupControls(editorControls).map(({ group, controls: rows }) => (
				<section key={group} className="setting-group" aria-label={group}>
					{/* A calm page has only its h1 above, so its groups are the next level down. */}
					{scope ? <h2 className="setting-group__title">{group}</h2> : <h3>{group}</h3>}
					{rows.map((control) => (
						<ControlRow
							key={control.path}
							control={control}
							save={save}
							workspaceId={workspaceId}
							draft={drafts[control.path] ?? null}
							expectedValue={originalDraftValue(control.path)}
							onDraft={(value, submittedValue) => updateDraft(control.path, value, submittedValue, control.value)}
							catalog={catalogFor(control)}
							showPath={scope === undefined || scope === "advanced"}
						/>
					))}
				</section>
			))}
		</>
	);
}
