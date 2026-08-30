import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@budget/db', () => {
  it('is wired into the workspace build and test run', () => {
    expect(PACKAGE_NAME).toBe('@budget/db');
  });
});
