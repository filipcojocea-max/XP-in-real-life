/**
 * @deprecated 2026-06-04 — see MapShim.tsx. The Leaflet WebView stack
 * runs identically on web (where `react-native-webview` falls back to
 * an iframe) so no special web variant is required anymore. We keep
 * this file purely to avoid metro confusion on resolution order.
 */
export { default as MapView } from './BTLeafletMap';
export { default } from './BTLeafletMap';
export const IS_WEB_PLACEHOLDER = false;

const _throw = (name: string) => () => {
  throw new Error(
    `MapShim.${name} is deprecated — use <BTLeafletMap /> instead.`,
  );
};
export const Marker = _throw('Marker');
export const Circle = _throw('Circle');
export const Polygon = _throw('Polygon');
