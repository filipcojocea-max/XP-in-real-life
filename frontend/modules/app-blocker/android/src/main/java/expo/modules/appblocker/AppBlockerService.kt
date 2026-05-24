package expo.modules.appblocker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground service that polls UsageStatsManager every ~2 seconds to
 * see if the foreground app is on the user's blocklist. If yes:
 *   • Increments a session counter.
 *   • Fires a high-priority warning notification (only every 10s so
 *     the user isn't spammed).
 *   • Bridges the event to JS via AppBlockerModule.
 *
 * Lifecycle:
 *   • ACTION_START with EXTRA_PACKAGES → begins polling.
 *   • ACTION_STOP → flushes counters and stops the service.
 *
 * The companion object holds the latest counters so the JS-side stop
 * call can read them synchronously after asking the service to stop.
 */
class AppBlockerService : Service() {

  private val handler = Handler(Looper.getMainLooper())
  private var pollRunnable: Runnable? = null
  private var lockedPackages: Set<String> = emptySet()
  private var lastWarningAt: Long = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        val pkgs = intent.getStringArrayListExtra(EXTRA_PACKAGES)?.toSet() ?: emptySet()
        startSelfForeground()
        beginPolling(pkgs)
      }
      ACTION_STOP -> {
        stopSelfClean()
        return START_NOT_STICKY
      }
    }
    return START_STICKY
  }

  // ────────────────────────────────────────────────────────────────
  // Foreground notification (required for the service to stay alive)
  // ────────────────────────────────────────────────────────────────

  private fun startSelfForeground() {
    ensureChannels()
    val tapIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val pi = PendingIntent.getActivity(
      this, 0, tapIntent ?: Intent(),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notif = NotificationCompat.Builder(this, CHANNEL_FG)
      .setContentTitle("Focus Mode active")
      .setContentText("Watching for blocked apps. −15 XP per minute if you peek.")
      .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
      .setContentIntent(pi)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        FG_NOTIF_ID,
        notif,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(FG_NOTIF_ID, notif)
    }
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_FG) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          CHANNEL_FG,
          "Focus Mode · Active",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Persistent indicator while Focus Mode is monitoring blocked apps."
          setShowBadge(false)
        },
      )
    }
    if (nm.getNotificationChannel(CHANNEL_WARN) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          CHANNEL_WARN,
          "Focus Mode · Blocked-app warning",
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = "Fires when you open an app you committed to avoid."
          enableVibration(true)
        },
      )
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Polling loop
  // ────────────────────────────────────────────────────────────────

  private fun beginPolling(pkgs: Set<String>) {
    lockedPackages = pkgs
    totalSecondsAtomic.set(0)
    detectedPackagesSet.clear()
    lastWarningAt = 0L
    val tickEveryMs = 2_000L
    pollRunnable?.let { handler.removeCallbacks(it) }
    val r = object : Runnable {
      override fun run() {
        val fg = currentForegroundPackage()
        if (fg != null && lockedPackages.contains(fg) && fg != packageName) {
          // 2-second tick → +2 to running counter.
          val newTotal = totalSecondsAtomic.addAndGet(2)
          detectedPackagesSet.add(fg)
          maybeFireWarningNotification(fg)
          // Bridge to JS for live UI ("Apps that cost you XP" pill).
          attachedModule?.emitLockedAppEvent(fg, newTotal)
        }
        handler.postDelayed(this, tickEveryMs)
      }
    }
    pollRunnable = r
    handler.postDelayed(r, tickEveryMs)
  }

  private fun maybeFireWarningNotification(pkg: String) {
    val now = System.currentTimeMillis()
    if (now - lastWarningAt < 10_000) return // throttle to 1/10s
    lastWarningAt = now
    val name = runCatching {
      val info = packageManager.getApplicationInfo(pkg, 0)
      packageManager.getApplicationLabel(info).toString()
    }.getOrDefault(pkg)
    val tapIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val pi = PendingIntent.getActivity(
      this, 1, tapIntent ?: Intent(),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notif = NotificationCompat.Builder(this, CHANNEL_WARN)
      .setContentTitle("⚠\uFE0F Exit $name now")
      .setContentText("You will lose 15 XP per minute spent here.")
      .setStyle(NotificationCompat.BigTextStyle().bigText(
        "You committed to avoid $name during Focus Mode. Tap to return — every minute spent here costs you 15 XP."
      ))
      .setSmallIcon(android.R.drawable.ic_dialog_alert)
      .setContentIntent(pi)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVibrate(longArrayOf(0, 400, 200, 400))
      .build()
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(WARN_NOTIF_ID, notif)
  }

  /**
   * Reads the most recent foreground package via UsageStatsManager.
   * Falls back to null if permission missing or no events found.
   */
  private fun currentForegroundPackage(): String? {
    val usm = getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return null
    val end = System.currentTimeMillis()
    val begin = end - 10_000L
    return runCatching {
      val events = usm.queryEvents(begin, end)
      val event = android.app.usage.UsageEvents.Event()
      var lastPkg: String? = null
      while (events.hasNextEvent()) {
        events.getNextEvent(event)
        if (event.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) {
          lastPkg = event.packageName
        }
      }
      lastPkg
    }.getOrNull()
  }

  // ────────────────────────────────────────────────────────────────
  // Stop
  // ────────────────────────────────────────────────────────────────

  private fun stopSelfClean() {
    pollRunnable?.let { handler.removeCallbacks(it) }
    pollRunnable = null
    lastTotalSeconds = totalSecondsAtomic.get()
    lastDetectedPackages.clear()
    lastDetectedPackages.addAll(detectedPackagesSet)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  override fun onDestroy() {
    pollRunnable?.let { handler.removeCallbacks(it) }
    super.onDestroy()
  }

  companion object {
    const val ACTION_START = "expo.modules.appblocker.START"
    const val ACTION_STOP = "expo.modules.appblocker.STOP"
    const val EXTRA_PACKAGES = "locked_packages"
    private const val CHANNEL_FG = "app_blocker_fg"
    private const val CHANNEL_WARN = "app_blocker_warn"
    private const val FG_NOTIF_ID = 7100
    private const val WARN_NOTIF_ID = 7101

    private val totalSecondsAtomic = AtomicInteger(0)
    private val detectedPackagesSet: MutableSet<String> = mutableSetOf()

    /** Snapshotted on stop so JS can read after `stopMonitoring()`. */
    @Volatile var lastTotalSeconds: Int = 0
    val lastDetectedPackages: MutableSet<String> = mutableSetOf()

    @Volatile private var attachedModule: AppBlockerModule? = null
    fun attachModule(m: AppBlockerModule) { attachedModule = m }
    fun detachModule() { attachedModule = null }
  }
}
