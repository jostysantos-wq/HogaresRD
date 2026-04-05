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

    private init() {
        // Load existing values, fall back to defaults when the keys are absent.
        self.lockEnabled = UserDefaults.standard.bool(forKey: "rd_lock_enabled")
        let storedTimeout = UserDefaults.standard.integer(forKey: "rd_lock_timeout")
        self.idleTimeoutMinutes = storedTimeout > 0 ? storedTimeout : 5
    }

    /// Call from `.onChange(of: scenePhase)` in the app root.
    func handleScenePhase(_ phase: ScenePhase, isLoggedIn: Bool) {
        guard lockEnabled, isLoggedIn else { return }

        switch phase {
        case .background, .inactive:
            if backgroundDate == nil {
                backgroundDate = Date()
            }
        case .active:
            if let bg = backgroundDate {
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
