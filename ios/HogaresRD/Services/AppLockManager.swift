import SwiftUI
import Combine

/// Manages idle auto-lock: when the app goes to background and returns
/// after the configured timeout, the UI is covered by a lock screen
/// requiring Face ID / Touch ID to dismiss.
class AppLockManager: ObservableObject {
    static let shared = AppLockManager()

    @Published var isLocked = false

    // NOTE: @AppStorage only works inside View structs. Using it on a class
    // property silently fails to persist changes. Manual UserDefaults
    // bridging is required here.
    @Published var lockEnabled: Bool {
        didSet { UserDefaults.standard.set(lockEnabled, forKey: "rd_lock_enabled") }
    }
    @Published var idleTimeoutMinutes: Int {
        didSet { UserDefaults.standard.set(idleTimeoutMinutes, forKey: "rd_lock_timeout") }
    }

    private var backgroundDate: Date?
    private var previousPhase: ScenePhase = .active

    private init() {
        // Load existing values, fall back to defaults when the keys are absent.
        self.lockEnabled = UserDefaults.standard.bool(forKey: "rd_lock_enabled")
        let storedTimeout = UserDefaults.standard.integer(forKey: "rd_lock_timeout")
        self.idleTimeoutMinutes = storedTimeout > 0 ? storedTimeout : 5
    }

    /// Call from `.onChange(of: scenePhase)` in the app root.
    ///
    /// We track the elapsed time since the FIRST `.background` transition
    /// and only clear it when the app returns to `.active` from `.background`.
    /// `.inactive` (e.g. control-center pull-down, banner overlays, the
    /// app-switcher swipe) is treated as transient — it must NOT reset the
    /// timer, otherwise a quick swipe-up cancels the lock when the user
    /// drops back in moments later.
    func handleScenePhase(_ phase: ScenePhase, isLoggedIn: Bool) {
        defer { previousPhase = phase }
        guard lockEnabled, isLoggedIn else { return }

        switch phase {
        case .background:
            // Only stamp the time on the first .background hit so further
            // .background -> .inactive -> .background flips don't extend
            // the timer artificially.
            if backgroundDate == nil {
                backgroundDate = Date()
            }
        case .inactive:
            // Pure passthrough — do not touch backgroundDate. If we were
            // already backgrounded the timer keeps ticking; if we weren't,
            // we don't want a transient inactive blip to count as idle.
            break
        case .active:
            // Only evaluate the lock when returning from .background. A
            // .inactive -> .active hop (e.g. dismissing an overlay) is a
            // no-op; backgroundDate stays as-is in case the user goes back
            // to the home screen seconds later.
            if previousPhase == .background, let bg = backgroundDate {
                let elapsed = Date().timeIntervalSince(bg)
                backgroundDate = nil
                if elapsed >= Double(idleTimeoutMinutes * 60) {
                    isLocked = true
                }
            }
        @unknown default:
            break
        }
    }

    func unlock() {
        isLocked = false
    }

    func lock() {
        isLocked = true
    }
}
