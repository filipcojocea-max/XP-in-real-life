package expo.modules.appblocker

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Bridge between JS and the AppBlocker foreground service. Stays as
 * thin as possible: the heavy polling lives in `AppBlockerService`.
 *
 * Why a foreground service rather than polling from JS?
 *   - JS bridge dies the moment the user backgrounds the app, so any
 *     setInterval running there would stop. The OS lets foreground
 *     services keep running and querying UsageStatsManager.
 *   - Required by Android 14+ to even *call* UsageStatsManager from a
 *     non-foreground process.
 */
class AppBlockerModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("AppBlocker")

    // Events emitted to JS (`AppBlocker.addLockedAppListener(...)`).
    Events("onLockedAppOpened")

    // ────────────────────────────────────────────────────────────────
    // Permission helpers
    // ────────────────────────────────────────────────────────────────

    AsyncFunction("hasUsageAccessPermission") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      hasUsageAccessPermission(ctx)
    }

    AsyncFunction("requestUsageAccessPermission") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
        // Required because we're starting an Activity from a non-Activity context.
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      runCatching { ctx.startActivity(intent) }.isSuccess
    }

    // ────────────────────────────────────────────────────────────────
    // Service start / stop
    // ────────────────────────────────────────────────────────────────

    AsyncFunction("startMonitoring") { lockedPackages: List<String> ->
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      // Cache the listener bridge so the service can emit events.
      AppBlockerService.attachModule(this@AppBlockerModule)
      val intent = Intent(ctx, AppBlockerService::class.java).apply {
        action = AppBlockerService.ACTION_START
        putStringArrayListExtra(
          AppBlockerService.EXTRA_PACKAGES,
          ArrayList(lockedPackages),
        )
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      true
    }

    AsyncFunction("stopMonitoring") {
      val ctx = appContext.reactContext
        ?: return@AsyncFunction mapOf("totalSeconds" to 0, "detectedPackages" to emptyList<String>())
      val totalSeconds = AppBlockerService.lastTotalSeconds
      val detected = AppBlockerService.lastDetectedPackages.toList()
      val intent = Intent(ctx, AppBlockerService::class.java).apply {
        action = AppBlockerService.ACTION_STOP
      }
      runCatching { ctx.startService(intent) }
      AppBlockerService.detachModule()
      mapOf(
        "totalSeconds" to totalSeconds,
        "detectedPackages" to detected,
      )
    }
  }

  /**
   * Called by the foreground service when a locked package is detected
   * as the current foreground app. Forwards the data into the JS event
   * stream so the UI can react in real time.
   */
  internal fun emitLockedAppEvent(packageName: String, totalSeconds: Int) {
    sendEvent("onLockedAppOpened", mapOf(
      "packageName" to packageName,
      "totalSeconds" to totalSeconds,
    ))
  }

  companion object {
    /**
     * Modern AppOps-based check. Returns true iff the user has flipped
     * the special "Usage access" toggle on for this app.
     */
    fun hasUsageAccessPermission(ctx: Context): Boolean {
      val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        appOps.unsafeCheckOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          ctx.packageName,
        )
      } else {
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          ctx.packageName,
        )
      }
      return mode == AppOpsManager.MODE_ALLOWED
    }
  }
}
