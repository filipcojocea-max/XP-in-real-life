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
 * Premium "3D faceted glass" shield used as the hero emblem for Level 2+
 * players. Built on react-native-svg. Six facets (top-left, top-right,
 * mid-left, mid-right, bottom-left, bottom-right) are rendered with
 * different gradient angles so each face catches light differently —
 * this gives the shield a crystalline, gem-like feel without needing
 * actual 3D rendering. The outer rim glows neon cyan; the lightning
 * bolt sits in the lower-right area of the shield as the user requested.
 */
export default function PremiumShield({ size = 88 }: { size?: number }) {
  const w = size;
  const h = (size * 110) / 100;

  return (
    <View style={{ width: w, height: h, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={w} height={h} viewBox="0 0 100 110">
        <Defs>
          {/* Per-facet gradients — each is angled to simulate a different
              face of light. Lighter near the highlight side, darker on the
              opposite side. */}
          <LinearGradient id="facetTL" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#E0FAFF" />
            <Stop offset="55%" stopColor="#67E8F9" />
            <Stop offset="100%" stopColor="#0891B2" />
          </LinearGradient>
          <LinearGradient id="facetTR" x1="100%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#7DD3FC" />
            <Stop offset="60%" stopColor="#22D3EE" />
            <Stop offset="100%" stopColor="#0E7490" />
          </LinearGradient>
          <LinearGradient id="facetML" x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor="#22D3EE" />
            <Stop offset="100%" stopColor="#0EA5E9" />
          </LinearGradient>
          <LinearGradient id="facetMR" x1="100%" y1="0%" x2="0%" y2="0%">
            <Stop offset="0%" stopColor="#0369A1" />
            <Stop offset="100%" stopColor="#22D3EE" />
          </LinearGradient>
          <LinearGradient id="facetBL" x1="0%" y1="100%" x2="50%" y2="0%">
            <Stop offset="0%" stopColor="#0C4A6E" />
            <Stop offset="100%" stopColor="#0EA5E9" />
          </LinearGradient>
          <LinearGradient id="facetBR" x1="100%" y1="100%" x2="50%" y2="0%">
            <Stop offset="0%" stopColor="#082F49" />
            <Stop offset="100%" stopColor="#0EA5E9" />
          </LinearGradient>

          {/* Bright outer rim (neon edge) */}
          <LinearGradient id="rimEdge" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#A5F3FC" />
            <Stop offset="55%" stopColor="#22D3EE" />
            <Stop offset="100%" stopColor="#0369A1" />
          </LinearGradient>

          {/* Floor reflection */}
          <RadialGradient id="floorGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#22D3EE" stopOpacity="0.6" />
            <Stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </RadialGradient>

          {/* Soft outer neon glow */}
          <Filter id="neonGlow" x="-30%" y="-30%" width="160%" height="160%">
            <FeGaussianBlur stdDeviation="3.5" result="blur" />
            <FeMerge>
              <FeMergeNode in="blur" />
              <FeMergeNode in="SourceGraphic" />
            </FeMerge>
          </Filter>

          {/* Vertex / point highlight */}
          <RadialGradient id="vertexGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
            <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* Floor reflection */}
        <Ellipse cx="50" cy="103" rx="32" ry="4" fill="url(#floorGlow)" />

        {/* Outer neon glow halo */}
        <G opacity="0.6">
          <Path
            d={SHIELD_OUTLINE}
            fill="none"
            stroke="#22D3EE"
            strokeWidth={6}
            filter="url(#neonGlow)"
          />
        </G>

        {/* ── Faceted body ──────────────────────────────────────────── */}
        {/* Each facet is a polygon meeting at the central vertical "spine"
            line + a horizontal "belt" line, plus the bottom apex. This
            creates a 6-facet crystal feel. */}
        {/* Top-left facet */}
        <Path d="M 50 8 L 14 18 L 14 50 L 50 50 Z" fill="url(#facetTL)" />
        {/* Top-right facet */}
        <Path d="M 50 8 L 86 18 L 86 50 L 50 50 Z" fill="url(#facetTR)" />
        {/* Mid-left facet (smaller belt around mid-shield) */}
        <Path d="M 14 50 L 50 50 L 50 70 L 16 64 Z" fill="url(#facetML)" />
        {/* Mid-right facet */}
        <Path d="M 86 50 L 50 50 L 50 70 L 84 64 Z" fill="url(#facetMR)" />
        {/* Bottom-left facet */}
        <Path d="M 16 64 L 50 70 L 50 102 Z" fill="url(#facetBL)" />
        {/* Bottom-right facet */}
        <Path d="M 84 64 L 50 70 L 50 102 Z" fill="url(#facetBR)" />

        {/* Bevel ridges — bright thin lines along the inner facet edges
            (running from the apex/corners to the centre) for the prismatic
            "cut crystal" effect */}
        <Path d="M 50 8 L 50 102" stroke="#A5F3FC" strokeWidth={0.8} strokeOpacity={0.85} />
        <Path d="M 14 50 L 86 50" stroke="#A5F3FC" strokeWidth={0.8} strokeOpacity={0.7} />
        <Path d="M 50 8 L 14 50" stroke="#67E8F9" strokeWidth={0.6} strokeOpacity={0.6} />
        <Path d="M 50 8 L 86 50" stroke="#67E8F9" strokeWidth={0.6} strokeOpacity={0.6} />
        <Path d="M 14 50 L 50 70" stroke="#67E8F9" strokeWidth={0.6} strokeOpacity={0.55} />
        <Path d="M 86 50 L 50 70" stroke="#67E8F9" strokeWidth={0.6} strokeOpacity={0.55} />
        <Path d="M 50 70 L 16 64" stroke="#67E8F9" strokeWidth={0.5} strokeOpacity={0.45} />
        <Path d="M 50 70 L 84 64" stroke="#67E8F9" strokeWidth={0.5} strokeOpacity={0.45} />

        {/* Outer rim — thick gradient stroke */}
        <Path
          d={SHIELD_PATH}
          fill="none"
          stroke="url(#rimEdge)"
          strokeWidth={2.6}
          strokeLinejoin="round"
        />

        {/* Inner thin rim-light (gives a second specular ring) */}
        <Path
          d={SHIELD_INNER}
          fill="none"
          stroke="#E0FAFF"
          strokeWidth={0.9}
          strokeOpacity={0.75}
          strokeLinejoin="round"
        />

        {/* Vertex specular dots — small bright spots at corner points */}
        <Ellipse cx="50" cy="11" rx="3.6" ry="2.2" fill="url(#vertexGlow)" />
        <Ellipse cx="16" cy="22" rx="2.6" ry="1.8" fill="url(#vertexGlow)" opacity={0.8} />
        <Ellipse cx="50" cy="50" rx="2.6" ry="1.8" fill="url(#vertexGlow)" opacity={0.6} />

        {/* ── Lightning bolt — anchored bottom-right ──────────────────
            Positioned in the lower-right facet so it reads as "energy
            flowing down the shield" rather than a centered emblem. */}
        <G>
          <Path
            d={BOLT_PATH}
            fill="#22C55E"
            stroke="#86EFAC"
            strokeWidth={0.9}
            strokeLinejoin="round"
          />
          {/* Bolt highlight stripe */}
          <Path
            d="M 60 64 L 56 76 L 60 76 Z"
            fill="#BBF7D0"
            opacity={0.7}
          />
        </G>
      </Svg>
    </View>
  );
}

// Outer shield path (used for stroke / glow)
const SHIELD_PATH =
  'M 50 8 L 14 18 L 14 50 C 14 76 30 92 50 102 C 70 92 86 76 86 50 L 86 18 L 50 8 Z';

// Slightly larger version for the outer glow halo
const SHIELD_OUTLINE =
  'M 50 5 L 11 16 L 11 50 C 11 78 28 95 50 105 C 72 95 89 78 89 50 L 89 16 L 50 5 Z';

// 4px-inset shield used for the inner specular rim
const SHIELD_INNER =
  'M 50 14 L 19 22 L 19 50 C 19 73 33 87 50 95 C 67 87 81 73 81 50 L 81 22 L 50 14 Z';

// Lightning bolt path — anchored to the lower-right facet of the shield.
// Top of bolt sits around y=58 (just above the belt), tip is at y=92
// (near the bottom apex), and it leans slightly to the right of centre.
const BOLT_PATH =
  'M 64 58 L 53 76 L 60 76 L 56 92 L 70 70 L 62 70 L 67 58 Z';
