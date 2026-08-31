import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLedger } from '../src/db/provider';
import { storePhoto } from '../src/capture/documents';
import { colors, radius, spacing, text } from '../src/ui/theme';

/**
 * Photograph a receipt. The shutter's only job is to get the photo stored and
 * move on — extraction and confirmation happen on the next screen, so a slow
 * or absent OCR engine never blocks the capture itself.
 */
export default function CaptureScreen(): ReactNode {
  const ledger = useLedger();
  const router = useRouter();
  const camera = useRef<CameraView>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!permission) {
    return <Centered>Checking camera access…</Centered>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={text.heading}>Camera access</Text>
        <Text style={[text.muted, styles.permissionBody]}>
          Photos of your receipts stay on this device. They are never uploaded.
        </Text>
        <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={() => void requestPermission()}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const shoot = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const photo = await camera.current?.takePictureAsync({ quality: 1, skipProcessing: true });
      if (!photo) throw new Error('The camera returned no photo.');

      const stored = await storePhoto(ledger.driver, ledger.deviceId, photo.uri);
      router.replace(`/confirm/${stored.captureId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <CameraView ref={camera} style={styles.camera} facing="back" />

      <View style={styles.controls}>
        {error !== null && <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.error}
        >
          {error}
        </Text>}
        <Pressable accessibilityRole="button"
          onPress={() => void shoot()}
          disabled={busy}
          style={[styles.shutter, busy && styles.shutterBusy]}
          accessibilityLabel="Take photo"
        />
        <Text style={text.faint}>{busy ? 'Saving…' : 'Fit the whole receipt in frame'}</Text>
      </View>
    </View>
  );
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return (
    <View style={styles.centered}>
      <Text style={text.muted}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  permissionBody: { textAlign: 'center' },
  controls: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    backgroundColor: colors.background,
  },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.text,
    borderWidth: 4,
    borderColor: colors.textMuted,
  },
  shutterBusy: { opacity: 0.4 },
  primaryButton: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  primaryButtonText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  error: { color: colors.danger, paddingHorizontal: spacing.md, textAlign: 'center' },
});
