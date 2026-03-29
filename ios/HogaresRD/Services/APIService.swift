import Foundation

// Change to "http://localhost:3000" for local development
let apiBase = "https://hogaresrd.com"

// MARK: - APIService

class APIService: ObservableObject {
    static let shared = APIService()
    static let baseURL = apiBase

    @Published var currentUser: User?
    @Published var token: String?

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    private init() {
        if let data = UserDefaults.standard.data(forKey: "rd_user"),
           let user = try? decoder.decode(User.self, from: data) {
            currentUser = user
        }
        token = UserDefaults.standard.string(forKey: "rd_token")
    }

    // MARK: - Listings

    func getListings(
        type: String? = nil,
        condition: String? = nil,
        province: String? = nil,
        city: String? = nil,
        limit: Int = 12,
        page: Int = 1
    ) async throws -> ListingsResponse {
        var components = URLComponents(string: "\(apiBase)/api/listings")!
        var items: [URLQueryItem] = [
            URLQueryItem(name: "limit", value: "\(limit)"),
            URLQueryItem(name: "page",  value: "\(page)")
        ]
        if let t = type      { items.append(.init(name: "type",      value: t)) }
        if let c = condition { items.append(.init(name: "condition",  value: c)) }
        if let p = province  { items.append(.init(name: "province",  value: p)) }
        if let ci = city     { items.append(.init(name: "city",      value: ci)) }
        components.queryItems = items
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        return try decoder.decode(ListingsResponse.self, from: data)
    }

    func getListing(id: String) async throws -> Listing {
        let url = URL(string: "\(apiBase)/api/listings/\(id)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try decoder.decode(Listing.self, from: data)
    }

    // MARK: - Auth

    func login(email: String, password: String) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/login")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error de inicio de sesión")
        }
        let auth = try decoder.decode(AuthResponse.self, from: data)
        await persist(user: auth.user, token: auth.token)
        return auth.user
    }

    // Register user → server returns {success, user} (no token), so we login afterwards
    func register(name: String, email: String, password: String, marketingOptIn: Bool) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/register")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "name": name, "email": email, "password": password,
            "marketingOptIn": marketingOptIn
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta")
        }
        // Auto-login after registration to obtain token
        return try await login(email: email, password: password)
    }

    func registerAgency(name: String, email: String, password: String,
                        phone: String, agencyName: String, licenseNumber: String) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/register/agency")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "name": name, "email": email, "password": password,
            "phone": phone, "agencyName": agencyName, "licenseNumber": licenseNumber
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de agente")
        }
        return try await login(email: email, password: password)
    }

    func logout() {
        currentUser = nil
        token = nil
        UserDefaults.standard.removeObject(forKey: "rd_user")
        UserDefaults.standard.removeObject(forKey: "rd_token")
    }

    // MARK: - Agencies

    func getAgency(slug: String, page: Int = 1) async throws -> AgencyDetail {
        var comps = URLComponents(string: "\(apiBase)/api/agencies/\(slug)")!
        comps.queryItems = [
            URLQueryItem(name: "page",  value: "\(page)"),
            URLQueryItem(name: "limit", value: "12")
        ]
        let (data, _) = try await URLSession.shared.data(from: comps.url!)
        return try decoder.decode(AgencyDetail.self, from: data)
    }

    func getAgencies() async throws -> [Inmobiliaria] {
        let url = URL(string: "\(apiBase)/api/listings/agencies")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return (try decoder.decode(AgenciesResponse.self, from: data)).agencies
    }

    // MARK: - Inquiry

    func sendInquiry(listingId: String, name: String, email: String, phone: String, message: String) async throws {
        let url = URL(string: "\(apiBase)/api/listings/\(listingId)/inquiry")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "name": name, "email": email, "phone": phone, "message": message
        ]
        req.httpBody = try JSONEncoder().encode(body)
        _ = try await URLSession.shared.data(for: req)
    }

    // MARK: - Submit Listing

    func submitListing(_ body: [String: Any]) async throws {
        let url = URL(string: "\(apiBase)/submit")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar la propiedad")
        }
    }

    // MARK: - Private

    @MainActor
    private func persist(user: User, token: String) {
        self.currentUser = user
        self.token = token
        UserDefaults.standard.set(try? JSONEncoder().encode(user), forKey: "rd_user")
        UserDefaults.standard.set(token, forKey: "rd_token")
    }
}

struct AgencyDetail: Decodable {
    let name: String
    let slug: String
    let listings: [Listing]
    let total: Int
    let pages: Int

    private enum CodingKeys: String, CodingKey { case name, slug, listings, total, pages }

    init(from decoder: Decoder) throws {
        let c  = try decoder.container(keyedBy: CodingKeys.self)
        name   = try c.decode(String.self, forKey: .name)
        slug   = try c.decode(String.self, forKey: .slug)
        total  = try c.decode(Int.self,    forKey: .total)
        pages  = try c.decode(Int.self,    forKey: .pages)
        listings = (try? c.decode([Safe<Listing>].self, forKey: .listings))?.compactMap { $0.value } ?? []
    }
}

enum APIError: LocalizedError {
    case server(String)
    var errorDescription: String? {
        if case .server(let msg) = self { return msg }
        return "Error desconocido"
    }
}
