import Foundation

extension Notification.Name {
    /// Broadcast when an unauthenticated user tries to favorite a listing.
    /// ContentView listens and presents the auth sheet.
    static let authRequiredForFavorite = Notification.Name("rd.authRequiredForFavorite")
}

@MainActor
class SavedStore: ObservableObject {
    static let shared = SavedStore()

    @Published private(set) var savedIDs: Set<String>

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
        return true
    }

    /// Wipe local favorites — call on logout so a later guest can't see
    /// the previous user's hearts.
    func clearLocal() {
        savedIDs.removeAll()
        UserDefaults.standard.removeObject(forKey: "saved_listing_ids")
    }
}
