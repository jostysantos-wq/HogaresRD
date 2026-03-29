import Foundation

struct Listing: Codable, Identifiable {
    let id: String
    let title: String
    let type: String
    let condition: String?
    let description: String?
    let price: String
    let area_const: String?
    let area_land: String?
    let bedrooms: String?
    let bathrooms: String?
    let parking: String?
    let province: String?
    let city: String?
    let sector: String?
    let address: String?
    let images: [String]
    let amenities: [String]
    let tags: [String]?
    let agencies: [Agency]?
    let status: String?
    let views: Int?
    let submittedAt: String?
    let approvedAt: String?

    var priceFormatted: String {
        if let n = Double(price) {
            let f = NumberFormatter()
            f.numberStyle = .currency
            f.currencyCode = "USD"
            f.maximumFractionDigits = 0
            return f.string(from: NSNumber(value: n)) ?? "$\(price)"
        }
        return "$\(price)"
    }

    var typeLabel: String {
        switch type {
        case "venta": return "En Venta"
        case "alquiler": return "En Alquiler"
        case "proyecto": return "Nuevo Proyecto"
        default: return type.capitalized
        }
    }

    var firstImageURL: URL? {
        guard let first = images.first else { return nil }
        let base = APIService.baseURL
        if first.hasPrefix("http") { return URL(string: first) }
        return URL(string: base + first)
    }
}

struct Agency: Codable {
    let name: String?
    let email: String?
    let phone: String?
}

struct ListingsResponse: Codable {
    let listings: [Listing]
    let total: Int
    let page: Int
    let pages: Int
}
