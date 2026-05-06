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

    /// IDs saved while the user wasn't logged in. On the next login,
    /// `syncPendingToServer()` POSTs each one so the user's account
    /// inherits everything they collected as a guest.
    @Published private(set) var pendingSyncIDs: Set<String>

    // Soft-ask cooldown (3 days) — if user taps "Not now" we respect it
    // for this many seconds before offering again.
    static let SOFT_ASK_DISMISSED_KEY: String = "push_soft_ask_dismissed_ts"
    static let SOFT_ASK_COOLDOWN: TimeInterval = 3 * 24 * 60 * 60

    // `nonisolated` so the `Sendable` closure that writes to
    // UserDefaults from a background queue can read these without
    // hopping back to the main actor.
    nonisolated private static let SAVED_KEY   = "saved_listing_ids"
    nonisolated private static let PENDING_KEY = "saved_pending_sync"

    private init() {
        savedIDs       = Set(UserDefaults.standard.stringArray(forKey: Self.SAVED_KEY)   ?? [])
        pendingSyncIDs = Set(UserDefaults.standard.stringArray(forKey: Self.PENDING_KEY) ?? [])
    }

    func isSaved(_ id: String) -> Bool { savedIDs.contains(id) }

    /// Toggle a favorite. Always saves to local UserDefaults regardless
    /// of login state — guests can build their favourites list and have
    /// it merged into their account on signup/login (Phase D — loosen
    /// the onboarding gate). Server sync runs in the background only
    /// when the user is logged in; for guests we queue the id in
    /// `pendingSyncIDs` and flush the queue on the next login.
    @discardableResult
    func toggle(_ id: String) -> Bool {
        let wasAdding  = !savedIDs.contains(id)
        let isLoggedIn = APIService.shared.currentUser != nil

        if wasAdding {
            savedIDs.insert(id)
            if !isLoggedIn { pendingSyncIDs.insert(id) }
        } else {
            savedIDs.remove(id)
            pendingSyncIDs.remove(id)
        }

        let savedSnap   = Array(savedIDs)
        let pendingSnap = Array(pendingSyncIDs)
        DispatchQueue.global(qos: .utility).async {
            UserDefaults.standard.set(savedSnap,   forKey: Self.SAVED_KEY)
            UserDefaults.standard.set(pendingSnap, forKey: Self.PENDING_KEY)
        }

        // Server sync: only fires for logged-in users. Guest favourites
        // sit in pendingSyncIDs until login.
        if isLoggedIn {
            Task.detached {
                if wasAdding {
                    try? await APIService.shared.addFavorite(listingId: id)
                } else {
                    try? await APIService.shared.removeFavorite(listingId: id)
                }
            }
        }

        // Soft-ask push permission on ADD (works for both guests and
        // logged-in users — the system prompt is what matters).
        if wasAdding {
            Task { @MainActor in
                await Self.maybeTriggerPushSoftAsk()
            }
        }
        return true
    }

    /// Push every guest-era pending favourite to the server. Called
    /// once per login transition by ContentView when api.currentUser
    /// goes from nil → set. Idempotent — pendingSyncIDs is cleared
    /// after the round trip; addFavorite is also server-side
    /// idempotent so duplicate calls are harmless.
    func syncPendingToServer() async {
        guard APIService.shared.currentUser != nil else { return }
        let toSync = pendingSyncIDs
        guard !toSync.isEmpty else { return }
        for id in toSync {
            try? await APIService.shared.addFavorite(listingId: id)
        }
        pendingSyncIDs.removeAll()
        UserDefaults.standard.removeObject(forKey: Self.PENDING_KEY)
    }

    /// Pull the user's server-side favorites and merge into local state.
    /// Called on login transition alongside `syncPendingToServer()` so
    /// the user sees their full collection (guest hearts + existing
    /// account hearts) without a full app reload.
    func hydrateFromServer() async {
        let serverIDs = await APIService.shared.getMyFavoriteIDs()
        guard !serverIDs.isEmpty else { return }
        savedIDs.formUnion(serverIDs)
        let snap = Array(savedIDs)
        DispatchQueue.global(qos: .utility).async {
            UserDefaults.standard.set(snap, forKey: Self.SAVED_KEY)
        }
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
