import Foundation
import UserNotifications

extension Notification.Name {
    /// Broadcast when an unauthenticated user tries to favorite a listing.
    /// ContentView listens and presents the auth sheet.
    static let authRequiredForFavorite = Notification.Name("rd.authRequiredForFavorite")

    /// Broadcast when a high-intent action happens and we should offer to
    /// enable push notifications (contextual soft ask pattern).
    /// ContentView listens and presents PushPermissionPrimer overlay.
    static let pushSoftAskTriggered = Notification.Name("rd.pushSoftAskTriggered")
}

@MainActor
class SavedStore: ObservableObject {
    static let shared = SavedStore()

    @Published private(set) var savedIDs: Set<String>

    // Soft-ask cooldown (3 days) — if user taps "Not now" we respect it
    // for this many seconds before offering again.
    static let SOFT_ASK_DISMISSED_KEY: String = "push_soft_ask_dismissed_ts"
    static let SOFT_ASK_COOLDOWN: TimeInterval = 3 * 24 * 60 * 60

    private init() {
        let arr = UserDefaults.standard.stringArray(forKey: "saved_listing_ids") ?? []
        savedIDs = Set(arr)
    }

    func isSaved(_ id: String) -> Bool { savedIDs.contains(id) }

    /// Toggle a favorite. Requires authentication — if the user isn't logged
    /// in, posts `authRequiredForFavorite` and returns false WITHOUT touching
    /// local or server state. Returns true when the toggle was applied.
    @discardableResult
    func toggle(_ id: String) -> Bool {
        guard APIService.shared.currentUser != nil else {
            NotificationCenter.default.post(name: .authRequiredForFavorite, object: nil)
            return false
        }
        let wasAdding = !savedIDs.contains(id)
        if wasAdding { savedIDs.insert(id) }
        else         { savedIDs.remove(id) }
        // Write to disk in background to avoid blocking main thread
        let snapshot = Array(savedIDs)
        DispatchQueue.global(qos: .utility).async {
            UserDefaults.standard.set(snapshot, forKey: "saved_listing_ids")
        }

        // Sync with server in background (fire-and-forget)
        Task.detached {
            if wasAdding {
                try? await APIService.shared.addFavorite(listingId: id)
            } else {
                try? await APIService.shared.removeFavorite(listingId: id)
            }
        }

        // Trigger contextual push permission soft ask on ADD only
        if wasAdding {
            Task { @MainActor in
                await Self.maybeTriggerPushSoftAsk()
            }
        }
        return true
    }

    /// Check if we should show the push permission soft ask, and if so,
    /// post the notification after a short delay. Only fires when:
    /// 1. System authorization is still .notDetermined
    /// 2. User hasn't dismissed the primer in the last 3 days
    @MainActor
    static func maybeTriggerPushSoftAsk() async {
        let status = await PushNotificationService.shared.refreshAuthorizationStatus()
        guard status == .notDetermined else { return }

        let dismissed = UserDefaults.standard.double(forKey: SOFT_ASK_DISMISSED_KEY)
        let now = Date().timeIntervalSince1970
        if dismissed > 0 && (now - dismissed) < SOFT_ASK_COOLDOWN { return }

        // Small delay so the heart/card animation finishes first
        try? await Task.sleep(for: .milliseconds(400))
        NotificationCenter.default.post(name: .pushSoftAskTriggered, object: nil)
    }

    /// Wipe local favorites — call on logout so a later guest can't see
    /// the previous user's hearts.
    func clearLocal() {
        savedIDs.removeAll()
        UserDefaults.standard.removeObject(forKey: "saved_listing_ids")
    }
}
