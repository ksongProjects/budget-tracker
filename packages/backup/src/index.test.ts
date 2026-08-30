import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@budget/backup', () => {
  it('is wired into the workspace build and test run', () => {
    expect(PACKAGE_NAME).toBe('@budget/backup');
  });
});
