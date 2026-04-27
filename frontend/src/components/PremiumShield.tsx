import React from 'react';
import { View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
  Path,
  G,
  Filter,
  FeGaussianBlur,
  FeMerge,
  FeMergeNode,
  Ellipse,
} from 'react-native-svg';

/**
 * Premium "3D glass" shield used as the hero emblem for Level 2+ players.
 * Built on react-native-svg so it scales crisply and looks identical on
 * iOS / Android / web. Themed in app cyan/blue with neon edges, an inner
 * glass highlight, and a subtle floor reflection to feel three-dimensional.
 */
export default function PremiumShield({ size = 88 }: { size?: number }) {
  // Render in a 100x110 viewBox; the path below fits inside it.
  const w = size;
  const h = (size * 110) / 100;

  return (
    <View style={{ width: w, height: h, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={w} height={h} viewBox="0 0 100 110">
        <Defs>
          {/* Body fill — radial cyan→blue glass gradient */}
          <RadialGradient id="shieldBody" cx="40%" cy="30%" r="80%">
            <Stop offset="0%" stopColor="#7CF0FF" stopOpacity="1" />
            <Stop offset="45%" stopColor="#22D3EE" stopOpacity="1" />
            <Stop offset="80%" stopColor="#0EA5E9" stopOpacity="1" />
            <Stop offset="100%" stopColor="#1E3A8A" stopOpacity="1" />
          </RadialGradient>

          {/* Outer neon stroke — lighter at top */}
          <LinearGradient id="shieldEdge" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#A5F3FC" stopOpacity="1" />
            <Stop offset="50%" stopColor="#22D3EE" stopOpacity="1" />
            <Stop offset="100%" stopColor="#0369A1" stopOpacity="1" />
          </LinearGradient>

          {/* Top glass highlight */}
          <LinearGradient id="glassHi" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.85" />
            <Stop offset="60%" stopColor="#FFFFFF" stopOpacity="0.15" />
            <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </LinearGradient>

          {/* Inner depth shading (gives the 3D feel) */}
          <LinearGradient id="shieldDepth" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.18" />
            <Stop offset="100%" stopColor="#000000" stopOpacity="0.35" />
          </LinearGradient>

          {/* Floor / reflection */}
          <RadialGradient id="floorGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#22D3EE" stopOpacity="0.55" />
            <Stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </RadialGradient>

          {/* Soft outer glow filter */}
          <Filter id="neonGlow" x="-30%" y="-30%" width="160%" height="160%">
            <FeGaussianBlur stdDeviation="3" result="blur" />
            <FeMerge>
              <FeMergeNode in="blur" />
              <FeMergeNode in="SourceGraphic" />
            </FeMerge>
          </Filter>
        </Defs>

        {/* Floor reflection ellipse */}
        <Ellipse cx="50" cy="100" rx="34" ry="5" fill="url(#floorGlow)" />

        {/* Outer neon glow shield (slightly larger, blurred) */}
        <G opacity="0.55">
          <Path
            d={SHIELD_OUTER}
            fill="none"
            stroke="#22D3EE"
            strokeWidth={6}
            filter="url(#neonGlow)"
          />
        </G>

        {/* Main shield body */}
        <Path
          d={SHIELD_PATH}
          fill="url(#shieldBody)"
          stroke="url(#shieldEdge)"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Inner depth overlay (top-left light, bottom-right shadow) */}
        <Path
          d={SHIELD_PATH}
          fill="url(#shieldDepth)"
          opacity={0.9}
        />

        {/* Top glass highlight — only the upper half */}
        <Path d={SHIELD_HIGHLIGHT} fill="url(#glassHi)" />

        {/* Inner stroke for extra "rim light" glow */}
        <Path
          d={SHIELD_INNER}
          fill="none"
          stroke="#A5F3FC"
          strokeWidth={1.2}
          strokeOpacity={0.8}
          strokeLinejoin="round"
        />

        {/* Lightning bolt accent (green) — keeps brand continuity with the
            old shield that had a green flash */}
        <Path
          d="M 53 38 L 41 60 L 50 60 L 46 78 L 60 54 L 51 54 L 55 38 Z"
          fill="#22C55E"
          stroke="#86EFAC"
          strokeWidth={1}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

// Shield path — heart-style classic shield with a slightly pointed bottom.
// Designed inside a 100×110 viewBox.
const SHIELD_PATH =
  'M 50 8 L 14 18 L 14 50 C 14 76 30 92 50 102 C 70 92 86 76 86 50 L 86 18 L 50 8 Z';

// Outer "halo" shield, ~3px larger on each side for the neon glow rim
const SHIELD_OUTER =
  'M 50 5 L 11 16 L 11 50 C 11 78 28 95 50 105 C 72 95 89 78 89 50 L 89 16 L 50 5 Z';

// Inner stroke shield, 4px inset to add a second rim-light line
const SHIELD_INNER =
  'M 50 14 L 19 22 L 19 50 C 19 73 33 87 50 95 C 67 87 81 73 81 50 L 81 22 L 50 14 Z';

// Top glass highlight — covers roughly the upper third of the shield
const SHIELD_HIGHLIGHT =
  'M 50 11 L 17 20 L 17 42 C 28 36 40 33 50 33 C 60 33 72 36 83 42 L 83 20 L 50 11 Z';
