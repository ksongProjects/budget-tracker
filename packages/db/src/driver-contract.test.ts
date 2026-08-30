import { describe, expect, it } from 'vitest';
import { DRIVER_CONTRACT } from './driver-contract.js';
import { createNodeDriver } from './drivers/node.js';

/**
 * The node driver against the shared contract. Every other driver — expo-sqlite
 * on device, SQLite WASM in the browser — runs these same cases in its own
 * harness, which is the only thing that makes them interchangeable.
 */
describe('node driver honours the driver contract', () => {
  for (const testCase of DRIVER_CONTRACT) {
    it(testCase.name, async () => {
      const driver = createNodeDriver();
      try {
        await testCase.run(driver);
      } finally {
        await driver.close();
      }
    });
  }
});

it('the contract is not accidentally empty', () => {
  expect(DRIVER_CONTRACT.length).toBeGreaterThan(10);
});
