import React, { useEffect, useState } from 'react';
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
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

/**
 * ResetPassword screen. Two modes:
 *   1. Magic link: arrived from email with ?token=XXX[&email=YYY]
 *      → automatically validates the token, asks for a new password.
 *   2. Manual code: arrived via "I have a code" button
 *      → asks for email + 6-digit code + new password.
 */
export default function ResetPassword() {
  const { signIn } = useAuth();
  const params = useLocalSearchParams<{ token?: string; email?: string }>();
  const initialToken = (params.token || '').trim();
  const initialEmail = (params.email || '').trim();

  // Mode selection: token mode if URL had a token, otherwise code mode.
  const [mode, setMode] = useState<'token' | 'code'>(initialToken ? 'token' : 'code');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [token, setToken] = useState(initialToken);
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);

  const [verifying, setVerifying] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If we landed here from the email link, validate the token up-front
  // so we can show "Resetting password for foo@bar.com" + reject expired links.
  useEffect(() => {
    if (mode !== 'token' || !token) return;
    let cancelled = false;
    (async () => {
      setVerifying(true);
      setTokenError(null);
      try {
        const r = await api.authResetPasswordVerifyToken(token);
        if (!cancelled) {
          setVerifiedEmail(r.email);
        }
      } catch (e: any) {
        if (!cancelled) {
          setTokenError(String(e?.message || e || 'Reset link is invalid.'));
        }
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, token]);

  const submit = async () => {
    setError(null);
    if (!newPwd || newPwd.length < 5) {
      setError('Password must be at least 5 characters.');
      return;
    }
    if (newPwd !== confirmPwd) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      let r;
      if (mode === 'token') {
        if (!token) {
          throw new Error('Missing reset token.');
        }
        r = await api.authResetPasswordWithToken(token, newPwd);
      } else {
        if (!email.trim() || !code.trim()) {
          throw new Error('Enter both your email and the 6-digit code.');
        }
        r = await api.authResetPasswordWithCode(
          email.trim().toLowerCase(),
          code.trim(),
          newPwd
        );
      }
      // Auto-login the user with the JWT we got back
      await signIn(r.token, r.user);
      showAlert('Password reset', "You're signed in with your new password. 🎉");
      router.replace('/');
    } catch (e: any) {
      const msg = String(e?.message || e || 'Could not reset password.');
      setError(msg);
      showAlert('Reset failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────
  const renderHeader = () => (
    <>
      <TouchableOpacity
        testID="rp-back"
        style={styles.backBtn}
        onPress={() => router.replace('/auth/login')}
      >
        <Ionicons name="chevron-back" size={20} color={colors.text} />
        <Text style={styles.backText}>Back to login</Text>
      </TouchableOpacity>
      <View style={[styles.iconBubble, { backgroundColor: colors.green + '22', borderColor: colors.green + '55' }]}>
        <Ionicons name="lock-open" size={36} color={colors.green} />
      </View>
      <Text style={styles.title}>Change password</Text>
      <Text style={styles.subtitle}>Choose a new password for your account.</Text>
    </>
  );

  // Token mode is verifying
  if (mode === 'token' && verifying) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={[styles.scroll, { flex: 1, alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color={colors.green} />
          <Text style={[styles.subtitle, { marginTop: spacing.md }]}>Verifying reset link…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Token mode failed verification
  if (mode === 'token' && tokenError) {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          {renderHeader()}
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.red} />
            <Text style={styles.errorText}>{tokenError}</Text>
          </View>
          <TouchableOpacity
            testID="rp-switch-code"
            style={[styles.btn, { backgroundColor: colors.cyan, marginTop: spacing.md }]}
            onPress={() => {
              setMode('code');
              setTokenError(null);
              setVerifiedEmail(null);
            }}
          >
            <Ionicons name="keypad" size={18} color={colors.bg} />
            <Text style={styles.btnText}>Use a 6-digit code instead</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="rp-resend"
            style={[styles.btn, { backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm }]}
            onPress={() => router.replace('/auth/forgot-password')}
          >
            <Ionicons name="refresh" size={18} color={colors.text} />
            <Text style={[styles.btnText, { color: colors.text }]}>Request a new email</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {renderHeader()}

          {/* Mode toggle: Token / Code */}
          <View style={styles.modeRow}>
            <TouchableOpacity
              testID="rp-mode-token"
              onPress={() => setMode('token')}
              style={[styles.modeChip, mode === 'token' && styles.modeChipActive]}
            >
              <Ionicons
                name="link"
                size={14}
                color={mode === 'token' ? colors.bg : colors.cyan}
              />
              <Text style={[styles.modeChipText, mode === 'token' && { color: colors.bg }]}>
                Magic Link
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="rp-mode-code"
              onPress={() => setMode('code')}
              style={[styles.modeChip, mode === 'code' && styles.modeChipActive]}
            >
              <Ionicons
                name="keypad"
                size={14}
                color={mode === 'code' ? colors.bg : colors.cyan}
              />
              <Text style={[styles.modeChipText, mode === 'code' && { color: colors.bg }]}>
                6-Digit Code
              </Text>
            </TouchableOpacity>
          </View>

          {/* Mode-specific fields */}
          {mode === 'token' ? (
            <View>
              {verifiedEmail ? (
                <View style={styles.emailPill} testID="rp-verified-email">
                  <Ionicons name="checkmark-circle" size={14} color={colors.green} />
                  <Text style={styles.emailPillText}>
                    Resetting password for{' '}
                    <Text style={{ color: colors.cyan, fontWeight: '900' }}>
                      {verifiedEmail}
                    </Text>
                  </Text>
                </View>
              ) : null}

              <Text style={styles.label}>Reset Token</Text>
              <TextInput
                testID="rp-token"
                value={token}
                onChangeText={(t) => {
                  setToken(t);
                  setVerifiedEmail(null);
                  setTokenError(null);
                }}
                placeholder="Paste the token from the email link"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.fieldHint}>
                Tip: open the email and tap “Reset Password” — it should auto-fill this for you.
              </Text>
            </View>
          ) : (
            <View>
              <Text style={styles.label}>Email</Text>
              <TextInput
                testID="rp-email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                keyboardType="email-address"
                autoCorrect={false}
                style={styles.input}
              />

              <Text style={styles.label}>6-Digit Code</Text>
              <TextInput
                testID="rp-code"
                value={code}
                onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
                placeholder="123456"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                maxLength={6}
                style={[styles.input, styles.codeInput]}
              />
            </View>
          )}

          {/* New password fields (shared) */}
          <Text style={styles.label}>New Password (min 5 characters)</Text>
          <View style={styles.pwdRow}>
            <TextInput
              testID="rp-new-pwd"
              value={newPwd}
              onChangeText={setNewPwd}
              placeholder="•••••"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPwd}
              style={[styles.input, { flex: 1 }]}
              autoCapitalize="none"
            />
            <TouchableOpacity
              testID="rp-show-pwd"
              onPress={() => setShowPwd((v) => !v)}
              style={styles.eyeBtn}
            >
              <Ionicons
                name={showPwd ? 'eye-off' : 'eye'}
                size={18}
                color={colors.textSecondary}
              />
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>Confirm Password</Text>
          <TextInput
            testID="rp-confirm-pwd"
            value={confirmPwd}
            onChangeText={setConfirmPwd}
            placeholder="•••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry={!showPwd}
            style={styles.input}
            autoCapitalize="none"
          />

          {error ? (
            <View style={styles.errorBox} testID="rp-error">
              <Ionicons name="alert-circle" size={16} color={colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            testID="rp-submit"
            disabled={submitting}
            onPress={submit}
            style={[styles.btn, submitting && { opacity: 0.6 }]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={18} color={colors.bg} />
                <Text style={styles.btnText}>Change Password</Text>
              </>
            )}
          </TouchableOpacity>
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
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  modeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.cyan + '55',
    backgroundColor: 'transparent',
  },
  modeChipActive: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  modeChipText: { color: colors.cyan, fontSize: 13, fontWeight: '800' },
  emailPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.green + '15',
    borderColor: colors.green + '55',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.md,
    marginBottom: spacing.md,
  },
  emailPillText: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1 },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: spacing.md,
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
  codeInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  fieldHint: { color: colors.textMuted, fontSize: 11, marginTop: 6, lineHeight: 16 },
  pwdRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  eyeBtn: {
    width: 46,
    height: 46,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceGlass,
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
});
