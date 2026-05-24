import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Link, router } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

export default function Login() {
  const { signIn, continueAnonymously } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter email and password.');
      return;
    }
    setLoading(true);
    try {
      const r = await api.authLogin(email.trim().toLowerCase(), password);
      if ((r as any).needs_verification) {
        const code = (r as any).dev_code;
        showAlert('Verify your email', `We sent a code to ${(r as any).email}.${code ? `\n\nDev code: ${code}` : ''}`);
        router.push({ pathname: '/auth/verify', params: { email: email.trim().toLowerCase(), dev_code: code || '' } });
        return;
      }
      await signIn((r as any).token, (r as any).user);
      router.replace('/');
    } catch (e: any) {
      const msg = String(e?.message || e || 'Could not sign in.');
      setError(msg);
      showAlert('Login failed', msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={styles.logoBox}>
              <Ionicons name="shield" size={36} color={colors.green} />
            </View>
            <Text style={styles.brandTitle}>XP IN REAL LIFE</Text>
            <Text style={styles.brandSub}>Welcome back, hero.</Text>
          </View>

          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="login-email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            style={styles.input}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            testID="login-password"
            value={password}
            onChangeText={setPassword}
            placeholder="•••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            style={styles.input}
          />

          {error ? (
            <View style={styles.errorBox} testID="login-error">
              <Ionicons name="alert-circle" size={16} color={colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity testID="login-submit" disabled={loading} onPress={submit} style={[styles.btn, loading && { opacity: 0.6 }]}>
            {loading ? <ActivityIndicator color={colors.bg} /> : <>
              <Ionicons name="log-in" size={18} color={colors.bg} />
              <Text style={styles.btnText}>Sign In</Text>
            </>}
          </TouchableOpacity>

          {/* Forgot password link */}
          <Link href="/auth/forgot-password" asChild>
            <TouchableOpacity testID="login-forgot" style={styles.forgotBtn}>
              <Ionicons name="key-outline" size={14} color={colors.cyan} />
              <Text style={styles.forgotText}>Forgot password?</Text>
            </TouchableOpacity>
          </Link>

          <View style={styles.linkRow}>
            <Text style={styles.linkLabel}>New here? </Text>
            <Link href="/auth/register" asChild>
              <TouchableOpacity testID="login-go-register">
                <Text style={styles.linkText}>Create an account</Text>
              </TouchableOpacity>
            </Link>
          </View>

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.divider} />
          </View>

          <TouchableOpacity
            testID="login-anon"
            onPress={async () => {
              try {
                await continueAnonymously();
                router.replace('/');
              } catch (e: any) {
                showAlert('Could not continue', String(e.message || e));
              }
            }}
            style={styles.anonBtn}
          >
            <Ionicons name="person-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.anonText}>Continue without signing in</Text>
          </TouchableOpacity>
          <Text style={styles.anonHint}>
            Progress is saved on this device only. Sign up later from Profile to back it up.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, justifyContent: 'center', flexGrow: 1 },
  brand: { alignItems: 'center', marginBottom: spacing.xl },
  logoBox: {
    width: 72, height: 72, borderRadius: 18,
    backgroundColor: colors.green + '22', borderWidth: 2, borderColor: colors.green,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  brandTitle: { color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: 4 },
  brandSub: { color: colors.textSecondary, fontSize: 13, marginTop: 6 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginTop: spacing.md, marginBottom: 6 },
  input: {
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: 14,
    color: colors.text, fontSize: 15,
  },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.green, paddingVertical: 16, borderRadius: radii.pill,
    marginTop: spacing.lg,
  },
  btnText: { color: colors.bg, fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
  linkRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  linkLabel: { color: colors.textMuted },
  linkText: { color: colors.cyan, fontWeight: '800' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg, marginBottom: spacing.md },
  divider: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  anonBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radii.pill,
    backgroundColor: colors.surfaceGlass, borderWidth: 1, borderColor: colors.border,
  },
  anonText: { color: colors.textSecondary, fontSize: 14, fontWeight: '800' },
  anonHint: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 16 },
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
  errorText: {
    color: colors.red,
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
    lineHeight: 18,
  },
  forgotBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    marginTop: spacing.sm,
  },
  forgotText: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
});
