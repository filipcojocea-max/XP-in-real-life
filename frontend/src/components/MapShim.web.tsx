/**
 * Web-only shim for react-native-maps.
 *
 * `react-native-maps` calls `codegenNativeComponent` which is NOT
 * implemented on react-native-web, so importing it on web crashes the
 * preview bundle. Metro picks this `.web.tsx` variant automatically when
 * bundling for the browser. The component renders a friendly placeholder
 * so the rest of the screen (hint card, settings, buttons) still works
 * during web preview / Storybook style testing.
 *
 * On real iOS/Android builds the sibling `MapShim.tsx` re-exports the
 * actual native components.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

const Placeholder: React.FC<AnyProps> = ({ children, ...rest }) => {
  // Pull commonly used style prop through so it sizes correctly
  const style = (rest as { style?: unknown }).style;
  return (
    <View style={[styles.fallback, style as object]}>
      <Text style={styles.kicker}>🗺️ MAP PREVIEW</Text>
      <Text style={styles.body}>
        Maps are disabled in the web preview.{'\n'}
        Open the app on iOS or Android to see the live chest map.
      </Text>
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
    gap: 8,
    minHeight: 200,
  },
  kicker: {
    color: '#FFC857',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  body: {
    color: '#9aa1a8',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
});
