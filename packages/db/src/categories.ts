import { CategorySchema, uuidv7 } from '@budget/schema';
import type { Category, CategoryId } from '@budget/schema';
import type { RepositoryContext } from './context.js';
import { DatabaseError } from './driver.js';
import { recordTombstone } from './tombstones.js';

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly rev: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly origin_device: string;
}

const SELECT = `SELECT id, name, parent_id, rev, updated_at, deleted_at, origin_device FROM categories`;

function toCategory(row: CategoryRow): Category {
  return CategorySchema.parse({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    rev: row.rev,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    originDevice: row.origin_device,
  });
}

/**
 * Categories the user spends against. Deleting one is a soft delete: existing
 * transactions keep pointing at it, because rewriting a user's history to tidy
 * up a category list would change what their past spending says.
 */
export class CategoryRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(name: string, parentId: CategoryId | null = null): Promise<Category> {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new DatabaseError('category name cannot be empty');
    }

    const category = CategorySchema.parse({
      id: uuidv7(),
      name: trimmed,
      parentId,
      rev: 1,
      updatedAt: this.ctx.clock(),
      deletedAt: null,
      originDevice: this.ctx.deviceId,
    });

    await this.ctx.driver.run(
      `INSERT INTO categories (id, name, parent_id, rev, updated_at, origin_device)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        category.id,
        category.name,
        category.parentId,
        category.rev,
        category.updatedAt,
        category.originDevice,
      ],
    );

    return category;
  }

  async get(id: CategoryId): Promise<Category | undefined> {
    const row = await this.ctx.driver.get<CategoryRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toCategory(row) : undefined;
  }

  async list(): Promise<Category[]> {
    const rows = await this.ctx.driver.all<CategoryRow>(
      `${SELECT} WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
    );
    return rows.map(toCategory);
  }

  /** Find by name, case-insensitively — what a create-inline picker needs to avoid duplicates. */
  async findByName(name: string): Promise<Category | undefined> {
    const row = await this.ctx.driver.get<CategoryRow>(
      `${SELECT} WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`,
      [name.trim()],
    );
    return row ? toCategory(row) : undefined;
  }

  /** Return the existing category with this name, or create it. */
  async resolve(name: string): Promise<Category> {
    return (await this.findByName(name)) ?? (await this.create(name));
  }

  async rename(id: CategoryId, name: string): Promise<Category> {
    return this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new DatabaseError(`no category ${id}`);
      }

      await recordTombstone(this.ctx, 'categories', id, existing.rev, existing);

      const next = CategorySchema.parse({
        ...existing,
        name: name.trim(),
        rev: existing.rev + 1,
        updatedAt: this.ctx.clock(),
        originDevice: this.ctx.deviceId,
      });

      await this.ctx.driver.run(
        `UPDATE categories SET name = ?, rev = ?, updated_at = ?, origin_device = ? WHERE id = ?`,
        [next.name, next.rev, next.updatedAt, next.originDevice, id],
      );

      return next;
    });
  }

  /** Soft delete. Transactions already filed here keep their category. */
  async softDelete(id: CategoryId): Promise<void> {
    await this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new DatabaseError(`no category ${id}`);
      }

      await recordTombstone(this.ctx, 'categories', id, existing.rev, existing);

      const at = this.ctx.clock();
      await this.ctx.driver.run(
        `UPDATE categories SET rev = ?, updated_at = ?, deleted_at = ?, origin_device = ? WHERE id = ?`,
        [existing.rev + 1, at, at, this.ctx.deviceId, id],
      );
    });
  }
}
