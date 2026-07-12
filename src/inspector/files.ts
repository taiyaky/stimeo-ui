import { extname } from "node:path";

/**
 * Single source of truth for which files the Inspector checks. Shared by the
 * CLI's directory walk and the VS Code extension's document filter so a file
 * never gets diagnostics in one surface and a silent pass in the other.
 */

/** Final extensions (lowercased) the Inspector understands. `.html.erb` ends with `.erb`. */
const CHECKABLE_FILE_EXTENSIONS = new Set([".erb", ".html", ".htm"]);

/**
 * Whether the path names a checkable HTML/ERB file. Matches on the *final*
 * extension only (`extname`), case-insensitively — case-only variants like
 * `legacy.HTM` are the same file on the case-insensitive filesystems most
 * Rails apps are edited on (macOS/Windows), so they must not slip past CI
 * while the editor flags them.
 */
export function isCheckableFile(path: string): boolean {
  return CHECKABLE_FILE_EXTENSIONS.has(extname(path).toLowerCase());
}
