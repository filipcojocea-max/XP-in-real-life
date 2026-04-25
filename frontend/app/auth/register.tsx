import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Link, router } from 'expo-router';
import { api } from '../../src/api';
import { colors, spacing, radii } from '../../src/theme';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!name.trim() || !email.trim() || !password) {
      Alert.alert('Please fill in all fields');
      return;
    }
    if (password.length < 5) {
      Alert.alert('Password must be at least 5 characters');
      return;
    }
    setLoading(true);
    try {
      const r = await api.authRegister(name.trim(), email.trim().toLowerCase(), password);
      router.push({
        pathname: '/auth/verify',
        params: { email: email.trim().toLowerCase(), dev_code: (r as any).dev_code || '' },
      });
    } catch (e: any) {
      Alert.alert('Registration failed', String(e.message || e));
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
            <Text style={styles.brandTitle}>CREATE ACCOUNT</Text>
            <Text style={styles.brandSub}>Start your hero journey.</Text>
          </View>

          <Text style={styles.label}>Full name</Text>
          <TextInput
            testID="reg-name"
            value={name}
            onChangeText={setName}
            placeholder="Your full name"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            style={styles.input}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="reg-email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            style={styles.input}
          />

          <Text style={styles.label}>Password (min 5 characters)</Text>
          <TextInput
            testID="reg-password"
            value={password}
            onChangeText={setPassword}
            placeholder="•••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            style={styles.input}
          />

          <TouchableOpacity testID="reg-submit" disabled={loading} onPress={submit} style={[styles.btn, loading && { opacity: 0.6 }]}>
            {loading ? <ActivityIndicator color={colors.bg} /> : <>
              <Ionicons name="person-add" size={18} color={colors.bg} />
              <Text style={styles.btnText}>Register</Text>
            </>}
          </TouchableOpacity>

          <View style={styles.linkRow}>
            <Text style={styles.linkLabel}>Already have an account? </Text>
            <Link href="/auth/login" asChild>
              <TouchableOpacity testID="reg-go-login">
                <Text style={styles.linkText}>Sign in</Text>
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
  scroll: { padding: spacing.lg, justifyContent: 'center', flexGrow: 1 },
  brand: { alignItems: 'center', marginBottom: spacing.lg },
  logoBox: {
    width: 72, height: 72, borderRadius: 18,
    backgroundColor: colors.green + '22', borderWidth: 2, borderColor: colors.green,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  brandTitle: { color: colors.text, fontSize: 20, fontWeight: '900', letterSpacing: 4 },
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
});
