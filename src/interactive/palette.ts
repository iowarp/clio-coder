import { fgSequence, GLYPH, SGR_BOLD, SGR_DIM, SGR_ITALIC, SGR_RESET, SGR_UNDERLINE } from "./theme/index.js";

export const RESET = SGR_RESET;
export const BOLD = SGR_BOLD;
export const DIM = SGR_DIM;
export const ITALIC = SGR_ITALIC;
export const UNDERLINE = SGR_UNDERLINE;

export const TEAL = fgSequence("accent");
export const BLUE_REASON = fgSequence("reason");
export const GREEN_OK = fgSequence("success");
export const AMBER = fgSequence("warning");
export const RED_CRIT = fgSequence("error");
export const DIM_GRAY = fgSequence("dim");

export const AGENT_GLYPH = GLYPH.agent;
export const USER_GLYPH = GLYPH.user;
