import Foundation

struct User: Codable {
    let id: String
    let name: String
    let email: String
    let role: String
    let agencyName: String?
    let marketingOptIn: Bool?

    var firstName: String { name.components(separatedBy: " ").first ?? name }
    var initials: String {
        name.components(separatedBy: " ")
            .prefix(2)
            .compactMap { $0.first }
            .map { String($0) }
            .joined()
            .uppercased()
    }
    var isAgency: Bool { role == "agency" || role == "broker" || role == "inmobiliaria" }
    var isInmobiliaria: Bool { role == "inmobiliaria" }
    var isBroker: Bool { role == "broker" || role == "agency" }
}

struct AuthResponse: Codable {
    let token: String
    let user: User
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
