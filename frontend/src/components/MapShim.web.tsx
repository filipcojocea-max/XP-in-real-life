/**
 * Web-only shim for react-native-maps.
 *
 * `react-native-maps` calls `codegenNativeComponent` which is NOT
 * implemented on react-native-web, so importing it on web crashes the
 * preview bundle. Metro picks this `.web.tsx` variant automatically when
 * bundling for the browser. The component renders a friendly placeholder
 * — including a faint Australia silhouette as a hint that the live map
 * only renders on mobile — so the rest of the screen (hint card,
 * settings, buttons) still works during web preview / Storybook style
 * testing.
 *
 * On real iOS/Android builds the sibling `MapShim.tsx` re-exports the
 * actual native components.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

// Highly-simplified Australia mainland + Tasmania outline. Used purely
// decoratively so the placeholder doesn't look like an empty broken
// page — we render it at ~12 % opacity so it sits behind the message
// without competing for attention.
const AUS_PATH =
  'M120,205 ' +
  'C 130,178 165,158 200,160 ' +
  'C 215,145 245,138 270,148 ' +
  'C 295,138 330,150 345,170 ' +
  'C 370,170 405,160 430,170 ' +
  'C 458,175 490,200 498,232 ' +
  'C 510,260 502,290 480,308 ' +
  'C 470,330 445,348 420,355 ' +
  'C 390,365 355,360 332,348 ' +
  'C 310,360 280,365 252,360 ' +
  'C 220,358 192,350 168,330 ' +
  'C 140,320 118,295 112,265 ' +
  'C 105,240 110,220 120,205 Z ' +
  // Tasmania
  'M 360,398 C 372,388 388,388 398,396 C 406,408 402,422 388,428 C 372,432 358,420 360,398 Z';

const AusSilhouette: React.FC = () => (
  <View pointerEvents="none" style={styles.svgWrap}>
    <Svg viewBox="0 0 600 440" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <Path d={AUS_PATH} fill="#9aa1a8" opacity={0.12} />
    </Svg>
  </View>
);

const Placeholder: React.FC<AnyProps> = ({ children, ...rest }) => {
  // Pull commonly used style prop through so it sizes correctly
  const style = (rest as { style?: unknown }).style;
  return (
    <View style={[styles.fallback, style as object]}>
      <AusSilhouette />
      <View style={styles.copy}>
        <Text style={styles.kicker}>🗺️ MAP PREVIEW</Text>
        <Text style={styles.title}>Open on iOS / Android device</Text>
        <Text style={styles.body}>
          Maps are disabled in the web preview.{'\n'}
          Open the app on iOS or Android to see the live chest map.
        </Text>
      </View>
      {children}
    </View>
  );
};

// The MapView placeholder also accepts children (Markers / Circles etc.)
// We render them invisibly so children-only code paths don't crash.
const InvisibleChild: React.FC<AnyProps> = () => null;

export const MapView = Placeholder;
export const Marker = InvisibleChild;
export const Circle = InvisibleChild;
export const Polygon = InvisibleChild;
export default MapView;
export const IS_WEB_PLACEHOLDER = true;

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    backgroundColor: '#101418',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    minHeight: 220,
    overflow: 'hidden',
  },
  // The Australia silhouette sits absolutely behind the message and
  // never blocks any interaction.
  svgWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { alignItems: 'center', gap: 6 },
  kicker: {
    color: '#FFC857',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  title: {
    color: '#e5e7eb',
    fontSize: 14,
    fontWeight: '800',
  },
  body: {
    color: '#9aa1a8',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 320,
  },
});
