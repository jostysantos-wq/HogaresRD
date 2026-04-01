import Foundation

// MARK: - Application

struct Application: Identifiable {
    let id:           String
    let listingId:    String
    let listingTitle: String
    let listingType:  String
    let status:       String
    let statusReason: String?
    let intent:       String
    let createdAt:    String
    let updatedAt:    String
    let priceValue:   Double?

    var priceFormatted: String {
        guard let p = priceValue, p > 0 else { return "Precio a consultar" }
        if p >= 1_000_000 { return String(format: "$%.1fM", p / 1_000_000) }
        if p >= 1_000     { return String(format: "$%.0fK", p / 1_000) }
        return "$\(Int(p))"
    }

    var timeAgo: String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: createdAt) else { return "" }
        let d = Int(Date().timeIntervalSince(date) / 86400)
        if d == 0 { return "Hoy" }
        if d == 1 { return "Ayer" }
        if d < 30 { return "Hace \(d) días" }
        let m = d / 30
        return "Hace \(m) mes\(m > 1 ? "es" : "")"
    }
}

extension Application: Decodable {
    enum CodingKeys: String, CodingKey {
        case id
        case listingId    = "listing_id"
        case listingTitle = "listing_title"
        case listingPrice = "listing_price"
        case listingType  = "listing_type"
        case status
        case statusReason = "status_reason"
        case intent
        case createdAt    = "created_at"
        case updatedAt    = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c     = try decoder.container(keyedBy: CodingKeys.self)
        id           = try c.decode(String.self, forKey: .id)
        listingId    = try c.decode(String.self, forKey: .listingId)
        listingTitle = try c.decode(String.self, forKey: .listingTitle)
        listingType  = try c.decode(String.self, forKey: .listingType)
        status       = try c.decode(String.self, forKey: .status)
        statusReason = try? c.decode(String.self, forKey: .statusReason)
        intent       = try c.decode(String.self, forKey: .intent)
        createdAt    = try c.decode(String.self, forKey: .createdAt)
        updatedAt    = try c.decode(String.self, forKey: .updatedAt)

        if let d = try? c.decode(Double.self, forKey: .listingPrice) {
            priceValue = d
        } else if let s = try? c.decode(String.self, forKey: .listingPrice),
                  let d = Double(s) {
            priceValue = d
        } else {
            priceValue = nil
        }
    }
}

// MARK: - Response wrapper

struct ApplicationsResponse: Decodable {
    let applications: [Application]
}
