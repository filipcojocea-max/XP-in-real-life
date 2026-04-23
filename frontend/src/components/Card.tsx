import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { colors, radii, spacing } from '../theme';

export default function Card({
  children,
  style,
  accent,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  accent?: string;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        accent ? { borderColor: accent + '55' } : null,
        style,
      ]}
    >
      {accent ? <View style={[styles.accentBar, { backgroundColor: accent }]} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceGlass,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    overflow: 'hidden',
  },
  accentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    opacity: 0.9,
  },
});
