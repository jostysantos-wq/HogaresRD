import Foundation

struct User: Codable {
    let id: String
    let name: String
    let email: String
    let role: String
    let phone: String?
    let agencyName: String?
    let marketingOptIn: Bool?
    let twoFAEnabled: Bool?
    let twoFAMethod: String?
    let avatarUrl: String?
    let refToken: String?
    let access_level: Int?
    let team_title: String?
    let emailVerified: Bool?
    let createdAt: String?
    let subscriptionStatus: String?
    let trialEndsAt: String?

    var firstName: String { name.components(separatedBy: " ").first ?? name }

    var isEmailVerified: Bool { emailVerified ?? false }
    var isOnTrial: Bool { subscriptionStatus == "trial" }

    var trialDaysRemaining: Int? {
        guard let endStr = trialEndsAt else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var end = fmt.date(from: endStr)
        if end == nil {
            fmt.formatOptions = [.withInternetDateTime]
            end = fmt.date(from: endStr)
        }
        guard let endDate = end else { return nil }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: endDate).day ?? 0
        return max(0, days)
    }

    /// Full URL to the avatar image, or nil if not set.
    var avatarImageURL: URL? {
        guard let path = avatarUrl, !path.isEmpty else { return nil }
        if path.hasPrefix("http") { return URL(string: path) }
        return URL(string: "\(APIService.baseURL)\(path)")
    }
    var initials: String {
        name.components(separatedBy: " ")
            .prefix(2)
            .compactMap { $0.first }
            .map { String($0) }
            .joined()
            .uppercased()
    }
    var isAgency: Bool { role == "agency" || role == "broker" || role == "inmobiliaria" || role == "constructora" || role == "secretary" }
    var isInmobiliaria: Bool { role == "inmobiliaria" || role == "constructora" }
    var isConstructora: Bool { role == "constructora" }
    var isTeamLead: Bool { role == "inmobiliaria" || role == "constructora" }
    var isBroker: Bool { role == "broker" || role == "agency" }
    var isSecretary: Bool { role == "secretary" }

    /// Effective access level: owner=3, team member=stored or 1
    var effectiveAccessLevel: Int {
        if isTeamLead { return 3 }
        return access_level ?? 1
    }
    var canViewTeam: Bool { effectiveAccessLevel >= 2 }
    var canManageTeam: Bool { effectiveAccessLevel >= 3 }
    var canApprovePayments: Bool { effectiveAccessLevel >= 2 }
}

struct MyAccessResponse: Codable {
    let access_level: Int
    let access_label: String?
    let team_title: String?
    let inmobiliaria_id: String?
    let role: String
}

struct AuthResponse: Codable {
    let token: String
    let user: User
}

struct LoginResponse: Decodable {
    let token: String?
    let user: User?
    let requires2FA: Bool?
    let twoFASessionId: String?
    let method: String?
}

enum LoginResult {
    case success(User)
    case requires2FA(sessionId: String, method: String)
}

struct Inmobiliaria: Codable, Identifiable {
    var id: String { slug }
    let name: String
    let slug: String
    let count: Int

    var initials: String {
        name.components(separatedBy: " ")
            .prefix(3)
            .compactMap { $0.first }
            .map { String($0) }
            .joined()
            .uppercased()
    }
}

struct AgenciesResponse: Codable {
    let agencies: [Inmobiliaria]
}
