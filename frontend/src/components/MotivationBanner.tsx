import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing } from '../theme';

type Props = {
  message: string;
  onPress?: () => void;
  testID?: string;
};

/**
 * Notification-style banner with a rotating half-green / half-cyan border.
 * The two colored halves travel in the SAME direction around the card,
 * positioned exactly opposite to each other.
 */
export default function MotivationBanner({ message, onPress, testID }: Props) {
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotate, {
        toValue: 1,
        duration: 4000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotate]);

  const spin = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <TouchableOpacity
      testID={testID}
      activeOpacity={0.9}
      onPress={onPress}
      style={styles.outer}
    >
      <View style={styles.clip}>
        {/* Rotating gradient wheel — half green, half cyan, same-direction spin */}
        <Animated.View style={[styles.wheel, { transform: [{ rotate: spin }] }]}>
          <LinearGradient
            colors={['#00FF88', '#00FF88', '#00D9FF', '#00D9FF', '#00FF88']}
            locations={[0, 0.5, 0.5, 1, 1]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>

      {/* Inner content card (masks all but a thin border of the rotating wheel) */}
      <View style={styles.inner}>
        <View style={styles.iconWrap}>
          <Ionicons name="flash" size={22} color={colors.amber} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>LevelUp · Motivation</Text>
          <Text style={styles.message} numberOfLines={2}>{message}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

const BORDER = 2;
const styles = StyleSheet.create({
  outer: {
    borderRadius: radii.md,
    padding: BORDER,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  clip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  wheel: {
    position: 'absolute',
    // Make wheel big enough that every corner of the rect is covered during rotation.
    // sqrt(2) * max(side) ~ 1.5x
    top: '-75%',
    left: '-75%',
    width: '250%',
    height: '250%',
  },
  inner: {
    backgroundColor: colors.surface,
    borderRadius: radii.md - BORDER,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.amber + '22',
    borderWidth: 1,
    borderColor: colors.amber + '55',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: colors.textMuted, fontSize: 10, letterSpacing: 1.5, fontWeight: '800', textTransform: 'uppercase' },
  message: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 2, lineHeight: 19 },
});
