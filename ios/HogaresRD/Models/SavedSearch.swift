import Foundation

// MARK: - Saved Search

struct SavedSearchFilters: Codable, Equatable {
    var type:        String?
    var condition:   String?
    var province:    String?
    var city:        String?
    var priceMin:    Double?
    var priceMax:    Double?
    var bedroomsMin: Int?
    var tags:        String?

    /// Human-readable summary of active filters.
    var summary: String {
        var parts: [String] = []
        if let t = type {
            let typeLabels = ["venta": "En Venta", "alquiler": "Alquiler", "proyecto": "Proyectos"]
            parts.append(typeLabels[t] ?? t)
        }
        if let b = bedroomsMin { parts.append("\(b)+ hab.") }
        if let p = province { parts.append(p) }
        if let c = city { parts.append(c) }
        if let max = priceMax { parts.append("hasta $\(Int(max).formatted(.number))") }
        if let min = priceMin { parts.append("desde $\(Int(min).formatted(.number))") }
        if let c = condition {
            let condLabels = ["nueva_construccion": "Nueva", "usada": "Usada", "planos": "En Planos"]
            parts.append(condLabels[c] ?? c)
        }
        return parts.isEmpty ? "Todas las propiedades" : parts.joined(separator: " · ")
    }

    var isEmpty: Bool {
        type == nil && condition == nil && province == nil && city == nil
            && priceMin == nil && priceMax == nil && bedroomsMin == nil && tags == nil
    }
}

struct SavedSearch: Codable, Identifiable {
    let id:          String
    let userId:      String
    var name:        String
    var filters:     SavedSearchFilters
    var notify:      Bool
    var matchCount:  Int?
    let createdAt:   String?
    let lastNotifiedAt: String?
}

struct SavedSearchesResponse: Decodable {
    let searches: [SavedSearch]
}

struct SavedSearchResponse: Decodable {
    let search: SavedSearch
    let listings: [Listing]?
    let total: Int?
}
