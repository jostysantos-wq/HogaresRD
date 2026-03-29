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

    enum CodingKeys: String, CodingKey {
        case id, title, type, condition, description, price,
             area_const, area_land, bedrooms, bathrooms, parking,
             province, city, sector, address, images, amenities,
             tags, agencies, status, views, submittedAt, approvedAt
    }

    init(from decoder: Decoder) throws {
        let c        = try decoder.container(keyedBy: CodingKeys.self)
        id           = try c.decode(String.self, forKey: .id)
        title        = try c.decode(String.self, forKey: .title)
        type         = try c.decode(String.self, forKey: .type)
        price        = try c.decode(String.self, forKey: .price)
        condition    = try? c.decode(String.self, forKey: .condition)
        description  = try? c.decode(String.self, forKey: .description)
        area_const   = try? c.decode(String.self, forKey: .area_const)
        area_land    = try? c.decode(String.self, forKey: .area_land)
        bedrooms     = try? c.decode(String.self, forKey: .bedrooms)
        bathrooms    = try? c.decode(String.self, forKey: .bathrooms)
        parking      = try? c.decode(String.self, forKey: .parking)
        province     = try? c.decode(String.self, forKey: .province)
        city         = try? c.decode(String.self, forKey: .city)
        sector       = try? c.decode(String.self, forKey: .sector)
        address      = try? c.decode(String.self, forKey: .address)
        status       = try? c.decode(String.self, forKey: .status)
        submittedAt  = try? c.decode(String.self, forKey: .submittedAt)
        approvedAt   = try? c.decode(String.self, forKey: .approvedAt)
        views        = try? c.decode(Int.self, forKey: .views)
        tags         = try? c.decode([String].self, forKey: .tags)
        agencies     = try? c.decode([Agency].self, forKey: .agencies)
        // Default to empty array if null or missing
        images       = (try? c.decode([String].self, forKey: .images))    ?? []
        amenities    = (try? c.decode([String].self, forKey: .amenities)) ?? []
    }
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

// Wraps any Decodable so a single bad array element doesn't kill the whole decode
private struct Safe<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? decoder.singleValueContainer().decode(T.self)
    }
}

struct ListingsResponse: Decodable {
    let listings: [Listing]
    let total: Int
    let page: Int
    let pages: Int

    private enum CodingKeys: String, CodingKey { case listings, total, page, pages }

    init(from decoder: Decoder) throws {
        let c  = try decoder.container(keyedBy: CodingKeys.self)
        total  = try c.decode(Int.self, forKey: .total)
        page   = try c.decode(Int.self, forKey: .page)
        pages  = try c.decode(Int.self, forKey: .pages)
        // Silently skip any listing whose JSON is malformed
        listings = try c.decode([Safe<Listing>].self, forKey: .listings).compactMap { $0.value }
    }
}
