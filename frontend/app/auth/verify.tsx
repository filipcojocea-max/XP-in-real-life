import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { showAlert } from '../../src/uiAlert';
import { colors, spacing, radii } from '../../src/theme';

export default function Verify() {
  const { signIn } = useAuth();
  const params = useLocalSearchParams<{ email: string; dev_code?: string }>();
  const [code, setCode] = useState((params.dev_code as string) || '');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (params.dev_code) {
      setCode(String(params.dev_code));
    }
  }, [params.dev_code]);

  const submit = async () => {
    if (!code.trim() || code.trim().length !== 6) {
      showAlert('Enter the 6-digit code');
      return;
    }
    setLoading(true);
    try {
      const r = await api.authVerify(String(params.email), code.trim());
      await signIn(r.token, r.user);
      router.replace('/');
    } catch (e: any) {
      showAlert('Verification failed', String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      const r = await api.authResend(String(params.email));
      const dev = (r as any).dev_code;
      if (dev) setCode(dev);
      showAlert('Code resent', `Check your email${dev ? `.\n\nDev code: ${dev}` : ''}`);
    } catch (e: any) {
      showAlert('Could not resend', String(e.message || e));
    } finally {
      setResending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={styles.logoBox}>
              <Ionicons name="mail" size={36} color={colors.cyan} />
            </View>
            <Text style={styles.brandTitle}>VERIFY EMAIL</Text>
            <Text style={styles.brandSub}>We sent a 6-digit code to</Text>
            <Text style={styles.email}>{String(params.email || '')}</Text>
          </View>

          {params.dev_code ? (
            <View style={styles.devNote}>
              <Ionicons name="flash" size={14} color={colors.amber} />
              <Text style={styles.devNoteText}>
                Dev mode: code is <Text style={{ color: colors.amber, fontWeight: '900' }}>{String(params.dev_code)}</Text>
              </Text>
            </View>
          ) : null}

          <Text style={styles.label}>Verification code</Text>
          <TextInput
            testID="verify-code"
            value={code}
            onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="123456"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={6}
            style={styles.codeInput}
          />

          <TouchableOpacity testID="verify-submit" disabled={loading} onPress={submit} style={[styles.btn, loading && { opacity: 0.6 }]}>
            {loading ? <ActivityIndicator color={colors.bg} /> : <>
              <Ionicons name="checkmark-circle" size={18} color={colors.bg} />
              <Text style={styles.btnText}>Verify & Sign In</Text>
            </>}
          </TouchableOpacity>

          <TouchableOpacity testID="verify-resend" disabled={resending} onPress={resend} style={styles.resendBtn}>
            {resending ? <ActivityIndicator size="small" color={colors.cyan} /> : (
              <Text style={styles.resendText}>Resend code</Text>
            )}
          </TouchableOpacity>
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
    backgroundColor: colors.cyan + '22', borderWidth: 2, borderColor: colors.cyan,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  brandTitle: { color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: 4 },
  brandSub: { color: colors.textSecondary, fontSize: 13, marginTop: 6 },
  email: { color: colors.cyan, fontSize: 14, fontWeight: '700', marginTop: 4 },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginTop: spacing.md, marginBottom: 6 },
  codeInput: {
    backgroundColor: colors.surfaceGlass, borderWidth: 2, borderColor: colors.cyan + '88',
    borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: 18,
    color: colors.cyan, fontSize: 28, fontWeight: '900',
    textAlign: 'center', letterSpacing: 8,
  },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.green, paddingVertical: 16, borderRadius: radii.pill,
    marginTop: spacing.lg,
  },
  btnText: { color: colors.bg, fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
  resendBtn: { alignItems: 'center', paddingVertical: spacing.md },
  resendText: { color: colors.cyan, fontSize: 13, fontWeight: '800' },
  devNote: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.amber + '15', borderColor: colors.amber + '55', borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: radii.md,
    marginBottom: spacing.sm,
  },
  devNoteText: { color: colors.textSecondary, fontSize: 11, flex: 1 },
});
