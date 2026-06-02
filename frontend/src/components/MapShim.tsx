/**
 * @deprecated 2026-06-04 — Google Maps / react-native-maps were
 * replaced by <BTLeafletMap /> (WebView + Leaflet + OSM). This file
 * intentionally re-exports the Leaflet stack under the legacy names so
 * any straggling imports keep compiling, but new code should import
 * `BTLeafletMap` directly.
 *
 * The legacy <MapView>/<Marker>/<Circle> components from react-native-maps
 * are NOT available anymore — calling them throws so callers notice
 * during development. The `IS_WEB_PLACEHOLDER` flag is preserved so the
 * group-bury flow's old branch keeps working.
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
