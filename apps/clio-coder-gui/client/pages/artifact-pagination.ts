import { MAX_SERVED_ARTIFACT_IDS } from "../../contracts/common.js";

// The server admits a page's ids when it serves them, but the browser drops its
// oldest page only once the next response arrives, and never if that response
// is lost. The admission window therefore holds the retained pages plus the one
// in flight, so no link still on screen has been evicted.
export const ARTIFACT_MAX_PAGES = 2;
export const ARTIFACT_PAGE_SIZE = Math.floor(MAX_SERVED_ARTIFACT_IDS / (ARTIFACT_MAX_PAGES + 1));
