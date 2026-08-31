/**
 * Colours, checked against WCAG AA rather than chosen by eye.
 *
 * Every text colour here clears 4.5:1 against every surface it is used on —
 * including `surfaceRaised`, the lightest, which is where contrast is worst.
 * `textFaint` did not: at #646d7d it was 3.0:1 on a raised surface, and it is
 * the colour this app puts evidence, dates and "read from the receipt" in —
 * exactly the small print someone needs to read to check a number.
 */
export const colors = {
  background: '#0f1115',
  surface: '#171a21',
  surfaceRaised: '#1f232c',
  border: '#2a2f3a',
  text: '#f2f4f8',
  textMuted: '#9aa3b2',
  textFaint: '#8892a1',
  accent: '#6ea8fe',
  accentText: '#0f1115',
  pending: '#e0a458',
  danger: '#e06c75',
} as const;

/**
 * The smallest a control may be and still be tappable, in dp.
 *
 * Android's guidance is 48; iOS says 44. Taking the larger keeps one number for
 * both, and a control that is comfortable for a person with a tremor is
 * comfortable for everyone else too.
 */
export const MIN_TOUCH_TARGET = 48;


/** Every colour this app puts text in, and the surfaces it puts them on. */
export const TEXT_COLORS = ['text', 'textMuted', 'textFaint', 'accent', 'pending', 'danger'] as const;
export const SURFACES = ['background', 'surface', 'surfaceRaised'] as const;

/**
 * WCAG relative luminance, and the contrast ratio between two colours.
 *
 * Here rather than in a test so the numbers the app is checked against are the
 * ones anyone can compute from the palette itself.
 */
export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
