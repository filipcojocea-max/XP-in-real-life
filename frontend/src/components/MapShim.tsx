/**
 * Platform shim for react-native-maps.
 *
 * react-native-maps relies on `codegenNativeComponent`, which is not
 * implemented on react-native-web, so importing it on the web preview
 * crashes the bundle with "(0, _reactNativeWebDistIndex.codegenNative
 * Component) is not a function". This file is the NATIVE variant — the
 * companion `MapShim.web.tsx` provides a safe placeholder for the web
 * Preview-in-Browser environment. Metro picks the right one based on the
 * platform extension at bundle time.
 */
import MapView, { Marker, Circle, Polygon } from 'react-native-maps';

export { MapView, Marker, Circle, Polygon };
export default MapView;
export const IS_WEB_PLACEHOLDER = false;
