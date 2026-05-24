/**
 * Dynamic Expo config — exists only so we can override
 * `android.googleServicesFile` at EAS-build time using an EAS file
 * secret named `GOOGLE_SERVICES_JSON` (created with `eas secret:create
 * --scope project --name GOOGLE_SERVICES_JSON --type file --value
 * ./google-services.json`).
 *
 * Why this file exists:
 *   • `google-services.json` is in .gitignore (it shouldn't be committed
 *     to the repo by hand — and after the recent "Save to GitHub" push
 *     it isn't on the EAS build machine either).
 *   • EAS injects file-typed secrets as a temporary file path on disk
 *     at build time; we just read the path from `process.env`.
 *   • Local `expo start` / preview builds keep working because we fall
 *     back to the on-disk path that already exists in this workspace
 *     (`./google-services.json`) when the env var isn't present.
 *
 * Everything else (icons, plugins, version codes, permissions, etc.)
 * stays in `app.json` as the source of truth — this file just spreads
 * that config and overrides one field.
 */

// `app.json` is auto-merged into `config` by Expo before this function
// runs, so we don't need to import it manually. We only override the
// android.googleServicesFile path.
module.exports = ({ config }) => {
  const android = config.android || {};

  // 1. Highest priority: EAS-injected file path (real build).
  // 2. If app.json has a placeholder secret-name string (no slash / dot),
  //    treat it as "use the secret" and fall back to the on-disk file
  //    when the env var isn't set (e.g. running `expo prebuild` locally
  //    without `eas` invoking us). This keeps local Android prebuild
  //    working even if someone forgets to export the env var.
  // 3. Otherwise honour the literal path declared in app.json.
  const declared = android.googleServicesFile;
  const looksLikeSecretName =
    typeof declared === 'string' &&
    !declared.includes('/') &&
    !declared.includes('.') &&
    declared === declared.toUpperCase();

  let resolved = declared;
  if (process.env.GOOGLE_SERVICES_JSON) {
    resolved = process.env.GOOGLE_SERVICES_JSON;
  } else if (looksLikeSecretName) {
    resolved = './google-services.json';
  }

  return {
    ...config,
    android: {
      ...android,
      googleServicesFile: resolved,
    },
  };
};
