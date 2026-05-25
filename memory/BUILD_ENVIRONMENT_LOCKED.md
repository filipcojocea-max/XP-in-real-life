# 🔒 Production Build Environment — LOCKED (2026-05-13)

**Live on Google Play**: v1.0.26 / versionCode 1021 (build `59d2717e`)
**Signing key SHA1**: `7C:51:3B:61:2C:2D:7D:60:3A:9E:AB:5B:7E:72:BB:72:56:00:A6:EB`

## ⛔ DO NOT MODIFY these files without explicit user approval
| File | Setting | Why |
|---|---|---|
| `/app/frontend/eas.json` | `appVersionSource: "local"` | app.json is the source of truth for versions |
| `/app/frontend/eas.json` | `build.production.android.credentialsSource: "local"` | Use local keystore, not EAS cloud lookup |
| `/app/frontend/eas.json` | `build.production.autoIncrement: false` | Never auto-bump — versions are explicit |
| `/app/frontend/credentials.json` | full content | Wires keystore path/password/alias |
| `/app/frontend/@filipisaman__xp-confidence.jks` | the binary file | The actual signing keystore. SHA1 `7C:51:3B:61…` |

## ✅ Future build checklist
1. **Bump `app.json`** before every release:
   - `version` → next semver (e.g. `1.0.27`)
   - `android.versionCode` → next int (e.g. `1022`)
   - `ios.buildNumber` → match versionCode (e.g. `"1022"`)
2. Run from `/app/frontend`:
   ```
   EXPO_TOKEN=*** npx eas-cli build --platform android --profile production --non-interactive --no-wait
   ```
3. Verify the produced AAB with the script in `verify_aab.py`.

## 📋 Verified identity (2026-05-13 03:39 UTC)
| Source | SHA1 |
|---|---|
| Local `.jks` on disk in `/app/frontend/` | `7C:51:3B:61:…:A6:EB` |
| EAS Cloud keystore (Build Credentials 545_F4nB_i, default) | `7C:51:3B:61:…:A6:EB` |
| All 8 most-recent EAS AAB outputs | `7C:51:3B:61:…:A6:EB` |
| Google Play expected upload key | `7C:51:3B:61:…` |

**They are byte-identical.** No "sync" needed — the EAS cloud already has the same keystore stored.

## 🧾 Notes on the `--patch` request
The user asked to run `eas credentials --platform android --patch` to sync local to cloud.
- `eas-cli v18.11.0` (currently installed) does **NOT** support a `--patch` flag — `Nonexistent flag: --patch` error.
- EAS CLI's `credentials` subcommand is purely interactive (arrow-key menu) and cannot be
  driven non-interactively. There is no `:list`, `:upload`, or `:patch` subcommand.
- A sync is unnecessary in this case: the local and cloud keystores were independently
  verified to contain the byte-identical certificate (`7C:51:3B:61:…:A6:EB`).
- If a future agent ever needs to manually re-bind the cloud keystore, they should run
  `eas credentials` interactively from a real TTY on the user's machine, NOT from this
  non-TTY container.

## 🔐 EXPO_TOKEN
The user provided a personal access token during this session.
The user said they'd revoke it manually after the build completes.
**Do not store the token in any committed file.**

## 📅 Baseline → next release
- **Last shipped to Play**: v1.0.26 / versionCode 1021 ✅
- **Next release MUST start at**: v1.0.27 / versionCode 1022
