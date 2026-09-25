import { MAX_SERVED_ARTIFACT_IDS } from "../../contracts/common.js";

// Two retained pages fit the server's admission window.
export const ARTIFACT_MAX_PAGES = 2;
export const ARTIFACT_PAGE_SIZE = MAX_SERVED_ARTIFACT_IDS / ARTIFACT_MAX_PAGES;
