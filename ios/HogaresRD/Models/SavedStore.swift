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
        if savedIDs.contains(id) { savedIDs.remove(id) }
        else                     { savedIDs.insert(id) }
        UserDefaults.standard.set(Array(savedIDs), forKey: "saved_listing_ids")
    }
}
