/**
 * withHealthConnectPermissions — custom Expo config plugin that injects
 * the two manifest declarations Health Connect REQUIRES on Android
 * 14+ (API 34+). Without them, Android's security layer silently rejects
 * every permission request and the "Allow access to Health Connect?"
 * system dialog never appears — which is exactly the bug the user was
 * hitting.
 *
 * What gets injected into AndroidManifest.xml:
 *
 *   1. The main activity gets a second intent-filter:
 *        <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE"/>
 *      (already added by the vendor plugin — we keep it for completeness /
 *       idempotence in case someone removes the vendor plugin).
 *
 *   2. A new <activity-alias> is added that handles the Privacy-Policy
 *      intent Health Connect requires to VERIFY the app has a privacy
 *      policy surface before it allows data access:
 *
 *        <activity-alias
 *            android:name="ViewPermissionUsageActivity"
 *            android:exported="true"
 *            android:targetActivity=".MainActivity"
 *            android:permission="android.permission.START_VIEW_PERMISSION_USAGE">
 *            <intent-filter>
 *                <action android:name="android.intent.action.VIEW_PERMISSION_USAGE"/>
 *                <category android:name="android.intent.category.HEALTH_PERMISSIONS"/>
 *            </intent-filter>
 *        </activity-alias>
 *
 * This is the piece Google's Health Connect docs require for API 34+.
 * The vendor plugin `react-native-health-connect` only injects item (1);
 * item (2) has to be added manually or the OS rejects the request.
 *
 * References:
 *   https://developer.android.com/health-and-fitness/guides/health-connect/develop/get-started
 *   https://developer.android.com/health-and-fitness/guides/health-connect/plan/best-practices
 */
const { withAndroidManifest } = require('@expo/config-plugins');

function ensureRationaleIntentFilter(mainActivity) {
  const filters = mainActivity['intent-filter'] || [];
  const hasRationale = filters.some((f) =>
    (f.action || []).some(
      (a) => a?.$?.['android:name'] === 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE',
    ),
  );
  if (!hasRationale) {
    filters.push({
      action: [{ $: { 'android:name': 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE' } }],
    });
    mainActivity['intent-filter'] = filters;
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
  });
  application['activity-alias'] = aliases;
}

const withHealthConnectPermissions = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return cfg;
    const mainActivity = (application.activity || []).find(
      (a) => a?.$?.['android:name'] === '.MainActivity',
    ) || application.activity?.[0];
    if (mainActivity) ensureRationaleIntentFilter(mainActivity);
    ensureViewPermissionUsageAlias(application);
    return cfg;
  });
};

module.exports = withHealthConnectPermissions;
