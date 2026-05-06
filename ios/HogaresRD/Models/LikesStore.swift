import Foundation

/// Tracks which listings the current user has "liked" from the feed.
///
/// Mirrors SavedStore's guest-friendly behavior: guests can like locally,
/// and on the next login transition we flush `pendingSyncIDs` to the
/// server so the user inherits everything they collected as a guest.
@MainActor
class LikesStore: ObservableObject {
    static let shared = LikesStore()

    @Published private(set) var likedIDs: Set<String>

    /// IDs liked while the user wasn't logged in. On the next login,
    /// `syncPendingToServer()` POSTs each one so the user's account
    /// inherits the guest likes.
    @Published private(set) var pendingSyncIDs: Set<String>

    /// Local cache of the latest like count we've heard from the server,
    /// keyed by listing id. Lets the feed card show the fresh count after
    /// the user toggles without having to re-fetch the whole listing.
    @Published private(set) var likeCounts: [String: Int] = [:]

    private let storageKey  = "liked_listing_ids"
    private let pendingKey  = "liked_pending_sync"

    private init() {
        let arr = UserDefaults.standard.stringArray(forKey: storageKey) ?? []
        likedIDs = Set(arr)
        pendingSyncIDs = Set(UserDefaults.standard.stringArray(forKey: pendingKey) ?? [])
    }

    func isLiked(_ id: String) -> Bool { likedIDs.contains(id) }

    /// Read the cached like count for a listing, or fall back to the value
    /// the caller already knows (e.g. from the listing payload).
    func count(for id: String, fallback: Int) -> Int {
        likeCounts[id] ?? fallback
    }

    /// Toggle the user's like on a listing. Always applied locally — guest
    /// likes queue in `pendingSyncIDs` and flush on next login.
    @discardableResult
    func toggle(_ id: String, currentServerCount: Int) -> Bool {
        let wasLiking = !likedIDs.contains(id)
        let isLoggedIn = APIService.shared.currentUser != nil

        if wasLiking {
            likedIDs.insert(id)
            if !isLoggedIn { pendingSyncIDs.insert(id) }
        } else {
            likedIDs.remove(id)
            pendingSyncIDs.remove(id)
        }

        // Optimistic count update — the server response will overwrite
        // this once it arrives so drift is bounded.
        let current = likeCounts[id] ?? currentServerCount
        likeCounts[id] = max(0, current + (wasLiking ? 1 : -1))

        let likedSnap   = Array(likedIDs)
        let pendingSnap = Array(pendingSyncIDs)
        DispatchQueue.global(qos: .utility).async { [storageKey, pendingKey] in
            UserDefaults.standard.set(likedSnap,   forKey: storageKey)
            UserDefaults.standard.set(pendingSnap, forKey: pendingKey)
        }

        if isLoggedIn {
            Task { [weak self] in
                if let newCount = try? await APIService.shared.toggleLike(
                    listingId: id, liked: wasLiking
                ) {
                    self?.likeCounts[id] = newCount
                }
            }
        }
        return true
    }

    /// Push every guest-era pending like to the server. Call once per
    /// login transition (alongside SavedStore.syncPendingToServer).
    func syncPendingToServer() async {
        guard APIService.shared.currentUser != nil else { return }
        let toSync = pendingSyncIDs
        guard !toSync.isEmpty else { return }
        for id in toSync {
            if let newCount = try? await APIService.shared.toggleLike(listingId: id, liked: true) {
                likeCounts[id] = newCount
            }
        }
        pendingSyncIDs.removeAll()
        UserDefaults.standard.removeObject(forKey: pendingKey)
    }

    /// Clear local state — called on logout so the next session/guest
    /// doesn't inherit the previous user's likes.
    func clearLocal() {
        likedIDs.removeAll()
        pendingSyncIDs.removeAll()
        likeCounts.removeAll()
        UserDefaults.standard.removeObject(forKey: storageKey)
        UserDefaults.standard.removeObject(forKey: pendingKey)
    }
}
