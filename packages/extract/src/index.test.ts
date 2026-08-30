import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@budget/extract', () => {
  it('is wired into the workspace build and test run', () => {
    expect(PACKAGE_NAME).toBe('@budget/extract');
  });
});
