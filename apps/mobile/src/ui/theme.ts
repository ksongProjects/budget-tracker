import { StyleSheet } from 'react-native';
import { colors } from './colors';

export { MIN_TOUCH_TARGET, colors, contrastRatio } from './colors';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
} as const;

export const text = StyleSheet.create({
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  heading: { color: colors.text, fontSize: 20, fontWeight: '600' },
  body: { color: colors.text, fontSize: 16 },
  muted: { color: colors.textMuted, fontSize: 14 },
  faint: { color: colors.textFaint, fontSize: 12 },
  /** Tabular figures keep amounts aligned down a column, which is the point of a ledger. */
  amount: { color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'] },
});
