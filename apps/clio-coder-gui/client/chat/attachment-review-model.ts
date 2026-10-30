import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { Attachment } from "./attachments-model.js";

export const ATTACHMENT_PREVIEW_CHARACTERS = 12000;

/** Review uses a bounded projection. The original attachment is always the send/download body. */
export function attachmentReview(item: Attachment) {
	if (item.kind === "image") return { detail: `${item.width} × ${item.height} pixels`, text: null, truncated: false };
	const lines = item.text.split("\n").length;
	return {
		detail: `${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"} · ${item.bytes.toLocaleString("en-US")} bytes of UTF-8 text`,
		text: item.text.slice(0, ATTACHMENT_PREVIEW_CHARACTERS),
		truncated: item.text.length > ATTACHMENT_PREVIEW_CHARACTERS,
	};
}

export function attachmentBadge(name: string): string {
	return /\.([A-Za-z0-9]{1,4})$/u.exec(name)?.[1]?.toUpperCase() ?? "TXT";
}

/** Restored attachments still need this agent's announced support before they can be sent. */
export function attachmentCapabilityIssue(
	items: readonly Attachment[],
	capabilities: AgentCapabilities | undefined,
): string | null {
	if (!items.length) return null;
	if (!capabilities) return "Checking attachment support before sending. Your attachments stay here.";
	if (items.some((item) => item.kind === "image") && !capabilities.images)
		return "This agent does not accept images. Remove the image attachments before sending.";
	if (items.some((item) => item.kind === "file") && !capabilities.embeddedContext)
		return "This agent does not accept text attachments. Remove the text attachments before sending.";
	return null;
}
