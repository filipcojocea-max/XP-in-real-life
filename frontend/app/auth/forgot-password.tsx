import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Link, router } from 'expo-router';
import { api } from '../../src/api';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    email: string;
    delivered: boolean;
    devCode?: string;
    devLink?: string;
  } | null>(null);

  // Origin used by the backend to build the magic link in the email.
  // On web we have window.location.origin; on native we leave undefined and
  // the backend falls back to the request Origin header / APP_URL env var.
  const origin =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? window.location.origin
      : undefined;

  const submit = async () => {
    setError(null);
    if (!email.trim()) {
      setError('Enter the email you used to register.');
      return;
    }
    setLoading(true);
    try {
      const r = await api.authForgotPassword(email.trim().toLowerCase(), origin);
      setSent({
        email: r.email,
        delivered: r.email_delivered,
        devCode: r.dev_code,
        devLink: r.dev_link,
      });
    } catch (e: any) {
      const msg = String(e?.message || e || 'Could not send reset email.');
      setError(msg);
      showAlert('Could not send reset email', msg);
    } finally {
      setLoading(false);
    }
  };

  // SUCCESS / "we sent it" screen
  if (sent) {
    return (
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <TouchableOpacity
              testID="fp-back"
              style={styles.backBtn}
              onPress={() => router.replace('/auth/login')}
            >
              <Ionicons name="chevron-back" size={20} color={colors.text} />
              <Text style={styles.backText}>Back to login</Text>
            </TouchableOpacity>

            <View style={[styles.iconBubble, { backgroundColor: colors.green + '22', borderColor: colors.green + '55' }]}>
              <Ionicons name="mail-open" size={36} color={colors.green} />
            </View>

            <Text style={styles.title}>Check your email 📬</Text>
            <Text style={styles.subtitle}>
              We sent a reset email to{'\n'}
              <Text style={{ color: colors.cyan, fontWeight: '900' }}>{sent.email}</Text>
            </Text>

            <View style={styles.optionCard}>
              <View style={styles.optionHeader}>
                <View style={styles.optionNum}>
                  <Text style={styles.optionNumText}>1</Text>
                </View>
                <Text style={styles.optionTitle}>Tap the reset link in the email</Text>
              </View>
              <Text style={styles.optionDesc}>
                The fastest way. The link will open this app right at the “Change password” screen.
              </Text>
              {sent.devLink ? (
                <View style={styles.devBox}>
                  <Text style={styles.devLabel}>DEV LINK</Text>
                  <Text style={styles.devValue} selectable numberOfLines={3}>
                    {sent.devLink}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>

            <View style={styles.optionCard}>
              <View style={styles.optionHeader}>
                <View style={styles.optionNum}>
                  <Text style={styles.optionNumText}>2</Text>
                </View>
                <Text style={styles.optionTitle}>Enter the 6-digit code from the email</Text>
              </View>
              <Text style={styles.optionDesc}>
                Use this if the link doesn't work or you can't open it on this device.
              </Text>
              {sent.devCode ? (
                <View style={styles.devBox}>
                  <Text style={styles.devLabel}>DEV CODE</Text>
                  <Text style={[styles.devValue, { fontSize: 22, letterSpacing: 6 }]} selectable>
                    {sent.devCode}
                  </Text>
                </View>
              ) : null}
              <TouchableOpacity
                testID="fp-have-code"
                style={styles.codeBtn}
                onPress={() =>
                  router.push({
                    pathname: '/auth/reset-password',
                    params: { email: sent.email },
                  })
                }
              >
                <Ionicons name="keypad" size={18} color={colors.bg} />
                <Text style={styles.codeBtnText}>Enter Reset Code</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.helpHint}>
              Didn't get an email? Check spam, or{' '}
              <Text
                onPress={() => setSent(null)}
                style={{ color: colors.cyan, fontWeight: '800' }}
              >
                try a different email
              </Text>
              .
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // INITIAL "enter email" screen
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity
            testID="fp-back"
            style={styles.backBtn}
            onPress={() => router.replace('/auth/login')}
          >
            <Ionicons name="chevron-back" size={20} color={colors.text} />
            <Text style={styles.backText}>Back to login</Text>
          </TouchableOpacity>

          <View style={[styles.iconBubble, { backgroundColor: colors.cyan + '22', borderColor: colors.cyan + '55' }]}>
            <Ionicons name="key" size={36} color={colors.cyan} />
          </View>

          <Text style={styles.title}>Forgot password?</Text>
          <Text style={styles.subtitle}>
            Enter the email you signed up with — we'll send a reset link AND a 6-digit code so you
            can pick whichever works on your device.
          </Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="fp-email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            style={styles.input}
          />

          {error ? (
            <View style={styles.errorBox} testID="fp-error">
              <Ionicons name="alert-circle" size={16} color={colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            testID="fp-submit"
            disabled={loading}
            onPress={submit}
            style={[styles.btn, loading && { opacity: 0.6 }]}
          >
            {loading ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Ionicons name="send" size={18} color={colors.bg} />
                <Text style={styles.btnText}>Send Reset Email</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={styles.linkRow}>
            <Text style={styles.linkLabel}>Remembered it? </Text>
            <Link href="/auth/login" asChild>
              <TouchableOpacity testID="fp-go-login">
                <Text style={styles.linkText}>Sign in</Text>
              </TouchableOpacity>
            </Link>
          </View>

          <View style={styles.linkRow}>
            <Text style={styles.linkLabel}>Have a code already? </Text>
            <Link href="/auth/reset-password" asChild>
              <TouchableOpacity testID="fp-go-reset-code">
                <Text style={styles.linkText}>Enter reset code</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingRight: 10,
    marginBottom: spacing.md,
  },
  backText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  iconBubble: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    lineHeight: 20,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.green,
    borderRadius: radii.pill,
    paddingVertical: 16,
    marginTop: spacing.lg,
  },
  btnText: { color: colors.bg, fontWeight: '900', fontSize: 15 },
  linkRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  linkLabel: { color: colors.textMuted },
  linkText: { color: colors.cyan, fontWeight: '800' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: colors.red + '15',
    borderColor: colors.red + '55',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    marginTop: spacing.md,
  },
  errorText: { color: colors.red, fontSize: 13, fontWeight: '700', flex: 1, lineHeight: 18 },
  optionCard: {
    backgroundColor: colors.surfaceGlass,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  optionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 6 },
  optionNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionNumText: { color: colors.bg, fontWeight: '900', fontSize: 13 },
  optionTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
  optionDesc: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginLeft: 34 },
  devBox: {
    backgroundColor: colors.bg,
    borderColor: colors.amber + '55',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
    marginLeft: 34,
  },
  devLabel: {
    color: colors.amber,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  devValue: {
    color: colors.cyan,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    fontWeight: '700',
  },
  codeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.cyan,
    borderRadius: radii.pill,
    paddingVertical: 12,
    marginTop: spacing.md,
    marginLeft: 34,
  },
  codeBtnText: { color: colors.bg, fontWeight: '900', fontSize: 14 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: spacing.sm },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  helpHint: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.lg,
    lineHeight: 17,
  },
});
