/**
 * The statement import service, now shared.
 *
 * It lived here first, because the web app is where statements were imported
 * first. The phone needs the identical behaviour — the same idea of what counts
 * as a duplicate, the same one-transaction commit — so the implementation moved
 * into @budget/db and this file is the door the web screens already knock on.
 */
export {
  commitImport,
  confirmAll,
  pendingRows,
  previewImport,
} from '@budget/db';
export type { ImportPreview, ImportResult, ImportSettings } from '@budget/db';
