/**
 * <BTLeafletMap /> — WebView-hosted Leaflet + OpenStreetMap.
 *
 * 2026-06-04 — replaces our previous react-native-maps / Google Maps
 * stack. Google Maps proved unreliable on the user's Android devices
 * for weeks, so per direct product request we switched to a pure
 * Leaflet + OSM tile stack rendered inside a `react-native-webview`.
 * No API keys, no billing, identical UX on iOS and Android.
 *
 * Two usage modes:
 *
 *   • `mode="picker"` (default for BTMapPicker)
 *       Interactive — the marker is draggable, taps on the map
 *       relocate the marker, and the parent receives `onCenterChange`
 *       events. The parent also drives the radius via the imperative
 *       `setRadius()` handle so the slider stays in RN.
 *
 *   • `mode="static"`
 *       Read-only — no marker drag, no tap handling. Used by the
 *       group-bury flow to show a small preview of the chest spot.
 *
 * Capture: the parent can call `requestSnapshot()` on the ref to grab
 * a JPEG base64 of the current map (via html2canvas inside the
 * WebView). OSM tiles are loaded with `crossOrigin="anonymous"` so the
 * canvas isn't tainted.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { colors } from '../theme';

export type LatLng = { lat: number; lng: number };

export type BTLeafletMapHandle = {
  /** Recenter the map (and the marker) to the given lat/lng. Optional zoom. */
  setCenter: (lat: number, lng: number, zoom?: number) => void;
  /** Update the radius ring (metres) without changing the centre. */
  setRadius: (radiusM: number) => void;
  /** Update / hide the live user-location blue dot. Pass null to hide. */
  setUserLocation: (lat: number | null, lng?: number | null) => void;
  /** Flip drag/pan interactivity. Used by Expand/Minimize on the
   *  hunt screen — pinch-zoom and the +/- buttons stay enabled in
   *  both modes. */
  setInteractive: (on: boolean) => void;
  /** Tell Leaflet the WebView changed size (e.g. modal open). */
  invalidateSize: () => void;
  /**
   * Capture the current map as a JPEG base64 string. Resolves when the
   * WebView reports back. Returns the raw base64 (no `data:` prefix).
   * Throws if the WebView is gone or capture fails.
   */
  requestSnapshot: () => Promise<string>;
};

type Props = {
  mode?: 'picker' | 'static';
  /** Initial centre. Defaults to Australia centroid (-25.27, 133.78) — per
   *  product spec the picker should open on Australia and let users pan
   *  anywhere from there. */
  initialLat?: number;
  initialLng?: number;
  initialZoom?: number;
  /** Initial radius circle in metres. 0 hides the ring. */
  initialRadius?: number;
  ringColor?: string;
  markerColor?: string;
  /** 'dot' = filled coloured circle (default). 'x' = red treasure cross. */
  markerShape?: 'dot' | 'x';
  /** When false the map shows tiles + markers but doesn't react to drag /
   *  tap. Zoom buttons and pinch-zoom remain enabled. */
  interactive?: boolean;
  onCenterChange?: (c: LatLng) => void;
  onReady?: () => void;
  style?: ViewStyle | ViewStyle[];
};

// Australia centroid — used as the default opening view per spec.
const AUS_CENTER = { lat: -25.2744, lng: 133.7751, zoom: 4 };

// Build the inline HTML once. We embed all parameters via a JSON
// initial-state object so React re-renders don't reload the WebView.
const buildHtml = (initial: {
  lat: number;
  lng: number;
  zoom: number;
  radius: number;
  mode: 'picker' | 'static';
  ring: string;
  marker: string;
  markerShape: 'dot' | 'x';
  interactive: boolean;
}) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #1a1d22; }
  .leaflet-container { background: #1a1d22; outline: none; }
  .leaflet-control-attribution { font-size: 9px; background: rgba(20,22,26,.7); color: #9aa1a8; }
  .leaflet-control-attribution a { color: #22D3EE; }
  /* Subtle dark filter on tiles so the map matches the rest of the app's
     dark theme without needing a paid dark tile provider. */
  .leaflet-tile-pane { filter: brightness(0.78) contrast(1.05) saturate(0.85); }
  /* Zoom buttons — slightly bigger touch target so they're tappable on
     phones inside a non-fullscreen embed. */
  .leaflet-control-zoom a {
    width: 32px; height: 32px; line-height: 32px;
    font-size: 18px; font-weight: 900;
  }
  /* Pulsing blue "you are here" dot. Standard Apple-style accuracy halo. */
  .bt-userdot {
    width: 18px; height: 18px; border-radius: 9px;
    background: #2196F3; border: 3px solid #fff;
    box-shadow: 0 0 0 6px rgba(33,150,243,0.28), 0 2px 6px rgba(0,0,0,.5);
  }
  /* Red "X" marker for treasure burial spots. */
  .bt-x {
    position: relative; width: 22px; height: 22px;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6));
  }
  .bt-x::before, .bt-x::after {
    content: ''; position: absolute; left: 9px; top: -1px;
    width: 4px; height: 24px; background: #EF4444; border-radius: 2px;
    border: 1px solid #fff;
  }
  .bt-x::before { transform: rotate(45deg); }
  .bt-x::after  { transform: rotate(-45deg); }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script>
(function() {
  var INITIAL = ${JSON.stringify(initial)};
  var send = function(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };

  try {
    // 2026-06-04: even in "static" mode we KEEP zoomControl + scroll
    // wheel zoom enabled so the +/- buttons in the corner work. We
    // only suppress map drag and tap-to-set-pin until the parent flips
    // interactivity on (Expand button on the solo screen, etc.).
    var map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      tap: true,
      zoomSnap: 0.25,
      dragging: INITIAL.interactive,
      doubleClickZoom: true,
      scrollWheelZoom: true,
      boxZoom: false,
      keyboard: false,
      // Touch pinch zoom is the most-requested control even in static
      // mode (per user feedback), so it stays on regardless.
      touchZoom: true,
    }).setView([INITIAL.lat, INITIAL.lng], INITIAL.zoom);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
      crossOrigin: 'anonymous',
    }).addTo(map);

    // ── Treasure / picker marker ────────────────────────────────────
    var iconHtml;
    var iconSize = [18, 18];
    var iconAnchor = [9, 9];
    if (INITIAL.markerShape === 'x') {
      iconHtml = '<div class="bt-x"></div>';
      iconSize = [22, 22];
      iconAnchor = [11, 11];
    } else {
      iconHtml = '<div style="width:18px;height:18px;border-radius:9px;background:' + INITIAL.marker + ';border:3px solid #fff;box-shadow:0 0 0 2px ' + INITIAL.marker + '88,0 2px 6px rgba(0,0,0,.5);"></div>';
    }
    var pinIcon = L.divIcon({
      className: 'bt-pin',
      html: iconHtml,
      iconSize: iconSize,
      iconAnchor: iconAnchor,
    });

    var draggable = (INITIAL.mode === 'picker') && INITIAL.interactive;
    var marker = L.marker([INITIAL.lat, INITIAL.lng], { draggable: draggable, icon: pinIcon, keyboard: false }).addTo(map);

    var circle = null;
    if (INITIAL.radius > 0) {
      circle = L.circle([INITIAL.lat, INITIAL.lng], {
        radius: INITIAL.radius,
        color: INITIAL.ring,
        weight: 2,
        fillColor: INITIAL.ring,
        fillOpacity: 0.18,
        interactive: false,
      }).addTo(map);
    }

    // ── Live "you are here" user dot (added on demand by RN) ────────
    var userIcon = L.divIcon({
      className: 'bt-userwrap',
      html: '<div class="bt-userdot"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    var userMarker = null;
    window.__btSetUserLocation = function(lat, lng) {
      if (lat == null || lng == null) {
        if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
        return;
      }
      if (!userMarker) {
        userMarker = L.marker([lat, lng], { icon: userIcon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
      } else {
        userMarker.setLatLng([lat, lng]);
      }
    };

    var setCenter = function(lat, lng) {
      marker.setLatLng([lat, lng]);
      if (circle) circle.setLatLng([lat, lng]);
    };

    marker.on('dragend', function() {
      var ll = marker.getLatLng();
      setCenter(ll.lat, ll.lng);
      send({ type: 'center', lat: ll.lat, lng: ll.lng });
    });

    var clickHandler = function(e) {
      if (INITIAL.mode !== 'picker') return;
      setCenter(e.latlng.lat, e.latlng.lng);
      send({ type: 'center', lat: e.latlng.lat, lng: e.latlng.lng });
    };
    map.on('click', clickHandler);

    // ── RN-driven imperatives ───────────────────────────────────────
    window.__btSetCenter = function(lat, lng, zoom) {
      setCenter(lat, lng);
      if (zoom && zoom > 0) {
        map.setView([lat, lng], zoom, { animate: true });
      } else {
        map.panTo([lat, lng], { animate: true });
      }
    };
    window.__btSetRadius = function(r) {
      if (!circle) {
        circle = L.circle(marker.getLatLng(), {
          radius: r,
          color: INITIAL.ring,
          weight: 2,
          fillColor: INITIAL.ring,
          fillOpacity: 0.18,
          interactive: false,
        }).addTo(map);
      } else {
        circle.setRadius(r);
      }
    };
    // Flip interactivity on/off — used by the Expand/Minimize feature
    // so the static map clue can become fully pannable in the modal.
    window.__btSetInteractive = function(on) {
      if (on) {
        map.dragging.enable();
        if (marker && INITIAL.mode === 'picker') marker.dragging && marker.dragging.enable();
      } else {
        map.dragging.disable();
        if (marker && marker.dragging) marker.dragging.disable();
      }
      // Force Leaflet to recompute sizes after a layout swap (e.g.
      // entering or leaving the full-screen modal).
      setTimeout(function() { map.invalidateSize(); }, 50);
    };
    // RN calls this after the WebView resizes (modal toggle, rotate).
    window.__btInvalidateSize = function() {
      try { map.invalidateSize(); } catch (e) {}
    };
    // html2canvas-based snapshot. The reqId lets the RN side correlate
    // the response when multiple captures are queued.
    window.__btCapture = function(reqId) {
      try {
        if (!window.html2canvas) {
          send({ type: 'snapshot', reqId: reqId, error: 'html2canvas unavailable' });
          return;
        }
        html2canvas(document.getElementById('map'), {
          useCORS: true,
          allowTaint: false,
          backgroundColor: '#1a1d22',
          logging: false,
        }).then(function(canvas) {
          try {
            var dataUrl = canvas.toDataURL('image/jpeg', 0.55);
            // Strip the data: prefix so the backend receives raw b64.
            var b64 = (dataUrl.split(',')[1]) || '';
            send({ type: 'snapshot', reqId: reqId, b64: b64 });
          } catch (err) {
            send({ type: 'snapshot', reqId: reqId, error: String(err) });
          }
        }).catch(function(err) {
          send({ type: 'snapshot', reqId: reqId, error: String(err) });
        });
      } catch (err) {
        send({ type: 'snapshot', reqId: reqId, error: String(err) });
      }
    };

    send({ type: 'ready' });
  } catch (err) {
    send({ type: 'error', message: String(err && err.message || err) });
  }
})();
</script>
</body>
</html>`;

const BTLeafletMap = forwardRef<BTLeafletMapHandle, Props>(function BTLeafletMap(
  {
    mode = 'picker',
    initialLat,
    initialLng,
    initialZoom,
    initialRadius = 800,
    ringColor = '#22D3EE',
    markerColor = '#22D3EE',
    markerShape = 'dot',
    interactive = true,
    onCenterChange,
    onReady,
    style,
  },
  ref,
) {
  const webRef = useRef<WebView | null>(null);
  const [loading, setLoading] = useState(true);
  // We freeze the HTML on mount so prop changes don't trigger a reload
  // (Leaflet is expensive to spin up). All mutations after mount flow
  // through injectJavaScript.
  const html = useMemo(() => {
    const lat = typeof initialLat === 'number' ? initialLat : AUS_CENTER.lat;
    const lng = typeof initialLng === 'number' ? initialLng : AUS_CENTER.lng;
    const zoom = typeof initialZoom === 'number'
      ? initialZoom
      : (typeof initialLat === 'number' ? 14 : AUS_CENTER.zoom);
    return buildHtml({
      lat,
      lng,
      zoom,
      radius: initialRadius,
      mode,
      ring: ringColor,
      marker: markerColor,
      markerShape: (markerShape || 'dot'),
      interactive: interactive !== false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snapshot reply registry — keyed by request id so concurrent
  // captures from re-renders don't cross wires.
  const snapshotPromises = useRef<Record<
    string,
    { resolve: (s: string) => void; reject: (e: Error) => void }
  >>({});

  useImperativeHandle(ref, () => ({
    setCenter: (lat, lng, zoom) => {
      webRef.current?.injectJavaScript(
        `window.__btSetCenter && window.__btSetCenter(${lat}, ${lng}, ${zoom ?? 0}); true;`,
      );
    },
    setRadius: (r) => {
      webRef.current?.injectJavaScript(
        `window.__btSetRadius && window.__btSetRadius(${Math.max(1, Math.round(r))}); true;`,
      );
    },
    setUserLocation: (lat, lng) => {
      const lat_n = (lat == null) ? 'null' : String(lat);
      const lng_n = (lng == null) ? 'null' : String(lng);
      webRef.current?.injectJavaScript(
        `window.__btSetUserLocation && window.__btSetUserLocation(${lat_n}, ${lng_n}); true;`,
      );
    },
    setInteractive: (on) => {
      webRef.current?.injectJavaScript(
        `window.__btSetInteractive && window.__btSetInteractive(${on ? 'true' : 'false'}); true;`,
      );
    },
    invalidateSize: () => {
      webRef.current?.injectJavaScript(
        `window.__btInvalidateSize && window.__btInvalidateSize(); true;`,
      );
    },
    requestSnapshot: () =>
      new Promise<string>((resolve, reject) => {
        const reqId = 'snap_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        snapshotPromises.current[reqId] = { resolve, reject };
        // 8s safety timeout — html2canvas on slow devices can stall.
        const t = setTimeout(() => {
          if (snapshotPromises.current[reqId]) {
            delete snapshotPromises.current[reqId];
            reject(new Error('Snapshot timed out'));
          }
        }, 8000);
        const wrappedResolve = (s: string) => { clearTimeout(t); resolve(s); };
        const wrappedReject = (e: Error) => { clearTimeout(t); reject(e); };
        snapshotPromises.current[reqId] = { resolve: wrappedResolve, reject: wrappedReject };
        webRef.current?.injectJavaScript(
          `window.__btCapture && window.__btCapture(${JSON.stringify(reqId)}); true;`,
        );
      }),
  }), []);

  const handleMessage = useCallback((evt: WebViewMessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(evt.nativeEvent.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      setLoading(false);
      onReady?.();
      return;
    }
    if (msg.type === 'center' && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
      onCenterChange?.({ lat: msg.lat, lng: msg.lng });
      return;
    }
    if (msg.type === 'snapshot' && msg.reqId) {
      const pending = snapshotPromises.current[msg.reqId];
      if (!pending) return;
      delete snapshotPromises.current[msg.reqId];
      if (msg.error) pending.reject(new Error(String(msg.error)));
      else if (msg.b64) pending.resolve(String(msg.b64));
      else pending.reject(new Error('Empty snapshot'));
      return;
    }
  }, [onCenterChange, onReady]);

  // Cleanup any pending snapshot promises on unmount so callers don't
  // hang forever if they navigated away mid-capture.
  useEffect(() => () => {
    const pending = snapshotPromises.current;
    Object.keys(pending).forEach((k) => {
      try { pending[k].reject(new Error('Map unmounted')); } catch {}
    });
    snapshotPromises.current = {};
  }, []);

  return (
    <View style={[styles.root, style]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://localhost/' }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        // Prevent the default white flash while tiles fetch.
        style={styles.web}
        containerStyle={styles.web}
        // iOS only — let the WebView paint over the dark theme.
        // (Android ignores this prop, falls back to the body background.)
        // @ts-ignore — typed loosely in older webview versions
        scrollEnabled={false}
        // Stop the WebView from intercepting deep links — every URL the
        // map could open (OSM attribution, etc.) is non-navigational.
        onShouldStartLoadWithRequest={(req) => req.url.startsWith('about:') || req.url.startsWith('https://localhost/')}
        // Use the new Android architecture path that supports CORS canvas.
        // hardwareAccelerationDisabledAndroid={false}
        mixedContentMode="always"
      />
      {loading ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color={colors.cyan} />
        </View>
      ) : null}
    </View>
  );
});

export default BTLeafletMap;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1a1d22', overflow: 'hidden' },
  web: { flex: 1, backgroundColor: '#1a1d22' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#1a1d22DD',
  },
});
