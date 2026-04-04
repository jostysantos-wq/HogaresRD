import Foundation

@MainActor
class SavedStore: ObservableObject {
    static let shared = SavedStore()

    @Published private(set) var savedIDs: Set<String>

    private init() {
        let arr = UserDefaults.standard.stringArray(forKey: "saved_listing_ids") ?? []
        savedIDs = Set(arr)
    }

    func isSaved(_ id: String) -> Bool { savedIDs.contains(id) }

    func toggle(_ id: String) {
        let wasAdding = !savedIDs.contains(id)
        if wasAdding { savedIDs.insert(id) }
        else         { savedIDs.remove(id) }
        UserDefaults.standard.set(Array(savedIDs), forKey: "saved_listing_ids")

        // Sync with server in background (fire-and-forget)
        Task.detached {
            if wasAdding {
                try? await APIService.shared.addFavorite(listingId: id)
            } else {
                try? await APIService.shared.removeFavorite(listingId: id)
            }
        }
    }
}
