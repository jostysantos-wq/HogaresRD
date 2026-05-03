import Foundation

/// Tracks which listings the current user has "liked" from the feed.
///
/// Before this store existed, the FeedView's heart button just incremented
/// a local integer on every tap — producing the "infinity likes" bug where
/// a single user could bump a listing's like count forever. Now each tap
/// toggles a persistent Set of liked IDs (one like per user per listing)
/// and POSTs the toggle to `/api/listings/:id/like` which enforces the
/// same invariant server-side.
///
/// Mirrors the shape of SavedStore so ReelCard can use them side-by-side.
@MainActor
class LikesStore: ObservableObject {
    static let shared = LikesStore()

    @Published private(set) var likedIDs: Set<String>

    /// Local cache of the latest like count we've heard from the server,
    /// keyed by listing id. Lets the feed card show the fresh count after
    /// the user toggles without having to re-fetch the whole listing.
    @Published private(set) var likeCounts: [String: Int] = [:]

    private let storageKey = "liked_listing_ids"

    private init() {
        let arr = UserDefaults.standard.stringArray(forKey: storageKey) ?? []
        likedIDs = Set(arr)
    }

    func isLiked(_ id: String) -> Bool { likedIDs.contains(id) }

    /// Read the cached like count for a listing, or fall back to the value
    /// the caller already knows (e.g. from the listing payload).
    func count(for id: String, fallback: Int) -> Int {
        likeCounts[id] ?? fallback
    }

    /// Toggle the user's like on a listing.
    ///
    /// Guests (no current user) trigger the same auth-required notification
    /// used by SavedStore, so ContentView can present the auth sheet.
    /// Returns true when the toggle was applied locally.
    @discardableResult
    func toggle(_ id: String, currentServerCount: Int) -> Bool {
        guard APIService.shared.currentUser != nil else {
            NotificationCenter.default.post(name: .authRequiredForFavorite, object: nil)
            return false
        }

        let wasLiking = !likedIDs.contains(id)
        if wasLiking {
            likedIDs.insert(id)
        } else {
            likedIDs.remove(id)
        }

        // Optimistic count update — the server response will overwrite
        // this once it arrives so drift is bounded.
        let current = likeCounts[id] ?? currentServerCount
        likeCounts[id] = max(0, current + (wasLiking ? 1 : -1))

        // Persist the liked-id set off the main thread.
        let snapshot = Array(likedIDs)
        DispatchQueue.global(qos: .utility).async { [storageKey] in
            UserDefaults.standard.set(snapshot, forKey: storageKey)
        }

        // Sync with server in background (fire-and-forget).
        // Using `Task { ... }` (not `.detached`) so the closure inherits
        // LikesStore's @MainActor isolation — no actor hop, no
        // captured-self-in-concurrent-context warning.
        Task { [weak self] in
            if let newCount = try? await APIService.shared.toggleLike(
                listingId: id, liked: wasLiking
            ) {
                self?.likeCounts[id] = newCount
            }
        }

        return true
    }

    /// Clear local state — called on logout so the next session/guest
    /// doesn't inherit the previous user's likes.
    func clearLocal() {
        likedIDs.removeAll()
        likeCounts.removeAll()
        UserDefaults.standard.removeObject(forKey: storageKey)
    }
}
