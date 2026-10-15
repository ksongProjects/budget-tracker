import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Camera, FileText, Keyboard, Mic, Plus, X, decorative } from './icons';
import { MIN_TOUCH_TARGET, colors, radius, spacing } from './theme';

/**
 * One button that opens into the four ways to record a spend.
 *
 * Four permanent buttons on the ledger would compete with the ledger; one that
 * expands keeps the list the subject of its own screen. The options are labelled
 * words, not bare icons — a microphone glyph is only obvious to someone who
 * already knows what it does here.
 *
 * Closing on the way out matters: leaving it open means coming back from the
 * camera to a menu covering the list you came back to read.
 */

interface Option {
  readonly label: string;
  readonly href: '/add' | '/capture' | '/voice' | '/import';
  readonly icon: ReactNode;
}

export function CaptureMenu(): ReactNode {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const options: readonly Option[] = [
    { label: 'Type it', href: '/add', icon: <Keyboard {...decorative()} /> },
    { label: 'Photograph a receipt', href: '/capture', icon: <Camera {...decorative()} /> },
    { label: 'Say it', href: '/voice', icon: <Mic {...decorative()} /> },
    { label: 'Upload a file', href: '/import', icon: <FileText {...decorative()} /> },
  ];

  return (
    <>
      {open && (
        // Tapping anywhere else closes it, which is what everyone tries first.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the capture menu"
          style={styles.scrim}
          onPress={() => {
            setOpen(false);
          }}
        />
      )}

      <View style={styles.dock} pointerEvents="box-none">
        {open &&
          options.map((option) => (
            <Pressable
              key={option.href}
              accessibilityRole="button"
              style={styles.option}
              onPress={() => {
                setOpen(false);
                router.push(option.href);
              }}
            >
              {option.icon}
              <Text style={styles.optionText}>{option.label}</Text>
            </Pressable>
          ))}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? 'Close the capture menu' : 'Record a spend'}
          accessibilityState={{ expanded: open }}
          style={styles.fab}
          onPress={() => {
            setOpen((was) => !was);
          }}
        >
          {open ? (
            <X {...decorative({ size: 26, color: colors.accentText })} />
          ) : (
            <Plus {...decorative({ size: 26, color: colors.accentText })} />
          )}
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000000cc',
  },
  dock: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
