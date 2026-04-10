import Foundation

// MARK: - Analytics

struct DashboardAnalytics: Decodable {
    let totalApps: Int
    let enRevision: Int
    let docsPendientes: Int
    let aprobadas: Int
    let rechazadas: Int
    let conversionRate: Double
    let avgDaysToClose: Double
    let newThisMonth: Int
    let appsPerDay: [DayCount]
    let appsPerMonth: [MonthCount]
    let pipeline: PipelineCounts
    let topListings: [TopListing]

    enum CodingKeys: String, CodingKey {
        case totalApps = "total_apps"
        case enRevision = "en_revision"
        case docsPendientes = "docs_pendientes"
        case aprobadas, rechazadas
        case conversionRate = "conversion_rate"
        case avgDaysToClose = "avg_days_to_close"
        case newThisMonth = "new_this_month"
        case appsPerDay = "apps_per_day"
        case appsPerMonth = "apps_per_month"
        case pipeline
        case topListings = "top_listings"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalApps       = (try? c.decode(Int.self, forKey: .totalApps)) ?? 0
        enRevision      = (try? c.decode(Int.self, forKey: .enRevision)) ?? 0
        docsPendientes  = (try? c.decode(Int.self, forKey: .docsPendientes)) ?? 0
        aprobadas       = (try? c.decode(Int.self, forKey: .aprobadas)) ?? 0
        rechazadas      = (try? c.decode(Int.self, forKey: .rechazadas)) ?? 0
        conversionRate  = (try? c.decode(Double.self, forKey: .conversionRate)) ?? 0
        avgDaysToClose  = (try? c.decode(Double.self, forKey: .avgDaysToClose)) ?? 0
        newThisMonth    = (try? c.decode(Int.self, forKey: .newThisMonth)) ?? 0
        appsPerDay      = (try? c.decode([DayCount].self, forKey: .appsPerDay)) ?? []
        appsPerMonth    = (try? c.decode([MonthCount].self, forKey: .appsPerMonth)) ?? []
        pipeline        = (try? c.decode(PipelineCounts.self, forKey: .pipeline)) ?? PipelineCounts()
        topListings     = (try? c.decode([TopListing].self, forKey: .topListings)) ?? []
    }
}

struct DayCount: Decodable, Identifiable {
    var id: String { date }
    let date: String
    let count: Int
}

struct MonthCount: Decodable, Identifiable {
    var id: String { month }
    let month: String
    let count: Int
}

struct PipelineCounts: Decodable {
    let submitted: Int
    let reviewing: Int
    let approved: Int
    let rejected: Int
    let closed: Int

    init() { submitted = 0; reviewing = 0; approved = 0; rejected = 0; closed = 0 }
}

struct TopListing: Decodable, Identifiable {
    var id: String { listingId }
    let listingId: String
    let title: String
    let location: String?
    let price: String?
    let appCount: Int

    enum CodingKeys: String, CodingKey {
        case listingId = "listing_id"
        case title, location, price
        case appCount = "app_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        listingId = (try? c.decode(String.self, forKey: .listingId)) ?? UUID().uuidString
        title     = (try? c.decode(String.self, forKey: .title)) ?? "—"
        location  = try? c.decode(String.self, forKey: .location)
        price     = try? c.decode(String.self, forKey: .price)
        appCount  = (try? c.decode(Int.self, forKey: .appCount)) ?? 0
    }
}

// MARK: - Sales

struct DashboardSales: Decodable {
    let totalRevenue: Double
    let totalSales: Int
    let avgPrice: Double
    let pipelineValue: Double
    let monthlySales: [MonthlySale]
    let salesByType: [SaleByType]
    let recentSales: [SaleRecord]

    enum CodingKeys: String, CodingKey {
        case totalRevenue = "total_revenue"
        case totalSales = "total_sales"
        case avgPrice = "avg_price"
        case pipelineValue = "pipeline_value"
        case monthlySales = "monthly_sales"
        case salesByType = "sales_by_type"
        case recentSales = "recent_sales"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalRevenue  = (try? c.decode(Double.self, forKey: .totalRevenue)) ?? 0
        totalSales    = (try? c.decode(Int.self, forKey: .totalSales)) ?? 0
        avgPrice      = (try? c.decode(Double.self, forKey: .avgPrice)) ?? 0
        pipelineValue = (try? c.decode(Double.self, forKey: .pipelineValue)) ?? 0
        monthlySales  = (try? c.decode([MonthlySale].self, forKey: .monthlySales)) ?? []
        salesByType   = (try? c.decode([SaleByType].self, forKey: .salesByType)) ?? []
        recentSales   = (try? c.decode([SaleRecord].self, forKey: .recentSales)) ?? []
    }
}

struct MonthlySale: Decodable, Identifiable {
    var id: String { month }
    let month: String
    let revenue: Double
    let count: Int
}

struct SaleByType: Decodable, Identifiable {
    var id: String { type }
    let type: String
    let count: Int
    let revenue: Double
}

struct SaleRecord: Decodable, Identifiable {
    let id: String
    let client: String?
    let property: String?
    let price: Double?
    let date: String?
    let paymentStatus: String?

    enum CodingKeys: String, CodingKey {
        case id, client, property, price, date
        case paymentStatus = "payment_status"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id            = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        client        = try? c.decode(String.self, forKey: .client)
        property      = try? c.decode(String.self, forKey: .property)
        price         = try? c.decode(Double.self, forKey: .price)
        date          = try? c.decode(String.self, forKey: .date)
        paymentStatus = try? c.decode(String.self, forKey: .paymentStatus)
    }

    var priceFormatted: String {
        guard let p = price, p > 0 else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .currency; f.currencyCode = "USD"; f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: p)) ?? "$\(Int(p))"
    }
}

// MARK: - Accounting

struct DashboardAccounting: Decodable {
    let totalEarned: Double
    let pendingCommission: Double
    let commissionRate: Double
    let verifiedPayments: Int
    let monthlyCommissions: [MonthlyCommission]
    let records: [AccountingRecord]

    enum CodingKeys: String, CodingKey {
        case totalEarned = "total_earned"
        case pendingCommission = "pending_commission"
        case commissionRate = "commission_rate"
        case verifiedPayments = "verified_payments"
        case monthlyCommissions = "monthly_commissions"
        case records
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalEarned        = (try? c.decode(Double.self, forKey: .totalEarned)) ?? 0
        pendingCommission  = (try? c.decode(Double.self, forKey: .pendingCommission)) ?? 0
        commissionRate     = (try? c.decode(Double.self, forKey: .commissionRate)) ?? 0.03
        verifiedPayments   = (try? c.decode(Int.self, forKey: .verifiedPayments)) ?? 0
        monthlyCommissions = (try? c.decode([MonthlyCommission].self, forKey: .monthlyCommissions)) ?? []
        records            = (try? c.decode([AccountingRecord].self, forKey: .records)) ?? []
    }
}

struct MonthlyCommission: Decodable, Identifiable {
    var id: String { month }
    let month: String
    let commission: Double
}

struct AccountingRecord: Decodable, Identifiable {
    let id: String
    let client: String?
    let property: String?
    let price: Double?
    let commission: Double?
    let paymentStatus: String?
    let date: String?

    enum CodingKeys: String, CodingKey {
        case id, client, property, price, commission
        case paymentStatus = "payment_status"
        case date
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id            = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        client        = try? c.decode(String.self, forKey: .client)
        property      = try? c.decode(String.self, forKey: .property)
        price         = try? c.decode(Double.self, forKey: .price)
        commission    = try? c.decode(Double.self, forKey: .commission)
        paymentStatus = try? c.decode(String.self, forKey: .paymentStatus)
        date          = try? c.decode(String.self, forKey: .date)
    }
}

// MARK: - Documents Archive

struct DashboardDocuments: Decodable {
    let documents: [ArchiveDocument]
    let total: Int
    let page: Int
    let pages: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        documents = (try? c.decode([ArchiveDocument].self, forKey: .documents)) ?? []
        total     = (try? c.decode(Int.self, forKey: .total)) ?? 0
        page      = (try? c.decode(Int.self, forKey: .page)) ?? 1
        pages     = (try? c.decode(Int.self, forKey: .pages)) ?? 1
    }

    enum CodingKeys: String, CodingKey { case documents, total, page, pages }
}

struct ArchiveDocument: Decodable, Identifiable {
    let id: String
    let name: String?
    let type: String?
    let status: String?
    let client: String?
    let property: String?
    let uploadDate: String?
    let fileSize: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type, status, client, property
        case uploadDate = "upload_date"
        case fileSize = "file_size"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id         = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name       = try? c.decode(String.self, forKey: .name)
        type       = try? c.decode(String.self, forKey: .type)
        status     = try? c.decode(String.self, forKey: .status)
        client     = try? c.decode(String.self, forKey: .client)
        property   = try? c.decode(String.self, forKey: .property)
        uploadDate = try? c.decode(String.self, forKey: .uploadDate)
        fileSize   = try? c.decode(String.self, forKey: .fileSize)
    }
}

// MARK: - Audit Log

struct DashboardAudit: Decodable {
    let events: [AuditEvent]
    let total: Int
    let page: Int
    let pages: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = (try? c.decode([AuditEvent].self, forKey: .events)) ?? []
        total  = (try? c.decode(Int.self, forKey: .total)) ?? 0
        page   = (try? c.decode(Int.self, forKey: .page)) ?? 1
        pages  = (try? c.decode(Int.self, forKey: .pages)) ?? 1
    }

    enum CodingKeys: String, CodingKey { case events, total, page, pages }
}

struct AuditEvent: Decodable, Identifiable {
    let id: String
    let type: String?
    let description: String?
    let actor: String?
    let client: String?
    let listing: String?
    let timestamp: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id          = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        type        = try? c.decode(String.self, forKey: .type)
        description = try? c.decode(String.self, forKey: .description)
        actor       = try? c.decode(String.self, forKey: .actor)
        client      = try? c.decode(String.self, forKey: .client)
        listing     = try? c.decode(String.self, forKey: .listing)
        timestamp   = try? c.decode(String.self, forKey: .timestamp)
    }

    enum CodingKeys: String, CodingKey {
        case id, type, description, actor, client, listing, timestamp
    }

    var icon: String {
        switch type {
        case "status_change":     return "arrow.triangle.2.circlepath"
        case "checklist_complete": return "checkmark.circle.fill"
        case "checklist_item":    return "checklist"
        case "document":          return "doc.fill"
        case "tour":              return "figure.walk"
        case "payment":           return "creditcard.fill"
        case "note":              return "bubble.left.fill"
        default:                  return "clock.fill"
        }
    }

    var iconColor: Color {
        switch type {
        case "status_change":      return .blue
        case "checklist_complete": return .green
        case "document":           return .purple
        case "tour":               return .orange
        case "payment":            return .green
        case "note":               return .gray
        default:                   return .secondary
        }
    }
}

// MARK: - Inmobiliaria Team

struct TeamBroker: Decodable, Identifiable {
    let id: String
    let name: String
    let email: String
    let phone: String?
    let role: String?
    let licenseNumber: String?
    let jobTitle: String?
    let teamTitle: String?
    let accessLevel: Int
    let joinedAt: String?
    let appCount: Int
    let emailVerified: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, email, phone, role
        case licenseNumber = "licenseNumber"
        case jobTitle = "jobTitle"
        case teamTitle = "team_title"
        case accessLevel = "access_level"
        case joinedAt = "joined_at"
        case appCount = "app_count"
        case emailVerified = "emailVerified"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id             = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name           = (try? c.decode(String.self, forKey: .name)) ?? "—"
        email          = (try? c.decode(String.self, forKey: .email)) ?? ""
        phone          = try? c.decode(String.self, forKey: .phone)
        role           = try? c.decode(String.self, forKey: .role)
        licenseNumber  = try? c.decode(String.self, forKey: .licenseNumber)
        jobTitle       = try? c.decode(String.self, forKey: .jobTitle)
        teamTitle      = try? c.decode(String.self, forKey: .teamTitle)
        accessLevel    = (try? c.decode(Int.self, forKey: .accessLevel)) ?? 1
        joinedAt       = try? c.decode(String.self, forKey: .joinedAt)
        appCount       = (try? c.decode(Int.self, forKey: .appCount)) ?? 0
        emailVerified  = try? c.decode(Bool.self, forKey: .emailVerified)
    }

    var accessLabel: String {
        switch accessLevel {
        case 1: return "Asistente"
        case 2: return "Gerente"
        case 3: return "Director"
        default: return "Asistente"
        }
    }

    var accessColor: String {
        switch accessLevel {
        case 1: return "gray"
        case 2: return "orange"
        case 3: return "purple"
        default: return "gray"
        }
    }

    var displayTitle: String { teamTitle ?? jobTitle ?? "" }

    var initials: String {
        name.components(separatedBy: " ")
            .prefix(2)
            .compactMap { $0.first }
            .map { String($0) }
            .joined()
            .uppercased()
    }
}

struct JoinRequest: Decodable, Identifiable {
    let id: String
    let brokerId: String
    let brokerName: String
    let brokerEmail: String
    let brokerLicense: String?
    let brokerPhone: String?
    let requestedAt: String?
    let status: String

    enum CodingKeys: String, CodingKey {
        case id
        case brokerId = "broker_id"
        case brokerName = "broker_name"
        case brokerEmail = "broker_email"
        case brokerLicense = "broker_license"
        case brokerPhone = "broker_phone"
        case requestedAt = "requested_at"
        case status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id            = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        brokerId      = (try? c.decode(String.self, forKey: .brokerId)) ?? ""
        brokerName    = (try? c.decode(String.self, forKey: .brokerName)) ?? "—"
        brokerEmail   = (try? c.decode(String.self, forKey: .brokerEmail)) ?? ""
        brokerLicense = try? c.decode(String.self, forKey: .brokerLicense)
        brokerPhone   = try? c.decode(String.self, forKey: .brokerPhone)
        requestedAt   = try? c.decode(String.self, forKey: .requestedAt)
        status        = (try? c.decode(String.self, forKey: .status)) ?? "pending"
    }
}

struct TeamResponse: Decodable {
    var brokers: [TeamBroker]
    let pendingRequests: [JoinRequest]

    enum CodingKeys: String, CodingKey {
        case brokers
        case pendingRequests = "pending_requests"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        brokers         = (try? c.decode([TeamBroker].self, forKey: .brokers)) ?? []
        pendingRequests = (try? c.decode([JoinRequest].self, forKey: .pendingRequests)) ?? []
    }
}

struct BrokerDetail: Decodable {
    let id: String
    let name: String
    let email: String
    let phone: String?
    let licenseNumber: String?
    let role: String?
    let jobTitle: String?
    let teamTitle: String?
    let accessLevel: Int
    let joinedAt: String?
    let emailVerified: Bool?
    let appCount: Int
    let notes: String?
    let recentApps: [BrokerApp]

    enum CodingKeys: String, CodingKey {
        case id, name, email, phone, role, notes
        case licenseNumber = "licenseNumber"
        case jobTitle = "jobTitle"
        case teamTitle = "team_title"
        case accessLevel = "access_level"
        case joinedAt = "joined_at"
        case emailVerified = "emailVerified"
        case appCount = "app_count"
        case recentApps = "recent_apps"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id            = (try? c.decode(String.self, forKey: .id)) ?? ""
        name          = (try? c.decode(String.self, forKey: .name)) ?? "—"
        email         = (try? c.decode(String.self, forKey: .email)) ?? ""
        phone         = try? c.decode(String.self, forKey: .phone)
        licenseNumber = try? c.decode(String.self, forKey: .licenseNumber)
        role          = try? c.decode(String.self, forKey: .role)
        jobTitle      = try? c.decode(String.self, forKey: .jobTitle)
        teamTitle     = try? c.decode(String.self, forKey: .teamTitle)
        accessLevel   = (try? c.decode(Int.self, forKey: .accessLevel)) ?? 1
        joinedAt      = try? c.decode(String.self, forKey: .joinedAt)
        emailVerified = try? c.decode(Bool.self, forKey: .emailVerified)
        appCount      = (try? c.decode(Int.self, forKey: .appCount)) ?? 0
        notes         = try? c.decode(String.self, forKey: .notes)
        recentApps    = (try? c.decode([BrokerApp].self, forKey: .recentApps)) ?? []
    }

    // Memberwise init for fallback
    init(id: String, name: String, email: String, phone: String?,
         licenseNumber: String?, role: String?, jobTitle: String?,
         teamTitle: String? = nil, accessLevel: Int = 1,
         joinedAt: String?, emailVerified: Bool?,
         appCount: Int, notes: String?, recentApps: [BrokerApp]) {
        self.id = id; self.name = name; self.email = email; self.phone = phone
        self.licenseNumber = licenseNumber; self.role = role; self.jobTitle = jobTitle
        self.teamTitle = teamTitle; self.accessLevel = accessLevel
        self.joinedAt = joinedAt; self.emailVerified = emailVerified
        self.appCount = appCount; self.notes = notes; self.recentApps = recentApps
    }

    static func fallback(from b: TeamBroker) -> BrokerDetail {
        BrokerDetail(
            id: b.id, name: b.name, email: b.email, phone: b.phone,
            licenseNumber: b.licenseNumber, role: nil, jobTitle: b.jobTitle,
            teamTitle: b.teamTitle, accessLevel: b.accessLevel,
            joinedAt: b.joinedAt, emailVerified: b.emailVerified,
            appCount: b.appCount, notes: nil, recentApps: []
        )
    }

}

struct BrokerApp: Decodable, Identifiable {
    let id: String
    let title: String?
    let status: String?
    let updatedAt: String?
    let clientName: String?

    enum CodingKeys: String, CodingKey {
        case id, title, status
        case updatedAt = "updated_at"
        case clientName = "client_name"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id         = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title      = try? c.decode(String.self, forKey: .title)
        status     = try? c.decode(String.self, forKey: .status)
        updatedAt  = try? c.decode(String.self, forKey: .updatedAt)
        // Handle nested client object
        if let clientDict = try? c.decode([String: String].self, forKey: .clientName) {
            clientName = clientDict["name"]
        } else {
            clientName = try? c.decode(String.self, forKey: .clientName)
        }
    }
}

// MARK: - Listing Analytics

struct ListingAnalyticsSummary: Decodable {
    let totalListings: Int
    let totalViews: Int
    let totalTours: Int
    let totalFavorites: Int
    let viewsTrend: [ViewDay]
    let topPerforming: [ListingAnalyticsItem]

    enum CodingKeys: String, CodingKey {
        case totalListings = "total_listings"
        case totalViews = "total_views"
        case totalTours = "total_tours"
        case totalFavorites = "total_favorites"
        case viewsTrend = "views_trend"
        case topPerforming = "top_performing"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalListings  = (try? c.decode(Int.self, forKey: .totalListings)) ?? 0
        totalViews     = (try? c.decode(Int.self, forKey: .totalViews)) ?? 0
        totalTours     = (try? c.decode(Int.self, forKey: .totalTours)) ?? 0
        totalFavorites = (try? c.decode(Int.self, forKey: .totalFavorites)) ?? 0
        viewsTrend     = (try? c.decode([ViewDay].self, forKey: .viewsTrend)) ?? []
        topPerforming  = (try? c.decode([ListingAnalyticsItem].self, forKey: .topPerforming)) ?? []
    }
}

struct ViewDay: Decodable {
    let date: String
    let views: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date  = (try? c.decode(String.self, forKey: .date)) ?? ""
        views = (try? c.decode(Int.self, forKey: .views)) ?? 0
    }
    enum CodingKeys: String, CodingKey { case date, views }
}

struct ListingAnalyticsItem: Decodable, Identifiable {
    let id: String
    let title: String
    let city: String
    let province: String
    let price: String
    let image: String?
    let views: Int
    let tours: Int
    let favorites: Int
    let daysOnMarket: Int
    let conversion: String
    let type: String?
    let condition: String?
    let bedrooms: String?
    let bathrooms: String?

    enum CodingKeys: String, CodingKey {
        case id, title, city, province, price, image, views, tours, favorites
        case daysOnMarket = "days_on_market"
        case conversion, type, condition, bedrooms, bathrooms
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id           = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title        = (try? c.decode(String.self, forKey: .title)) ?? ""
        city         = (try? c.decode(String.self, forKey: .city)) ?? ""
        province     = (try? c.decode(String.self, forKey: .province)) ?? ""
        price        = (try? c.decode(String.self, forKey: .price)) ?? "0"
        image        = try? c.decode(String.self, forKey: .image)
        views        = (try? c.decode(Int.self, forKey: .views)) ?? 0
        tours        = (try? c.decode(Int.self, forKey: .tours)) ?? 0
        favorites    = (try? c.decode(Int.self, forKey: .favorites)) ?? 0
        daysOnMarket = (try? c.decode(Int.self, forKey: .daysOnMarket)) ?? 0
        conversion   = (try? c.decode(String.self, forKey: .conversion)) ?? "0.0"
        type         = try? c.decode(String.self, forKey: .type)
        condition    = try? c.decode(String.self, forKey: .condition)
        bedrooms     = try? c.decode(String.self, forKey: .bedrooms)
        bathrooms    = try? c.decode(String.self, forKey: .bathrooms)
    }

    var priceFormatted: String {
        let n = Double(price) ?? 0
        if n >= 1_000_000 { return String(format: "$%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "$%.0fK", n / 1_000) }
        return String(format: "$%.0f", n)
    }
}

struct ListingAnalyticsListResponse: Decodable {
    let listings: [ListingAnalyticsItem]
}

struct ListingAnalyticsDetail: Decodable {
    let id: String
    let title: String
    let city: String
    let province: String
    let price: String
    let image: String?
    let views: Int
    let toursCount: Int
    let favorites: Int
    let daysOnMarket: Int
    let conversion: String
    let viewsTrend: [ViewDay]
    let tourStatus: TourStatusBreakdown

    enum CodingKeys: String, CodingKey {
        case id, title, city, province, price, image, views, favorites, conversion
        case toursCount = "tours_count"
        case daysOnMarket = "days_on_market"
        case viewsTrend = "views_trend"
        case tourStatus = "tour_status"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id           = (try? c.decode(String.self, forKey: .id)) ?? ""
        title        = (try? c.decode(String.self, forKey: .title)) ?? ""
        city         = (try? c.decode(String.self, forKey: .city)) ?? ""
        province     = (try? c.decode(String.self, forKey: .province)) ?? ""
        price        = (try? c.decode(String.self, forKey: .price)) ?? "0"
        image        = try? c.decode(String.self, forKey: .image)
        views        = (try? c.decode(Int.self, forKey: .views)) ?? 0
        toursCount   = (try? c.decode(Int.self, forKey: .toursCount)) ?? 0
        favorites    = (try? c.decode(Int.self, forKey: .favorites)) ?? 0
        daysOnMarket = (try? c.decode(Int.self, forKey: .daysOnMarket)) ?? 0
        conversion   = (try? c.decode(String.self, forKey: .conversion)) ?? "0.0"
        viewsTrend   = (try? c.decode([ViewDay].self, forKey: .viewsTrend)) ?? []
        tourStatus   = (try? c.decode(TourStatusBreakdown.self, forKey: .tourStatus)) ?? TourStatusBreakdown()
    }
}

struct TourStatusBreakdown: Decodable {
    var pending: Int = 0
    var confirmed: Int = 0
    var completed: Int = 0
    var cancelled: Int = 0
}

// MARK: - Contact Timeline CRM

struct ContactsResponse: Decodable {
    let contacts: [ContactSummary]
    let total: Int
}

struct ContactSummary: Decodable, Identifiable {
    let id: String
    let name: String
    let email: String?
    let phone: String?
    let interactions: Int?
    let lastInteraction: String?
    let firstInteraction: String?

    var initials: String {
        name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased()
    }

    var lastInteractionAgo: String {
        guard let ts = lastInteraction else { return "" }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: ts)
        if date == nil { fmt.formatOptions = [.withInternetDateTime]; date = fmt.date(from: ts) }
        guard let d = date else { return "" }
        let diff = Calendar.current.dateComponents([.day, .hour, .minute], from: d, to: Date())
        if let days = diff.day, days > 0 { return "hace \(days)d" }
        if let hrs = diff.hour, hrs > 0 { return "hace \(hrs)h" }
        if let mins = diff.minute, mins > 0 { return "hace \(mins)m" }
        return "ahora"
    }
}

struct ContactTimelineResponse: Decodable {
    let contact: ContactSummary
    let events: [TimelineEvent]
}

struct TimelineEvent: Decodable, Identifiable {
    let id: String
    let type: String
    let timestamp: String?
    let title: String
    let subtitle: String?
    let icon: String?
    let color: String?
    let refId: String?
    let status: String?
    let messageCount: Int?
    let lastMessage: String?
    let tourDate: String?
    let tourTime: String?
    let tourType: String?

    var iconName: String { icon ?? "circle.fill" }

    var iconColor: Color {
        guard let hex = color else { return .secondary }
        return Color(hex: hex)
    }

    var timeAgo: String {
        guard let ts = timestamp else { return "" }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: ts)
        if date == nil { fmt.formatOptions = [.withInternetDateTime]; date = fmt.date(from: ts) }
        guard let d = date else { return "" }
        let diff = Calendar.current.dateComponents([.day, .hour, .minute], from: d, to: Date())
        if let days = diff.day, days > 0 { return "hace \(days)d" }
        if let hrs = diff.hour, hrs > 0 { return "hace \(hrs)h" }
        if let mins = diff.minute, mins > 0 { return "hace \(mins)m" }
        return "ahora"
    }

    var formattedDate: String {
        guard let ts = timestamp else { return "" }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: ts)
        if date == nil { fmt.formatOptions = [.withInternetDateTime]; date = fmt.date(from: ts) }
        guard let d = date else { return "" }
        let df = DateFormatter()
        df.locale = Locale(identifier: "es_DO")
        df.dateFormat = "d MMM, h:mm a"
        return df.string(from: d)
    }
}

// Hex color extension
extension Color {
    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: h).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

// MARK: - Payments Summary

struct PaymentsSummaryResponse: Decodable {
    let stats: PaymentStats
    let payments: [PaymentItem]
    let total: Int
}

struct PaymentStats: Decodable {
    let overdue: Int
    let dueSoon: Int
    let pendingReview: Int
    let approvedMonth: Int
    let totalPending: Double
}

struct PaymentItem: Decodable, Identifiable {
    let id: String
    let applicationId: String?
    let installmentId: String?
    let clientName: String?
    let clientEmail: String?
    let listingTitle: String?
    let listingId: String?
    let amount: Double?
    let currency: String?
    let dueDate: String?
    let daysUntilDue: Int?
    let status: String?
    let installmentNumber: Int?
    let installmentLabel: String?
    let proofUploaded: Bool?
    let proofUploadedAt: String?
    let reviewedAt: String?
    let reviewNotes: String?
    let reminderSent: Bool?
    let reminderSentAt: String?
    let paymentMethod: String?
    let type: String? // "single" or "installment"

    var formattedAmount: String {
        let cur = currency ?? "DOP"
        let amt = amount ?? 0
        return "\(cur) $\(amt.formatted(.number.grouping(.automatic)))"
    }

    var formattedDueDate: String {
        guard let ds = dueDate else { return "—" }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: ds)
        if date == nil { fmt.formatOptions = [.withInternetDateTime]; date = fmt.date(from: ds) }
        guard let d = date else { return ds }
        let df = DateFormatter()
        df.locale = Locale(identifier: "es_DO")
        df.dateFormat = "d MMM yyyy"
        return df.string(from: d)
    }

    var isOverdue: Bool {
        guard let d = daysUntilDue else { return false }
        return d < 0 && status == "pending"
    }

    var isDueSoon: Bool {
        guard let d = daysUntilDue else { return false }
        return d >= 0 && d <= 7 && status == "pending"
    }

    var statusLabel: String {
        switch status {
        case "pending": return isOverdue ? "Vencido" : "Pendiente"
        case "proof_uploaded": return "En revision"
        case "approved": return "Aprobado"
        case "rejected": return "Rechazado"
        default: return status?.capitalized ?? "—"
        }
    }

    var statusColor: Color {
        switch status {
        case "pending": return isOverdue ? .rdRed : .orange
        case "proof_uploaded": return .rdBlue
        case "approved": return .rdGreen
        case "rejected": return .rdRed
        default: return .secondary
        }
    }
}

import SwiftUI
