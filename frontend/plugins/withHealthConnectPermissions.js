/**
 * withHealthConnectPermissions — custom Expo config plugin that injects
 * the manifest + resource declarations Health Connect REQUIRES on
 * Android 14+ (API 34+). Without these pieces, Android's security layer
 * silently rejects every permission request and the "Allow access to
 * Health Connect?" system dialog never appears — which is exactly the
 * crash-on-Connect bug.
 *
 * What this plugin does during `expo prebuild`:
 *
 *   1. AndroidManifest.xml (<application>):
 *       a) Adds an intent-filter on MainActivity for
 *          `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE` so the
 *          OS can launch our Privacy-Policy rationale screen. This is
 *          ALSO added by the `react-native-health-connect` vendor plugin
 *          — our version is idempotent so we don't produce duplicates.
 *       b) Adds a `<meta-data>` under MainActivity pointing
 *          `health_permissions` to the string-array resource below.
 *          This declares to the OS which Health Connect permissions
 *          this app intends to read/write so Health Connect's settings
 *          screen shows them correctly.
 *       c) Adds a `<activity-alias name="ViewPermissionUsageActivity">`
 *          that handles `android.intent.action.VIEW_PERMISSION_USAGE`
 *          with `category.HEALTH_PERMISSIONS`. This is the Privacy-
 *          Policy endpoint Android launches before it allows a Health
 *          Connect grant. Without it, the grant dialog never appears.
 *
 *   2. android/app/src/main/res/values/health_permissions.xml:
 *       A string-array resource listing every Health Connect permission
 *       we request, referenced by the meta-data above. Injected via
 *       `withDangerousMod` so it lives inside the generated Android
 *       project tree and survives `expo prebuild --clean`.
 *
 * Refs:
 *   https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started
 *   https://developer.android.com/health-and-fitness/guides/health-connect/plan/best-practices
 */
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const RATIONALE_ACTION = 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE';

// The list of Health Connect permissions we want Android to know about.
// These mirror the REQUIRED_PERMISSIONS array in src/healthConnect.ts so
// the two stay in lock-step. When you add a new permission in TS, add it
// here too. The values are the constants listed at
// https://developer.android.com/reference/androidx/health/connect/client/permission/HealthPermission
const HEALTH_PERMISSIONS = [
  'android.permission.health.READ_SLEEP',
  'android.permission.health.READ_STEPS',
  'android.permission.health.READ_HEART_RATE',
  'android.permission.health.READ_OXYGEN_SATURATION',
  'android.permission.health.READ_EXERCISE',
  'android.permission.health.READ_ACTIVE_CALORIES_BURNED',
  'android.permission.health.READ_TOTAL_CALORIES_BURNED',
];

function ensureRationaleIntentFilter(mainActivity) {
  const filters = mainActivity['intent-filter'] || [];
  const hasRationale = filters.some((f) =>
    (f.action || []).some((a) => a?.$?.['android:name'] === RATIONALE_ACTION),
  );
  if (!hasRationale) {
    filters.push({ action: [{ $: { 'android:name': RATIONALE_ACTION } }] });
    mainActivity['intent-filter'] = filters;
  }
}

function ensureHealthPermissionsMetaData(mainActivity) {
  // Attach `android:name=health_permissions` meta-data pointing to the
  // string-array resource we drop into res/values/. The meta-data tells
  // Android which Health Connect permissions this app uses and is what
  // makes Health Connect recognise us as a "health reader" in its
  // Connected-Apps list.
  const metaDatas = mainActivity['meta-data'] || [];
  const exists = metaDatas.some(
    (m) => m?.$?.['android:name'] === 'health_permissions',
  );
  if (!exists) {
    metaDatas.push({
      $: {
        'android:name': 'health_permissions',
        'android:resource': '@array/health_permissions',
      },
    });
    mainActivity['meta-data'] = metaDatas;
  }
}

function ensureViewPermissionUsageAlias(application) {
  const aliases = application['activity-alias'] || [];
  const exists = aliases.some(
    (a) => a?.$?.['android:name'] === 'ViewPermissionUsageActivity',
  );
  if (exists) return;
  aliases.push({
    $: {
      'android:name': 'ViewPermissionUsageActivity',
      'android:exported': 'true',
      'android:targetActivity': '.MainActivity',
      'android:permission': 'android.permission.START_VIEW_PERMISSION_USAGE',
    },
    'intent-filter': [
      {
        action: [{ $: { 'android:name': 'android.intent.action.VIEW_PERMISSION_USAGE' } }],
        category: [{ $: { 'android:name': 'android.intent.category.HEALTH_PERMISSIONS' } }],
      },
    ],
    // Meta-data also attached to the alias so Android can introspect
    // the permissions via the Privacy-Policy activity.
    'meta-data': [
      {
        $: {
          'android:name': 'health_permissions',
          'android:resource': '@array/health_permissions',
        },
      },
    ],
  });
  application['activity-alias'] = aliases;
}

const withManifestTweaks = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return cfg;
    const mainActivity = (application.activity || []).find(
      (a) => a?.$?.['android:name'] === '.MainActivity',
    ) || application.activity?.[0];
    // NOTE: we INTENTIONALLY don't re-add the
    // `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE` intent-filter
    // here — the `react-native-health-connect` vendor plugin already
    // adds it. Because Expo runs config-plugin mods LIFO (the most
    // recently registered runs first), our mod executes BEFORE the
    // vendor's, which means any idempotence check would always see an
    // empty slate and push a duplicate. We purposely stay additive-only:
    // meta-data + alias + resource file.
    if (mainActivity) {
      ensureHealthPermissionsMetaData(mainActivity);
    }
    ensureViewPermissionUsageAlias(application);
    return cfg;
  });
};

// Inject a `health_permissions.xml` string-array resource into
// android/app/src/main/res/values/ so the @array/health_permissions
// reference in the Manifest resolves. Without this file, the app
// would fail to build with `AAPT: error: resource array/health_permissions not found`.
const withHealthPermissionsResource = (config) => {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const valuesDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'res', 'values',
      );
      const outFile = path.join(valuesDir, 'health_permissions.xml');
      try {
        fs.mkdirSync(valuesDir, { recursive: true });
        const items = HEALTH_PERMISSIONS
          .map((p) => `    <item>${p}</item>`)
          .join('\n');
        const xml =
          '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<resources>\n' +
          '  <array name="health_permissions">\n' +
          `${items}\n` +
          '  </array>\n' +
          '</resources>\n';
        fs.writeFileSync(outFile, xml, 'utf8');
      } catch (e) {
        console.warn('[withHealthConnectPermissions] failed to write resource:', e);
      }
      return cfg;
    },
  ]);
};

const withHealthConnectPermissions = (config) => {
  // Compose both mods. Manifest first (synchronous XML edit), then the
  // filesystem drop (dangerous mod runs during the android prebuild
  // phase after the project has been generated).
  config = withManifestTweaks(config);
  config = withHealthPermissionsResource(config);
  return config;
};

module.exports = withHealthConnectPermissions;
