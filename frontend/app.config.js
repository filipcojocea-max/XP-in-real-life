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
  return {
    ...config,
    android: {
      ...android,
      // EAS sets GOOGLE_SERVICES_JSON to the temporary file path of the
      // uploaded EAS secret. Local dev (`expo start`) leaves it unset,
      // so we fall back to the path declared in app.json.
      googleServicesFile:
        process.env.GOOGLE_SERVICES_JSON || android.googleServicesFile,
    },
  };
};
