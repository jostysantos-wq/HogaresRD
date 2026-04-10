import Foundation

struct Listing: Decodable, Identifiable, Equatable {
    static func == (lhs: Listing, rhs: Listing) -> Bool { lhs.id == rhs.id }
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

    // Project-specific fields
    let project_stage:        String?
    let delivery_date:        String?
    let floors:               Int?
    let units_available:      Int?
    let units_total:          Int?
    let unit_types:           [ListingUnit]?
    let construction_company: ConstructionCompany?
    let blueprints:           [String]?
    let lat:                  Double?
    let lng:                  Double?

    let tags:        [String]?
    let agencies:    [Agency]?
    let status:      String?
    let views:          Int?
    let favoriteCount:  Int?
    let likeCount:      Int?
    let unitInventory:  [UnitInventoryItem]?
    let submittedAt:    String?
    let approvedAt:     String?

    enum CodingKeys: String, CodingKey {
        case id, title, type, condition, description, price,
             area_const, area_land, bedrooms, bathrooms, parking,
             province, city, sector, address, images, amenities,
             tags, agencies, status, views, favoriteCount, likeCount, submittedAt, approvedAt,
             project_stage, delivery_date, floors, units_available,
             units_total, unit_types, construction_company, blueprints,
             lat, lng
        case unitInventory = "unit_inventory"
    }

    init(from decoder: Decoder) throws {
        let c                = try decoder.container(keyedBy: CodingKeys.self)
        id                   = try  c.decode(String.self, forKey: .id)
        title                = try  c.decode(String.self, forKey: .title)
        type                 = try  c.decode(String.self, forKey: .type)
        price                = try  c.decode(String.self, forKey: .price)
        condition            = try? c.decode(String.self, forKey: .condition)
        description          = try? c.decode(String.self, forKey: .description)
        area_const           = try? c.decode(String.self, forKey: .area_const)
        area_land            = try? c.decode(String.self, forKey: .area_land)
        bedrooms             = try? c.decode(String.self, forKey: .bedrooms)
        bathrooms            = try? c.decode(String.self, forKey: .bathrooms)
        parking              = try? c.decode(String.self, forKey: .parking)
        province             = try? c.decode(String.self, forKey: .province)
        city                 = try? c.decode(String.self, forKey: .city)
        sector               = try? c.decode(String.self, forKey: .sector)
        address              = try? c.decode(String.self, forKey: .address)
        status               = try? c.decode(String.self, forKey: .status)
        submittedAt          = try? c.decode(String.self, forKey: .submittedAt)
        approvedAt           = try? c.decode(String.self, forKey: .approvedAt)
        views                = try? c.decode(Int.self,    forKey: .views)
        favoriteCount        = try? c.decode(Int.self,    forKey: .favoriteCount)
        likeCount            = try? c.decode(Int.self,    forKey: .likeCount)
        unitInventory        = (try? c.decode([Safe<UnitInventoryItem>].self, forKey: .unitInventory))?.compactMap { $0.value } ?? []
        floors               = try? c.decode(Int.self,    forKey: .floors)
        units_available      = try? c.decode(Int.self,    forKey: .units_available)
        units_total          = try? c.decode(Int.self,    forKey: .units_total)
        project_stage        = try? c.decode(String.self, forKey: .project_stage)
        delivery_date        = try? c.decode(String.self, forKey: .delivery_date)
        // API may return lat/lng as a JSON string OR as a number — handle both
        lat = (try? c.decode(Double.self, forKey: .lat))
            ?? (try? c.decode(String.self, forKey: .lat)).flatMap(Double.init)
        lng = (try? c.decode(Double.self, forKey: .lng))
            ?? (try? c.decode(String.self, forKey: .lng)).flatMap(Double.init)
        tags                 = try? c.decode([String].self,           forKey: .tags)
        agencies             = try? c.decode([Agency].self,           forKey: .agencies)
        unit_types           = try? c.decode([ListingUnit].self,         forKey: .unit_types)
        construction_company = try? c.decode(ConstructionCompany.self, forKey: .construction_company)
        blueprints           = try? c.decode([String].self,           forKey: .blueprints)
        // Images can be [String] or [{url, label}] — handle both formats
        if let strImages = try? c.decode([String].self, forKey: .images) {
            images = strImages
        } else if let objImages = try? c.decode([ImageObject].self, forKey: .images) {
            images = objImages.map { $0.url }
        } else {
            images = []
        }
        amenities            = (try? c.decode([String].self, forKey: .amenities)) ?? []
    }

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

    /// Compact price for map pins: "$1.2M", "$450K", "$85K"
    var shortPrice: String {
        guard let n = Double(price) else { return "$?" }
        if n >= 1_000_000 { return String(format: "$%.1fM", n / 1_000_000) }
        if n >= 1_000     { return String(format: "$%.0fK", n / 1_000) }
        return priceFormatted
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

    var allImageURLs: [URL] {
        let base = APIService.baseURL
        return images.compactMap { path in
            if path.hasPrefix("http") { return URL(string: path) }
            return URL(string: base + path)
        }
    }
}

/// Backend may return images as objects with url + label
private struct ImageObject: Decodable {
    let url: String
    let label: String?
}

struct ListingUnit: Codable {
    let name:      String?
    let area:      String?
    let bedrooms:  Int?      // 0 = Studio
    let bathrooms: String?
    let parking:   String?
    let price:     String?
    let available: Int?
    let total:     Int?

    var bedroomLabel: String {
        guard let b = bedrooms else { return "" }
        return b == 0 ? "Estudio" : "\(b) hab."
    }

    var priceFormatted: String? {
        guard let p = price, let n = Double(p) else { return price }
        let f = NumberFormatter()
        f.numberStyle = .currency; f.currencyCode = "USD"; f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: n))
    }
}

struct UnitInventoryItem: Codable, Identifiable {
    let id:            String
    let label:         String
    let type:          String?
    let floor:         String?
    let notes:         String?
    let status:        String   // "available", "reserved", "sold"
    let applicationId: String?
    let clientName:    String?

    var statusColor: String {
        switch status {
        case "available": return "green"
        case "reserved":  return "orange"
        case "sold":      return "red"
        default:          return "gray"
        }
    }

    var statusLabel: String {
        switch status {
        case "available": return "Disponible"
        case "reserved":  return "Reservada"
        case "sold":      return "Vendida"
        default:          return status
        }
    }
}

struct ConstructionCompany: Codable {
    let name:               String?
    let years_experience:   Int?
    let projects_completed: Int?
    let units_delivered:    Int?
    let description:        String?
}

struct Agency: Codable {
    let name: String?
    let email: String?
    let phone: String?
    let userId: String?

    enum CodingKeys: String, CodingKey {
        case name, email, phone
        case userId = "user_id"
    }

    var slug: String? {
        guard let n = name else { return nil }
        let lower = n.lowercased().replacingOccurrences(of: " ", with: "-")
        return String(lower.filter { ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "-" })
    }
}

// Wraps any Decodable so a single bad array element doesn't kill the whole decode
struct Safe<T: Decodable>: Decodable {
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
