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
 * players. The shield's color scheme upgrades automatically as the player
 * climbs the level ladder:
 *
 *   Lv 2-24   → BLUE body, blue rim, cyan glow                       (default)
 *   Lv 25-49  → BLUE body + GOLDEN outline + yellow halo
 *   Lv 50-99  → YELLOW body + light-blue outline
 *   Lv 100-124→ YELLOW body + YELLOW outline
 *   Lv 125-149→ shiny GOLDEN body + yellow halo background
 *   Lv 150-199→ GOLDEN body + GOLDEN outline (matched)
 *   Lv 200+   → GOLDEN body, BLACK outline, slightly bigger
 *
 * The geometric faceting + lightning-bolt position is identical across
 * every tier; only the color stops and stroke colors change.
 */

type Palette = {
  // 6 facet gradients (TL, TR, ML, MR, BL, BR) — three stops each.
  facets: { id: string; stops: [string, string, string] }[];
  // Outer rim stroke (3-stop vertical gradient)
  rim: [string, string, string];
  // Inner rim-light (single stroke color)
  innerRim: string;
  // Bevel ridges (subtle hairlines on facet edges)
  ridge: string;
  // Outer glow halo color (the soft blurred ring around the shield)
  glow: string;
  // Vertex specular dots — almost always white
  vertex: string;
  // Lightning bolt fill + stroke
  bolt: { fill: string; stroke: string; highlight: string };
};

// Six classic color stops per palette: light-edge → mid → dark
function makeFacets(prefix: string, c: [string, string, string, string, string, string, string]): Palette['facets'] {
  // c = [veryLight, light, mid-light, mid, mid-dark, dark, veryDark]
  const [vL, L, ml, m, md, d, vD] = c;
  return [
    { id: `${prefix}_TL`, stops: [vL, L, m] },
    { id: `${prefix}_TR`, stops: [L, ml, md] },
    { id: `${prefix}_ML`, stops: [ml, m, d] },
    { id: `${prefix}_MR`, stops: [d, m, ml] },
    { id: `${prefix}_BL`, stops: [vD, d, ml] },
    { id: `${prefix}_BR`, stops: [vD, m, ml] },
  ];
}

// Color palettes per tier --------------------------------------------------
const BLUE = makeFacets('B', [
  '#E0FAFF', '#67E8F9', '#22D3EE', '#0891B2', '#0EA5E9', '#0C4A6E', '#082F49',
]);
const YELLOW = makeFacets('Y', [
  '#FFFBEB', '#FEF08A', '#FDE047', '#EAB308', '#CA8A04', '#854D0E', '#451A03',
]);
const GOLD = makeFacets('G', [
  '#FFF7CC', '#FCE07A', '#F5B935', '#D97706', '#B45309', '#78350F', '#3F1F0A',
]);

const TIERS = {
  blue: {
    facets: BLUE,
    rim: ['#A5F3FC', '#22D3EE', '#0369A1'] as [string, string, string],
    innerRim: '#E0FAFF',
    ridge: '#67E8F9',
    glow: '#22D3EE',
    vertex: '#FFFFFF',
    bolt: { fill: '#22C55E', stroke: '#86EFAC', highlight: '#BBF7D0' },
  },
  blue_gold_glow: {
    facets: BLUE,
    rim: ['#FEF3C7', '#FBBF24', '#92400E'] as [string, string, string],
    innerRim: '#FFFBEB',
    ridge: '#67E8F9',
    glow: '#F59E0B',
    vertex: '#FFFFFF',
    bolt: { fill: '#22C55E', stroke: '#86EFAC', highlight: '#BBF7D0' },
  },
  yellow_blue_rim: {
    facets: YELLOW,
    rim: ['#A5F3FC', '#22D3EE', '#0369A1'] as [string, string, string],
    innerRim: '#FFFBEB',
    ridge: '#FDE68A',
    glow: '#22D3EE',
    vertex: '#FFFFFF',
    bolt: { fill: '#15803D', stroke: '#22C55E', highlight: '#86EFAC' },
  },
  yellow_yellow_rim: {
    facets: YELLOW,
    rim: ['#FEF3C7', '#FBBF24', '#92400E'] as [string, string, string],
    innerRim: '#FFFBEB',
    ridge: '#FDE68A',
    glow: '#F59E0B',
    vertex: '#FFFFFF',
    bolt: { fill: '#15803D', stroke: '#22C55E', highlight: '#86EFAC' },
  },
  gold_yellow_glow: {
    facets: GOLD,
    rim: ['#FEF3C7', '#FBBF24', '#92400E'] as [string, string, string],
    innerRim: '#FFFBEB',
    ridge: '#FDE68A',
    glow: '#FBBF24',
    vertex: '#FFFFFF',
    bolt: { fill: '#15803D', stroke: '#22C55E', highlight: '#BBF7D0' },
  },
  gold_gold: {
    facets: GOLD,
    rim: ['#FFF1B0', '#F5B935', '#78350F'] as [string, string, string],
    innerRim: '#FFF7CC',
    ridge: '#FCE07A',
    glow: '#D97706',
    vertex: '#FFFFFF',
    bolt: { fill: '#15803D', stroke: '#22C55E', highlight: '#BBF7D0' },
  },
  gold_black: {
    facets: GOLD,
    rim: ['#1F2937', '#000000', '#000000'] as [string, string, string],
    innerRim: '#FFF7CC',
    ridge: '#FCE07A',
    glow: '#D97706',
    vertex: '#FFFFFF',
    bolt: { fill: '#15803D', stroke: '#22C55E', highlight: '#BBF7D0' },
  },
  // Creator/Admin: Lv200 design but with bright YELLOW outline
  creator_yellow: {
    facets: GOLD,
    rim: ['#FFEB3B', '#FFD700', '#FBC02D'] as [string, string, string],
    innerRim: '#FFFDE7',
    ridge: '#FFEB3B',
    glow: '#FFD700',
    vertex: '#FFFFFF',
    bolt: { fill: '#15803D', stroke: '#22C55E', highlight: '#BBF7D0' },
  },
} satisfies Record<string, Palette>;

type TierKey = keyof typeof TIERS;

function pickTier(level: number): { tier: TierKey; sizeMul: number } {
  // Creator/Admin sentinel — backend sends level=999 when others view the admin
  if (level >= 999) return { tier: 'creator_yellow', sizeMul: 1.18 };
  if (level >= 200) return { tier: 'gold_black', sizeMul: 1.18 };
  if (level >= 150) return { tier: 'gold_gold', sizeMul: 1 };
  if (level >= 125) return { tier: 'gold_yellow_glow', sizeMul: 1 };
  if (level >= 100) return { tier: 'yellow_yellow_rim', sizeMul: 1 };
  if (level >= 50) return { tier: 'yellow_blue_rim', sizeMul: 1 };
  if (level >= 25) return { tier: 'blue_gold_glow', sizeMul: 1 };
  return { tier: 'blue', sizeMul: 1 };
}

// ── Geometry (shared across all tiers) ─────────────────────────────────────
const SHIELD_PATH =
  'M 50 8 L 14 18 L 14 50 C 14 76 30 92 50 102 C 70 92 86 76 86 50 L 86 18 L 50 8 Z';
const SHIELD_OUTLINE =
  'M 50 5 L 11 16 L 11 50 C 11 78 28 95 50 105 C 72 95 89 78 89 50 L 89 16 L 50 5 Z';
const SHIELD_INNER =
  'M 50 14 L 19 22 L 19 50 C 19 73 33 87 50 95 C 67 87 81 73 81 50 L 81 22 L 50 14 Z';
const BOLT_PATH =
  'M 64 58 L 53 76 L 60 76 L 56 92 L 70 70 L 62 70 L 67 58 Z';

// Each facet polygon
const FACET_PATHS: string[] = [
  'M 50 8 L 14 18 L 14 50 L 50 50 Z',     // TL
  'M 50 8 L 86 18 L 86 50 L 50 50 Z',     // TR
  'M 14 50 L 50 50 L 50 70 L 16 64 Z',    // ML
  'M 86 50 L 50 50 L 50 70 L 84 64 Z',    // MR
  'M 16 64 L 50 70 L 50 102 Z',           // BL
  'M 84 64 L 50 70 L 50 102 Z',           // BR
];

export default function PremiumShield({
  size = 88,
  level = 2,
}: {
  size?: number;
  level?: number;
}) {
  const { tier, sizeMul } = pickTier(level);
  const palette = TIERS[tier];

  const w = size * sizeMul;
  const h = (w * 110) / 100;

  return (
    <View style={{ width: w, height: h, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={w} height={h} viewBox="0 0 100 110">
        <Defs>
          {palette.facets.map((f, i) => {
            // Each facet uses a slightly different gradient orientation so
            // light appears to hit each face differently.
            const grad = GRAD_DIRS[i];
            return (
              <LinearGradient
                key={f.id}
                id={f.id}
                x1={grad.x1}
                y1={grad.y1}
                x2={grad.x2}
                y2={grad.y2}
              >
                <Stop offset="0%" stopColor={f.stops[0]} />
                <Stop offset="55%" stopColor={f.stops[1]} />
                <Stop offset="100%" stopColor={f.stops[2]} />
              </LinearGradient>
            );
          })}

          <LinearGradient id="rimEdge" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={palette.rim[0]} />
            <Stop offset="55%" stopColor={palette.rim[1]} />
            <Stop offset="100%" stopColor={palette.rim[2]} />
          </LinearGradient>

          <RadialGradient id="floorGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={palette.glow} stopOpacity="0.6" />
            <Stop offset="100%" stopColor={palette.glow} stopOpacity="0" />
          </RadialGradient>

          <Filter id="neonGlow" x="-30%" y="-30%" width="160%" height="160%">
            <FeGaussianBlur stdDeviation="3.5" result="blur" />
            <FeMerge>
              <FeMergeNode in="blur" />
              <FeMergeNode in="SourceGraphic" />
            </FeMerge>
          </Filter>

          <RadialGradient id="vertexGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={palette.vertex} stopOpacity="0.95" />
            <Stop offset="100%" stopColor={palette.vertex} stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* Floor reflection */}
        <Ellipse cx="50" cy="103" rx="32" ry="4" fill="url(#floorGlow)" />

        {/* Outer halo glow */}
        <G opacity={tier === 'gold_black' ? 0.85 : 0.6}>
          <Path
            d={SHIELD_OUTLINE}
            fill="none"
            stroke={palette.glow}
            strokeWidth={6}
            filter="url(#neonGlow)"
          />
        </G>

        {/* ── Faceted body ──────────────────────────────────────────── */}
        {FACET_PATHS.map((d, i) => (
          <Path key={i} d={d} fill={`url(#${palette.facets[i].id})`} />
        ))}

        {/* Bevel ridges */}
        <Path d="M 50 8 L 50 102" stroke={palette.ridge} strokeWidth={0.8} strokeOpacity={0.85} />
        <Path d="M 14 50 L 86 50" stroke={palette.ridge} strokeWidth={0.8} strokeOpacity={0.7} />
        <Path d="M 50 8 L 14 50" stroke={palette.ridge} strokeWidth={0.6} strokeOpacity={0.6} />
        <Path d="M 50 8 L 86 50" stroke={palette.ridge} strokeWidth={0.6} strokeOpacity={0.6} />
        <Path d="M 14 50 L 50 70" stroke={palette.ridge} strokeWidth={0.6} strokeOpacity={0.55} />
        <Path d="M 86 50 L 50 70" stroke={palette.ridge} strokeWidth={0.6} strokeOpacity={0.55} />
        <Path d="M 50 70 L 16 64" stroke={palette.ridge} strokeWidth={0.5} strokeOpacity={0.45} />
        <Path d="M 50 70 L 84 64" stroke={palette.ridge} strokeWidth={0.5} strokeOpacity={0.45} />

        {/* Outer rim */}
        <Path
          d={SHIELD_PATH}
          fill="none"
          stroke="url(#rimEdge)"
          strokeWidth={tier === 'gold_black' ? 3.2 : 2.6}
          strokeLinejoin="round"
        />

        {/* Inner rim-light */}
        <Path
          d={SHIELD_INNER}
          fill="none"
          stroke={palette.innerRim}
          strokeWidth={0.9}
          strokeOpacity={0.75}
          strokeLinejoin="round"
        />

        {/* Vertex specular dots */}
        <Ellipse cx="50" cy="11" rx="3.6" ry="2.2" fill="url(#vertexGlow)" />
        <Ellipse cx="16" cy="22" rx="2.6" ry="1.8" fill="url(#vertexGlow)" opacity={0.8} />
        <Ellipse cx="50" cy="50" rx="2.6" ry="1.8" fill="url(#vertexGlow)" opacity={0.6} />

        {/* Lightning bolt — bottom-right */}
        <G>
          <Path
            d={BOLT_PATH}
            fill={palette.bolt.fill}
            stroke={palette.bolt.stroke}
            strokeWidth={0.9}
            strokeLinejoin="round"
          />
          <Path d="M 60 64 L 56 76 L 60 76 Z" fill={palette.bolt.highlight} opacity={0.7} />
        </G>
      </Svg>
    </View>
  );
}

// Gradient direction per facet — keeps each face catching light differently
const GRAD_DIRS = [
  { x1: '0%', y1: '0%', x2: '100%', y2: '100%' }, // TL
  { x1: '100%', y1: '0%', x2: '0%', y2: '100%' }, // TR
  { x1: '0%', y1: '0%', x2: '100%', y2: '0%' },   // ML
  { x1: '100%', y1: '0%', x2: '0%', y2: '0%' },   // MR
  { x1: '0%', y1: '100%', x2: '50%', y2: '0%' },  // BL
  { x1: '100%', y1: '100%', x2: '50%', y2: '0%' },// BR
];
