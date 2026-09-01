import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Currency } from '@budget/schema';
import { useProfileState } from '../src/profile/context';
import { ProfileFields, emailLooksWrong } from '../src/profile/fields';
import { FormError, PrimaryButton } from '../src/ui/form';
import {
  Download,
  FileText,
  Mail,
  Settings,
  ShieldCheck,
  decorative,
} from '../src/ui/icons';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from '../src/ui/theme';

/**
 * Profile and settings — the app's second screen, and everything that is not a
 * transaction.
 *
 * The header of the ledger used to grow a link per phase. This is where those
 * go instead: what the app knows about you at the top, then the places that act
 * on your data, in the order someone would need them.
 */
export default function ProfileScreen(): ReactNode {
  const { profile, save } = useProfileState();

  const [name, setName] = useState(profile?.displayName ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [currency, setCurrency] = useState<Currency | undefined>(profile?.defaultCurrency);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    name !== (profile?.displayName ?? '') ||
    email !== (profile?.email ?? '') ||
    currency !== profile?.defaultCurrency;

  const submit = async (): Promise<void> => {
    if (currency === undefined) return;

    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      await save({ displayName: name, email, defaultCurrency: currency });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.identity}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(profile?.displayName ?? '')}</Text>
        </View>
        <View style={styles.identityText}>
          <Text style={text.heading}>{profile?.displayName ?? 'You'}</Text>
          <Text style={text.muted}>{profile?.email ?? 'No email set'}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <ProfileFields
          name={name}
          onName={setName}
          email={email}
          onEmail={setEmail}
          currency={currency}
          onCurrency={setCurrency}
        />

        <FormError message={error} />

        <PrimaryButton
          label="Save changes"
          busyLabel="Saving…"
          busy={saving}
          disabled={!changed || emailLooksWrong(email)}
          onPress={() => void submit()}
        />

        {saved && !changed && <Text style={text.faint}>Saved.</Text>}
      </View>

      <Text style={text.muted}>Your data</Text>

      <Row
        href="/backup"
        icon={<ShieldCheck {...decorative({ color: colors.accent })} />}
        title="Backup and restore"
        detail="Encrypted, with a password only you know"
      />
      <Row
        href="/export"
        icon={<Download {...decorative({ color: colors.accent })} />}
        title="Export"
        detail="CSV or a printable report — and mail it to yourself"
      />
      <Row
        href="/import"
        icon={<FileText {...decorative({ color: colors.accent })} />}
        title="Import a statement"
        detail="A CSV from your bank"
      />
      <Row
        href="/assist"
        icon={<Settings {...decorative({ color: colors.accent })} />}
        title="Reading receipts"
        detail="What reads your captures, and what never leaves this phone"
      />

      <View style={styles.footer}>
        <Mail {...decorative({ size: 16, color: colors.textFaint })} />
        <Text style={text.faint}>
          There is no account here. Everything above lives on this phone, and travels only inside a
          backup you make.
        </Text>
      </View>
    </ScrollView>
  );
}

function Row({
  href,
  icon,
  title,
  detail,
}: {
  href: '/backup' | '/export' | '/import' | '/assist';
  icon: ReactNode;
  title: string;
  detail: string;
}): ReactNode {
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="button" style={styles.row}>
        {icon}
        <View style={styles.rowText}>
          <Text style={text.body}>{title}</Text>
          <Text style={text.faint}>{detail}</Text>
        </View>
      </Pressable>
    </Link>
  );
}

/** Two letters for the avatar. A name with one word gives one letter, and that is fine. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== '');
  const letters = parts.slice(0, 2).map((part) => part[0] ?? '');
  return letters.join('').toUpperCase() || '·';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: 20, fontWeight: '700' },
  identityText: { flex: 1, gap: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
  },
  rowText: { flex: 1, gap: 2 },
  footer: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.md },
});
