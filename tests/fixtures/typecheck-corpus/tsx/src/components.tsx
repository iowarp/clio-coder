interface BadgeProps {
	label: string;
	tone?: "info" | "warn";
}
export function Badge(props: BadgeProps) {
	return <div id={props.label}>{props.tone}</div>;
}
export const missingProp = <Badge />;
export const wrongProp = <Badge label="ok" tone="error" />;
export const undefinedProp = <Badge label="ok" tone={undefined} />;
export const unknownTag = <span>text</span>;
export const badHandler = <button onClick={(event: KeyboardEvent) => event.key}>go</button>;
export const fine = (
	<>
		<Badge label="ok" />
		<button disabled>{["a"][0]}</button>
	</>
);
