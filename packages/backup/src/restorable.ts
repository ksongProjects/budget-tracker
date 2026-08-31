import { ArchiveError } from './format.js';
import type { ArchiveHeader } from './format.js';

/**
 * Whether this build may restore this archive.
 *
 * The format version is checked when the header is parsed — that is about
 * bytes. This is about *rows*: an archive written by a newer app carries a
 * newer schema, and merging it into an older ledger is a downgrade. The merge
 * would insert rows whose columns this build does not know, or silently drop
 * them, and the failure would surface much later as data that quietly went
 * missing.
 *
 * So a downgrade is refused, and the message names the fix — update the app —
 * because the archive is fine and the user has done nothing wrong.
 *
 * The reverse is always allowed: restoring an *older* archive into a newer
 * ledger is the normal case after reinstalling, and migrations exist to carry
 * those rows forward.
 */

export class ArchiveSchemaError extends ArchiveError {
  constructor(
    readonly archiveSchema: number,
    readonly appSchema: number,
  ) {
    super(
      `This backup came from a newer version of the app (data version ${String(archiveSchema)}, this app reads ${String(appSchema)}). Update the app, then restore it.`,
    );
  }
}

/** Throws `ArchiveSchemaError` when the archive is from a newer schema than this build. */
export function assertRestorable(header: ArchiveHeader, appSchemaVersion: number): void {
  if (header.schemaVersion > appSchemaVersion) {
    throw new ArchiveSchemaError(header.schemaVersion, appSchemaVersion);
  }
}

/** Whether an archive can be restored here, for a screen that wants to grey out a button. */
export function isRestorable(header: ArchiveHeader, appSchemaVersion: number): boolean {
  return header.schemaVersion <= appSchemaVersion;
}
