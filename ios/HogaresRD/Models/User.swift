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

    var firstName: String { name.components(separatedBy: " ").first ?? name }

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
    var isAgency: Bool { role == "agency" || role == "broker" || role == "inmobiliaria" || role == "secretary" }
    var isInmobiliaria: Bool { role == "inmobiliaria" }
    var isBroker: Bool { role == "broker" || role == "agency" }
    var isSecretary: Bool { role == "secretary" }
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
