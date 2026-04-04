import SwiftUI
import Combine

/// Manages idle auto-lock: when the app goes to background and returns
/// after the configured timeout, the UI is covered by a lock screen
/// requiring Face ID / Touch ID to dismiss.
class AppLockManager: ObservableObject {
    static let shared = AppLockManager()

    @Published var isLocked = false
    @AppStorage("rd_lock_enabled") var lockEnabled = false
    @AppStorage("rd_lock_timeout") var idleTimeoutMinutes = 5

    private var backgroundDate: Date?

    private init() {}

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
