/**
 * @budget/report — what the ledger looks like when it leaves the app.
 *
 * CSV and the PDF report's HTML, plus the calendar helpers they and the screens
 * share. No filesystem and no platform: the phone and the browser produce byte
 * -identical output because they run the same code, not because two
 * implementations were kept in step by hand.
 */
export * from './dates.js';
export * from './format.js';
