import { describe, expect, it } from 'vitest';
import { SURFACES, TEXT_COLORS, colors, contrastRatio } from './colors.js';

/**
 * The palette, checked rather than eyeballed.
 *
 * A dark theme makes it easy to pick a grey that looks tasteful and is
 * unreadable in daylight or to anyone with reduced contrast sensitivity. This
 * caught exactly that: `textFaint` sat at 3.0:1 on a raised surface, and it is
 * the colour the app uses for evidence lines and dates — the small print
 * someone reads precisely when they are checking whether a number is right.
 */
describe('text contrast', () => {
  const cases = SURFACES.flatMap((surface) =>
    TEXT_COLORS.map((text) => ({ text, surface })),
  );

  it.each(cases)('$text on $surface clears WCAG AA', ({ text, surface }) => {
    expect(contrastRatio(colors[text], colors[surface])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the accent readable under the text placed on it', () => {
    // Buttons: dark text on the accent, rather than the accent on dark.
    expect(contrastRatio(colors.accentText, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('computes a known ratio correctly', () => {
    // Black on white is 21:1 by definition; a wrong implementation of the
    // formula would sail past every other test in this file.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });
});
