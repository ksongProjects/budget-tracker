/**
 * @budget/backup — the archive format from docs/backup-format.md.
 *
 * Nothing here touches a filesystem: callers stream bytes wherever they belong,
 * which is what lets the same code run on a phone and in a browser.
 */
export * from './format.js';
export * from './naming.js';
export * from './archive.js';
export * from './cloud.js';
export * from './drive.js';
