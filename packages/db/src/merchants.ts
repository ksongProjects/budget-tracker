import { uuidv7 } from '@budget/schema';
import type { MerchantId } from '@budget/schema';
import type { RepositoryContext } from './context.js';
import { recordTombstone } from './tombstones.js';

/**
 * The same shop reaches us as `SQ *BLUE BOTTLE`, `BLUE BOTTLE COFFEE #4`, and
 * `BLUEBOTTLE.COM` — payment processors, store numbers, and web checkouts each
 * mangle the name differently. Canonicalization folds those into one merchant so
 * that "how much do I spend on coffee" has an answer.
 *
 * Normalization is deliberately conservative. Over-merging attributes spending
 * to the wrong merchant, which is worse than showing two entries the user can
 * merge by hand: a wrong total is invisible, a duplicate is obvious.
 */

/** Payment-processor and platform prefixes that carry no merchant identity. */
const PREFIXES = [
  'sq *', 'sq*', 'tst*', 'tst *', 'sp *', 'sp*', 'py *', 'py*',
  'paypal *', 'pp*', 'pp *', 'ppl*', 'sumup *', 'iz *', 'toast*',
  'wl *', 'dd *', 'dd*',
];

/**
 * Trailing noise: store numbers, terminal ids, and the like. Each pattern
 * requires the digits that make it noise — a bare trailing word is part of the
 * name. Stripping it would fold "Apple Store" into "Apple", and a total
 * attributed to the wrong merchant is invisible in a way a duplicate is not.
 */
const TRAILING_NOISE = [
  /\s+#\d+$/,
  /\s+\d{3,}$/,
  /\s+store\s+\d+$/i,
  /\s+\d{2}\/\d{2}$/,
];

const TOP_LEVEL_DOMAINS = /\.(com|net|org|co|io|shop|store)$/i;

/**
 * Fold a raw merchant string into a comparison key. Two strings with the same
 * key are the same merchant. The key is for matching only — never shown; the
 * user sees `canonical_name`.
 */
export function normalizeMerchantName(raw: string): string {
  let name = raw.trim().toLowerCase();

  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length).trim();
      break;
    }
  }

  name = name.replace(TOP_LEVEL_DOMAINS, '');

  let changed = true;
  while (changed) {
    const before = name;
    for (const pattern of TRAILING_NOISE) {
      name = name.replace(pattern, '');
    }
    name = name.trim();
    changed = name !== before;
  }

  // Collapse punctuation to spaces so "blue-bottle" and "blue bottle" agree.
  name = name.replace(/[^a-z0-9]+/g, ' ').trim();

  return name;
}

/**
 * Turn a raw string into a display name: title case, since receipts shout in
 * all caps and a ledger full of SHOUTING is unreadable.
 */
export function displayMerchantName(raw: string): string {
  const normalized = normalizeMerchantName(raw);
  if (normalized === '') return raw.trim();

  return normalized
    .split(' ')
    .map((word) => (word[0] ?? '').toUpperCase() + word.slice(1))
    .join(' ');
}

interface MerchantRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly rev: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly origin_device: string;
}

interface AliasRow {
  readonly alias: string;
  readonly merchant_id: string;
  readonly rev: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly origin_device: string;
}

export class MerchantRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  /**
   * Find the merchant for a raw string, creating one if this is the first time
   * we have seen it. Every raw spelling is recorded as an alias, so the next
   * occurrence resolves by exact lookup rather than by guessing again.
   */
  async resolve(rawName: string): Promise<MerchantId> {
    // One transaction: a merchant without its alias would never be found again,
    // and the next resolve would create a duplicate.
    return this.ctx.driver.transaction(() => this.resolveWithin(rawName));
  }

  /**
   * `resolve` for a caller already inside a transaction — writing a record, or
   * importing a statement — since the driver refuses to nest one. The caller's
   * transaction is what keeps the merchant and its alias together.
   */
  async resolveWithin(rawName: string): Promise<MerchantId> {
    const key = normalizeMerchantName(rawName);
    if (key === '') {
      throw new Error(`merchant name is empty after normalization: ${JSON.stringify(rawName)}`);
    }

    const existing = await this.ctx.driver.get<{ merchant_id: string }>(
      'SELECT merchant_id FROM merchant_aliases WHERE alias = ? AND deleted_at IS NULL',
      [key],
    );
    if (existing) {
      return existing.merchant_id as MerchantId;
    }

    const id = uuidv7() as MerchantId;
    const now = this.ctx.clock();

    await this.ctx.driver.run(
      `INSERT INTO merchants (id, canonical_name, rev, updated_at, origin_device)
       VALUES (?, ?, 1, ?, ?)`,
      [id, displayMerchantName(rawName), now, this.ctx.deviceId],
    );
    await this.ctx.driver.run(
      `INSERT INTO merchant_aliases (alias, merchant_id, rev, updated_at, origin_device)
       VALUES (?, ?, 1, ?, ?)`,
      [key, id, now, this.ctx.deviceId],
    );

    return id;
  }

  /** Point an additional spelling at an existing merchant. */
  async addAlias(rawName: string, merchantId: MerchantId): Promise<void> {
    const key = normalizeMerchantName(rawName);

    await this.ctx.driver.transaction(async () => {
      const existing = await this.ctx.driver.get<AliasRow>(
        `SELECT alias, merchant_id, rev, updated_at, deleted_at, origin_device
         FROM merchant_aliases WHERE alias = ?`,
        [key],
      );

      if (!existing) {
        await this.ctx.driver.run(
          `INSERT INTO merchant_aliases (alias, merchant_id, rev, updated_at, origin_device)
           VALUES (?, ?, 1, ?, ?)`,
          [key, merchantId, this.ctx.clock(), this.ctx.deviceId],
        );
        return;
      }

      // Repointing an alias overwrites which merchant a spelling belongs to;
      // keep the previous mapping so the change is recoverable.
      await recordTombstone(this.ctx, 'merchant_aliases', key, existing.rev, existing);

      await this.ctx.driver.run(
        `UPDATE merchant_aliases
         SET merchant_id = ?, rev = ?, updated_at = ?, origin_device = ?
         WHERE alias = ?`,
        [merchantId, existing.rev + 1, this.ctx.clock(), this.ctx.deviceId, key],
      );
    });
  }

  async name(merchantId: MerchantId): Promise<string | undefined> {
    const row = await this.ctx.driver.get<{ canonical_name: string }>(
      'SELECT canonical_name FROM merchants WHERE id = ? AND deleted_at IS NULL',
      [merchantId],
    );
    return row?.canonical_name;
  }

  /** Rename for display. Aliases are untouched: they are match keys, not labels. */
  async rename(merchantId: MerchantId, canonicalName: string): Promise<void> {
    await this.ctx.driver.transaction(async () => {
      const existing = await this.ctx.driver.get<MerchantRow>(
        `SELECT id, canonical_name, rev, updated_at, deleted_at, origin_device
         FROM merchants WHERE id = ?`,
        [merchantId],
      );
      if (!existing) {
        throw new Error(`no merchant ${merchantId}`);
      }

      await recordTombstone(this.ctx, 'merchants', merchantId, existing.rev, existing);

      await this.ctx.driver.run(
        `UPDATE merchants SET canonical_name = ?, rev = ?, updated_at = ?, origin_device = ?
         WHERE id = ?`,
        [canonicalName, existing.rev + 1, this.ctx.clock(), this.ctx.deviceId, merchantId],
      );
    });
  }
}
