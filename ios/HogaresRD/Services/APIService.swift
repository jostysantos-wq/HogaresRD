import Foundation

// Change to "http://localhost:3000" for local development
let apiBase = "https://hogaresrd.com"

// MARK: - Simple In-Memory Cache

private final class ResponseCache {
    static let shared = ResponseCache()
    private var store: [String: (data: Any, expires: Date)] = [:]
    private let lock = NSLock()

    func get<T>(_ key: String) -> T? {
        lock.lock(); defer { lock.unlock() }
        guard let entry = store[key], Date() < entry.expires else {
            store.removeValue(forKey: key)
            return nil
        }
        return entry.data as? T
    }

    func set(_ key: String, value: Any, ttl: TimeInterval = 120) {
        lock.lock(); defer { lock.unlock() }
        store[key] = (data: value, expires: Date().addingTimeInterval(ttl))
    }

    func invalidate(_ prefix: String) {
        lock.lock(); defer { lock.unlock() }
        store = store.filter { !$0.key.hasPrefix(prefix) }
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        store.removeAll()
    }
}

// MARK: - APIService

class APIService: ObservableObject {
    static let shared = APIService()
    static let baseURL = apiBase

    @Published var currentUser: User?
    @Published var token: String?

    private let cache = ResponseCache.shared

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    /// Custom URLSession with tuned timeouts and cache policy
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.urlCache = {
            let cache = URLCache(memoryCapacity: 20 * 1024 * 1024,  // 20MB memory
                                 diskCapacity: 50 * 1024 * 1024)     // 50MB disk
            return cache
        }()
        return URLSession(configuration: config)
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
        let cacheKey = "listings:\(components.url!.absoluteString)"
        if let cached: ListingsResponse = cache.get(cacheKey) { return cached }
        let (data, _) = try await session.data(from: components.url!)
        let result = try decoder.decode(ListingsResponse.self, from: data)
        cache.set(cacheKey, value: result, ttl: 60) // 1 min cache
        return result
    }

    func getListing(id: String) async throws -> Listing {
        let cacheKey = "listing:\(id)"
        if let cached: Listing = cache.get(cacheKey) { return cached }
        let url = URL(string: "\(apiBase)/api/listings/\(id)")!
        let (data, _) = try await session.data(from: url)
        let result = try decoder.decode(Listing.self, from: data)
        cache.set(cacheKey, value: result, ttl: 300) // 5 min cache
        return result
    }

    // MARK: - Ads

    func fetchActiveAds() async -> [Ad] {
        if let cached: [Ad] = cache.get("ads:active") { return cached }
        guard let url = URL(string: "\(apiBase)/api/ads/active") else { return [] }
        guard let (data, _) = try? await session.data(from: url) else { return [] }
        let ads = (try? decoder.decode([Ad].self, from: data)) ?? []
        cache.set("ads:active", value: ads, ttl: 300) // 5 min cache
        return ads
    }

    /// Fire-and-forget view tracking — matches web's listing.html POST
    /// /api/listings/:id/view so broker analytics count iOS views too.
    func trackListingView(_ listingId: String) {
        guard let url = URL(string: "\(apiBase)/api/listings/\(listingId)/view") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        session.dataTask(with: req).resume()
    }

    func trackAdImpression(_ adID: String) {
        guard let url = URL(string: "\(apiBase)/api/ads/\(adID)/impression") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        session.dataTask(with: req).resume()
    }

    // MARK: - Leads

    func submitLead(
        listing:  Listing,
        name:     String, phone: String, email:    String,
        intent:   String, timeline: String,
        financing: String, preApproved: Bool,
        contactMethod: String,
        budget:   String, notes:  String
    ) async -> Bool {
        guard let url = URL(string: "\(apiBase)/api/leads") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let agencies = (listing.agencies ?? []).map { ["name": $0.name ?? "", "email": $0.email ?? ""] }
        let body: [String: Any] = [
            "listing_id":    listing.id,
            "listing_title": listing.title,
            "listing_price": listing.price,
            "listing_type":  listing.type,
            "agencies":      agencies,
            "name":     name,  "phone": phone, "email":    email,
            "intent":   intent, "timeline": timeline,
            "financing": financing, "pre_approved": preApproved,
            "contact_method": contactMethod,
            "budget":   budget, "notes":   notes
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, _) = try? await session.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["ok"] as? Bool == true else { return false }
        return true
    }

    func trackAdClick(_ adID: String) {
        guard let url = URL(string: "\(apiBase)/api/ads/\(adID)/click") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        session.dataTask(with: req).resume()
    }

    // MARK: - Auth

    /// Request a password-reset email. Server always returns 200 regardless
    /// of whether the email exists (to avoid leaking which addresses are
    /// registered). So this method is fire-and-forget from the user's POV.
    func forgotPassword(email: String) async throws {
        let url = URL(string: "\(apiBase)/api/auth/forgot-password")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email])
        let (_, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 500 {
            throw APIError.server("No se pudo enviar el correo. Intenta más tarde.")
        }
    }

    func login(email: String, password: String) async throws -> LoginResult {
        let url = URL(string: "\(apiBase)/api/auth/login")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error de inicio de sesión")
        }
        let loginResp = try decoder.decode(LoginResponse.self, from: data)
        if loginResp.requires2FA == true, let sid = loginResp.twoFASessionId {
            return .requires2FA(sessionId: sid, method: loginResp.method ?? "email")
        }
        guard let user = loginResp.user, let token = loginResp.token else {
            throw APIError.server("Respuesta inesperada")
        }
        await persist(user: user, token: token)
        return .success(user)
    }

    // Sign in with Apple
    func loginWithApple(identityToken: String, name: String?, email: String?) async throws {
        let url = URL(string: "\(apiBase)/api/auth/apple")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["identityToken": identityToken]
        if let n = name { body["name"] = n }
        if let e = email { body["email"] = e }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error con Apple Sign In")
        }
        let loginResp = try decoder.decode(LoginResponse.self, from: data)
        guard let user = loginResp.user, let token = loginResp.token else {
            throw APIError.server("Respuesta inesperada")
        }
        await persist(user: user, token: token)
    }

    // Sync Apple subscription with server (upgrade/downgrade role)
    func syncAppleSubscription(productID: String, transactionID: String, originalTransactionID: String, role: String, expirationDate: String?) async throws {
        let url = URL(string: "\(apiBase)/api/auth/apple-subscription")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        var body: [String: String] = [
            "productID": productID,
            "transactionID": transactionID,
            "originalTransactionID": originalTransactionID,
            "role": role,
        ]
        if let exp = expirationDate { body["expirationDate"] = exp }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
            // Update local user with new role
            if let loginResp = try? decoder.decode(LoginResponse.self, from: data),
               let user = loginResp.user, let token = loginResp.token {
                await persist(user: user, token: token)
            }
        }
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
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta")
        }
        // Auto-login after registration to obtain token
        let result = try await login(email: email, password: password)
        if case .success(let user) = result { return user }
        throw APIError.server("Registro exitoso pero requiere 2FA. Inicia sesión.")
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
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de agente")
        }
        let result = try await login(email: email, password: password)
        if case .success(let user) = result { return user }
        throw APIError.server("Registro exitoso pero requiere 2FA. Inicia sesión.")
    }

    func registerBroker(name: String, email: String, password: String,
                        phone: String, licenseNumber: String,
                        jobTitle: String? = nil) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/register/broker")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "name": name, "email": email, "password": password,
            "phone": phone, "licenseNumber": licenseNumber
        ]
        if let jobTitle { body["jobTitle"] = jobTitle }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de broker")
        }
        let result = try await login(email: email, password: password)
        if case .success(let user) = result { return user }
        throw APIError.server("Registro exitoso pero requiere 2FA. Inicia sesión.")
    }

    func registerInmobiliaria(name: String, email: String, password: String,
                              phone: String, companyName: String, licenseNumber: String) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/register/inmobiliaria")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "name": name, "email": email, "password": password,
            "phone": phone, "companyName": companyName, "licenseNumber": licenseNumber
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de inmobiliaria")
        }
        let result = try await login(email: email, password: password)
        if case .success(let user) = result { return user }
        throw APIError.server("Registro exitoso pero requiere 2FA. Inicia sesion.")
    }

    func registerConstructora(name: String, email: String, password: String,
                              phone: String, companyName: String,
                              yearsExperience: String) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/register/constructora")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "name": name, "email": email, "password": password,
            "phone": phone, "companyName": companyName,
            "yearsExperience": yearsExperience
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de constructora")
        }
        let loginResult = try await login(email: email, password: password)
        if case .success(let user) = loginResult { return user }
        throw APIError.server("Registro exitoso pero requiere 2FA. Inicia sesion.")
    }

    /// Refresh user profile from server — updates emailVerified, subscription status, etc.
    func refreshUser() async {
        guard let t = token else { return }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/me")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let user = try? decoder.decode(User.self, from: data) else { return }
        await MainActor.run {
            self.currentUser = user
            UserDefaults.standard.set(try? JSONEncoder().encode(user), forKey: "rd_user")
        }
    }

    func resendVerificationEmail() async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/resend-verification")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.server("Error al reenviar verificacion")
        }
    }

    func deleteAccount() async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/delete-account")!)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.server("Error al eliminar cuenta")
        }
    }

    func logout() {
        currentUser = nil
        token = nil
        UserDefaults.standard.removeObject(forKey: "rd_user")
        UserDefaults.standard.removeObject(forKey: "rd_token")
        cache.clear() // Flush cached API responses
        session.configuration.urlCache?.removeAllCachedResponses()
        Task { @MainActor in SavedStore.shared.clearLocal() }
    }

    // MARK: - Agencies

    func getAgency(slug: String, page: Int = 1) async throws -> AgencyDetail {
        var comps = URLComponents(string: "\(apiBase)/api/agencies/\(slug)")!
        comps.queryItems = [
            URLQueryItem(name: "page",  value: "\(page)"),
            URLQueryItem(name: "limit", value: "12")
        ]
        let (data, _) = try await session.data(from: comps.url!)
        return try decoder.decode(AgencyDetail.self, from: data)
    }

    func getAgencies() async throws -> [Inmobiliaria] {
        let url = URL(string: "\(apiBase)/api/listings/agencies")!
        let (data, _) = try await session.data(from: url)
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
        _ = try await session.data(for: req)
    }

    // MARK: - Tours

    func fetchAvailableSlots(brokerId: String, date: String) async throws -> [AvailableSlot] {
        let url = URL(string: "\(Self.baseURL)/api/tours/availability/\(brokerId)?date=\(date)")!
        let (data, _) = try await session.data(from: url)
        return try JSONDecoder().decode(AvailableSlotsResponse.self, from: data).slots
    }

    func fetchSchedule(brokerId: String, month: String) async throws -> [String] {
        let url = URL(string: "\(Self.baseURL)/api/tours/schedule/\(brokerId)?month=\(month)")!
        let (data, _) = try await session.data(from: url)
        return try JSONDecoder().decode(ScheduleResponse.self, from: data).available_dates
    }

    func requestTour(listingId: String, brokerId: String, date: String, time: String,
                     name: String, phone: String, email: String, notes: String,
                     tourType: String = "presencial") async throws -> TourRequest {
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/request")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let body: [String: String] = [
            "listing_id": listingId, "broker_id": brokerId, "date": date,
            "time": time, "name": name, "phone": phone, "email": email, "notes": notes,
            "tour_type": tourType
        ]
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode == 409 {
            throw APIError.server("Este horario ya no está disponible.")
        }
        return try JSONDecoder().decode(TourRequest.self, from: data)
    }

    func fetchMyTourRequests() async throws -> [TourRequest] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/my-requests")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder().decode([TourRequest].self, from: data)
    }

    func fetchBrokerTourRequests() async throws -> [TourRequest] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-requests")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder().decode([TourRequest].self, from: data)
    }

    func updateTourStatus(tourId: String, status: String, notes: String? = nil) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/\(tourId)/status")!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        var body: [String: String] = ["status": status]
        if let n = notes { body["notes"] = n }
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al actualizar visita")
        }
    }

    func cancelTour(tourId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/\(tourId)/cancel")!)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al cancelar visita")
        }
    }

    func completeTour(tourId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/\(tourId)/complete")!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al completar visita")
        }
    }

    func rescheduleTour(tourId: String, date: String, time: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/\(tourId)/reschedule")!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: String] = ["date": date, "time": time]
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al reprogramar visita")
        }
    }

    func submitTourFeedback(tourId: String, rating: Int, comment: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/\(tourId)/feedback")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["rating": rating, "comment": comment]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al enviar calificación")
        }
    }

    func fetchTourSettings() async throws -> [String: Bool] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/settings")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder().decode([String: Bool].self, from: data)
    }

    func updateAutoConfirmTours(enabled: Bool) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/settings/auto-confirm")!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body = ["enabled": enabled]
        req.httpBody = try JSONEncoder().encode(body)
        let (_, resp) = try await session.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al actualizar configuración")
        }
    }

    func fetchBrokerAvailability() async throws -> BrokerAvailabilityResponse {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder().decode(BrokerAvailabilityResponse.self, from: data)
    }

    func saveBrokerAvailability(dayOfWeek: Int, startTime: String, endTime: String, duration: Int = 30) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "day_of_week": dayOfWeek, "start_time": startTime,
            "end_time": endTime, "slot_duration_min": duration
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await session.data(for: req)
    }

    func deleteBrokerAvailability(slotId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability/\(slotId)")!)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try await session.data(for: req)
    }

    func saveBrokerOverride(date: String, available: Bool) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability/override")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["date": date, "available": available]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await session.data(for: req)
    }

    func deleteBrokerOverride(overrideId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability/override/\(overrideId)")!)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try await session.data(for: req)
    }

    // MARK: - Two-Factor Authentication

    func verify2FA(sessionId: String, code: String) async throws -> User {
        let url = URL(string: "\(apiBase)/api/auth/2fa/verify")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["twoFASessionId": sessionId, "code": code]
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Codigo invalido")
        }
        let auth = try decoder.decode(AuthResponse.self, from: data)
        await persist(user: auth.user, token: auth.token)
        return auth.user
    }

    func resend2FA(sessionId: String) async throws {
        let url = URL(string: "\(apiBase)/api/auth/2fa/resend")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["twoFASessionId": sessionId])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error reenviando codigo")
        }
    }

    func enable2FA() async throws -> String {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/2fa/enable")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONEncoder().encode(["method": "email"])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error habilitando 2FA")
        }
        let result = try JSONDecoder().decode([String: String].self, from: data)
        guard let sid = result["sessionId"] else { throw APIError.server("Respuesta inesperada") }
        return sid
    }

    func confirmEnable2FA(sessionId: String, code: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/2fa/confirm-enable")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: String] = ["sessionId": sessionId, "code": code]
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Codigo invalido")
        }
    }

    func disable2FA(password: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/2fa/disable")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONEncoder().encode(["password": password])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error desactivando 2FA")
        }
    }

    func registerBiometric() async throws -> String {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/biometric/register")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error registrando biometrico")
        }
        let result = try JSONDecoder().decode([String: String].self, from: data)
        guard let bioToken = result["biometricToken"] else { throw APIError.server("Respuesta inesperada") }
        return bioToken
    }

    func loginWithBiometric(email: String, biometricToken: String) async throws -> LoginResult {
        let url = URL(string: "\(apiBase)/api/auth/biometric/login")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email, "biometricToken": biometricToken])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error de autenticacion biometrica")
        }
        let loginResp = try decoder.decode(LoginResponse.self, from: data)
        if loginResp.requires2FA == true, let sid = loginResp.twoFASessionId {
            return .requires2FA(sessionId: sid, method: loginResp.method ?? "email")
        }
        guard let user = loginResp.user, let token = loginResp.token else {
            throw APIError.server("Respuesta inesperada")
        }
        await persist(user: user, token: token)
        return .success(user)
    }

    func revokeBiometric() async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/auth/biometric/revoke")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            throw APIError.server("Error revocando biometrico")
        }
    }

    // MARK: - Listing Analytics

    func getListingAnalyticsSummary(range: String = "all") async throws -> ListingAnalyticsSummary {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/listing-analytics/summary")!
        comps.queryItems = [URLQueryItem(name: "range", value: range)]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(ListingAnalyticsSummary.self, from: data)
    }

    func getListingAnalyticsList(sort: String = "views", range: String = "all") async throws -> [ListingAnalyticsItem] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/listing-analytics/listings")!
        comps.queryItems = [
            URLQueryItem(name: "sort", value: sort),
            URLQueryItem(name: "range", value: range),
        ]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(ListingAnalyticsListResponse.self, from: data).listings
    }

    func getListingAnalyticsDetail(id: String) async throws -> ListingAnalyticsDetail {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/listing-analytics/listing/\(id)")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(ListingAnalyticsDetail.self, from: data)
    }

    // MARK: - Conversations

    func getConversations(archived: Bool = false) async throws -> [Conversation] {
        guard let t = token else { throw APIError.server("No autenticado") }
        let suffix = archived ? "?archived=true" : ""
        var req = URLRequest(url: URL(string: "\(apiBase)/api/conversations\(suffix)")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error cargando conversaciones")
        }
        return try decoder.decode([Conversation].self, from: data)
    }

    func getConversation(id: String, since: String? = nil) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/conversations/\(id)")!
        if let since = since {
            comps.queryItems = [URLQueryItem(name: "since", value: since)]
        }
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error cargando conversacion")
        }
        return try decoder.decode(Conversation.self, from: data)
    }

    func startConversation(propertyId: String, propertyTitle: String, message: String) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: String] = [
            "propertyId":    propertyId,
            "propertyTitle": propertyTitle,
            "message":       message
        ]
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al iniciar la conversación")
        }
        let result = try decoder.decode(ConversationResponse.self, from: data)
        return result.conversation
    }

    func sendMessage(conversationId: String, text: String) async throws -> ConvMessage {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations/\(conversationId)/messages")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONEncoder().encode(["text": text])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar el mensaje")
        }
        let result = try decoder.decode(SendMessageResponse.self, from: data)
        return result.message
    }

    func markConversationRead(id: String) async throws {
        guard let t = token else { return }
        let url = URL(string: "\(apiBase)/api/conversations/\(id)/read")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// Pros only (agent/broker/inmobiliaria/constructora). Closes the
    /// conversation so no further messages can be sent from either side.
    func closeConversation(id: String, reason: String) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations/\(id)/close")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["reason": reason])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
               let err = obj["error"] as? String { throw APIError.server(err) }
            throw APIError.server("No se pudo cerrar la conversación")
        }
        struct Wrapper: Decodable { let conversation: Conversation }
        return try decoder.decode(Wrapper.self, from: data).conversation
    }

    func reopenConversation(id: String) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations/\(id)/reopen")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
               let err = obj["error"] as? String { throw APIError.server(err) }
            throw APIError.server("No se pudo reabrir la conversación")
        }
        struct Wrapper: Decodable { let conversation: Conversation }
        return try decoder.decode(Wrapper.self, from: data).conversation
    }

    func claimConversation(id: String) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations/\(id)/claim")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let err = obj["error"] as? String { throw APIError.server(err) }
            throw APIError.server("Error reclamando conversación")
        }
        let result = try JSONDecoder().decode([String: Conversation].self, from: data)
        guard let conv = result["conversation"] else { throw APIError.server("Respuesta inválida") }
        return conv
    }

    func archiveConversation(id: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations/\(id)/archive")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
               let err = obj["error"] as? String { throw APIError.server(err) }
            throw APIError.server("Error archivando")
        }
    }

    func unarchiveConversation(id: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/conversations/\(id)/unarchive")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
               let err = obj["error"] as? String { throw APIError.server(err) }
            throw APIError.server("Error desarchivando")
        }
    }

    // MARK: - Applications

    func getApplications() async throws -> [Application] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/applications/my")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        // Backend returns { applications: [...] }
        if let wrapper = try? decoder.decode(ApplicationsResponse.self, from: data) {
            return wrapper.applications
        }
        return (try? decoder.decode([Application].self, from: data)) ?? []
    }

    // MARK: - Submit Listing

    func submitListing(_ body: [String: Any]) async throws {
        let url = URL(string: "\(apiBase)/submit")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar la propiedad")
        }
    }

    // MARK: - Broker Dashboard

    func getDashboardAnalytics(range: String = "30d") async throws -> DashboardAnalytics {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker/analytics")!
        comps.queryItems = [URLQueryItem(name: "range", value: range)]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(DashboardAnalytics.self, from: data)
    }

    func getDashboardSales() async throws -> DashboardSales {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/broker/sales")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(DashboardSales.self, from: data)
    }

    func getDashboardAccounting(commissionRate: Double = 0.03) async throws -> DashboardAccounting {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker/accounting")!
        comps.queryItems = [URLQueryItem(name: "commission_rate", value: "\(commissionRate)")]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(DashboardAccounting.self, from: data)
    }

    func getDashboardDocuments(status: String? = nil, type: String? = nil, search: String? = nil, page: Int = 1) async throws -> DashboardDocuments {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker/documents/archive")!
        var items: [URLQueryItem] = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "limit", value: "20")
        ]
        if let s = status { items.append(.init(name: "status", value: s)) }
        if let t = type   { items.append(.init(name: "type", value: t)) }
        if let s = search { items.append(.init(name: "search", value: s)) }
        comps.queryItems = items
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(DashboardDocuments.self, from: data)
    }

    func getDashboardAudit(search: String? = nil, type: String? = nil, page: Int = 1) async throws -> DashboardAudit {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker/audit")!
        var items: [URLQueryItem] = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "limit", value: "50")
        ]
        if let s = search { items.append(.init(name: "search", value: s)) }
        if let t = type   { items.append(.init(name: "type", value: t)) }
        comps.queryItems = items
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(DashboardAudit.self, from: data)
    }

    // MARK: - Chat IA (Claude)

    func sendChatMessage(message: String, history: [[String: String]], context: [String: Any] = [:]) async throws -> String {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/chat")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        var body: [String: Any] = [
            "message": message,
            "history": history
        ]
        if !context.isEmpty { body["context"] = context }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar mensaje")
        }
        if let json = try? JSONDecoder().decode([String: String].self, from: data),
           let reply = json["reply"] {
            return reply
        }
        throw APIError.server("Respuesta inválida del servidor")
    }

    // MARK: - Inmobiliaria Team

    func getTeamBrokers() async throws -> TeamResponse {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/brokers")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 10
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error cargando equipo")
        }
        return try decoder.decode(TeamResponse.self, from: data)
    }

    func getBrokerDetail(brokerId: String) async throws -> BrokerDetail {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/details")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 10
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error cargando detalles del agente")
        }
        return try decoder.decode(BrokerDetail.self, from: data)
    }

    func approveBroker(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/approve")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al aprobar agente")
        }
    }

    func rejectBroker(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/reject")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al rechazar agente")
        }
    }

    func removeBroker(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/remove")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al desvincular agente")
        }
    }

    // MARK: - Secretary Management

    struct SecretaryItem: Codable, Identifiable {
        let id: String
        let name: String
        let email: String
        let phone: String?
        let joinedAt: String?
    }

    struct SecretariesResponse: Codable {
        let secretaries: [SecretaryItem]
    }

    func getSecretaries() async throws -> [SecretaryItem] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/secretaries")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(SecretariesResponse.self, from: data).secretaries
    }

    func inviteSecretary(email: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/secretaries/invite")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["email": email])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar invitación")
        }
    }

    func removeSecretary(id: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/secretaries/\(id)/remove")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al remover secretaria")
        }
    }

    func saveBrokerNotes(brokerId: String, notes: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/notes")!
        var req = URLRequest(url: url)
        req.httpMethod = "PATCH"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["notes": notes])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al guardar notas")
        }
    }

    func updateTeamMemberRole(userId: String, accessLevel: Int, teamTitle: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/team/\(userId)/role")!
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["access_level": accessLevel, "team_title": teamTitle]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al asignar rol")
        }
    }

    func fetchMyAccess() async throws -> MyAccessResponse {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/my-access")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder().decode(MyAccessResponse.self, from: data)
    }

    func sendBrokerPasswordReset(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/send-reset")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar reset de contraseña")
        }
    }

    // MARK: - Reports

    func submitReport(type: String, targetId: String, targetName: String, reason: String, details: String) async throws {
        let url = URL(string: "\(apiBase)/api/reports")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let body: [String: String] = [
            "type": type, "targetId": targetId, "targetName": targetName,
            "reason": reason, "details": details,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error enviando reporte")
        }
    }

    // MARK: - Inventory

    struct InventoryResponse: Decodable {
        let inventory: [UnitInventoryItem]
        let summary: InventorySummary
    }
    struct InventorySummary: Decodable {
        let total: Int
        let available: Int
        let reserved: Int
        let sold: Int
    }

    func getInventory(listingId: String) async throws -> InventoryResponse {
        let url = URL(string: "\(apiBase)/api/inventory/\(listingId)")!
        let (data, _) = try await session.data(from: url)
        return try decoder.decode(InventoryResponse.self, from: data)
    }

    func addInventoryUnit(listingId: String, label: String, type: String, floor: String = "") async throws -> UnitInventoryItem {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inventory/\(listingId)/units")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["label": label, "type": type, "floor": floor])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error agregando unidad")
        }
        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let unitData = try JSONSerialization.data(withJSONObject: result?["unit"] ?? [:])
        return try decoder.decode(UnitInventoryItem.self, from: unitData)
    }

    func deleteInventoryUnit(listingId: String, unitId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inventory/\(listingId)/units/\(unitId)")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error eliminando unidad")
        }
    }

    func assignUnit(listingId: String, unitId: String, applicationId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inventory/\(listingId)/units/\(unitId)/assign")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["applicationId": applicationId])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error asignando unidad")
        }
    }

    func releaseUnit(listingId: String, unitId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inventory/\(listingId)/units/\(unitId)/release")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error liberando unidad")
        }
    }

    // MARK: - Tasks

    func listTasks(status: String? = nil) async throws -> [TaskItem] {
        var url = "\(apiBase)/api/tasks"
        if let s = status { url += "?status=\(s)" }
        let req = try authedRequest(URL(string: url)!)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando tareas")
        return try decoder.decode(TasksResponse.self, from: data).tasks
    }

    func completeTask(id: String) async throws {
        let url = URL(string: "\(apiBase)/api/tasks/\(id)/complete")!
        let req = try authedRequest(url, method: "POST")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error completando tarea")
    }

    func createTask(title: String, description: String, priority: String, dueDate: String?, assignedTo: String?) async throws -> TaskItem {
        let url = URL(string: "\(apiBase)/api/tasks")!
        var body: [String: Any] = [
            "title": title,
            "description": description,
            "priority": priority,
        ]
        if let d = dueDate { body["due_date"] = d }
        if let a = assignedTo, !a.isEmpty { body["assigned_to"] = a }
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "POST", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error creando tarea")
        return try decoder.decode(TaskItem.self, from: data)
    }

    // MARK: - Saved Searches

    func authedRequest(_ url: URL, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        return req
    }

    private func throwIfErr(_ data: Data, _ resp: URLResponse, fallback: String) throws {
        guard let http = resp as? HTTPURLResponse, http.statusCode >= 400 else { return }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
           let msg = obj["error"] as? String { throw APIError.server(msg) }
        throw APIError.server(fallback)
    }

    func listSavedSearches() async throws -> [SavedSearch] {
        let url = URL(string: "\(apiBase)/api/saved-searches")!
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando búsquedas")
        return try decoder.decode(SavedSearchesResponse.self, from: data).searches
    }

    func createSavedSearch(name: String, filters: SavedSearchFilters, notify: Bool) async throws -> SavedSearch {
        let url = URL(string: "\(apiBase)/api/saved-searches")!
        let body: [String: Any] = [
            "name": name,
            "filters": filtersToDict(filters),
            "notify": notify,
        ]
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "POST", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error guardando búsqueda")
        struct R: Decodable { let search: SavedSearch }
        return try decoder.decode(R.self, from: data).search
    }

    func updateSavedSearch(id: String, name: String?, filters: SavedSearchFilters?, notify: Bool?) async throws -> SavedSearch {
        let url = URL(string: "\(apiBase)/api/saved-searches/\(id)")!
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let filters { body["filters"] = filtersToDict(filters) }
        if let notify { body["notify"] = notify }
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "PUT", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error actualizando búsqueda")
        struct R: Decodable { let search: SavedSearch }
        return try decoder.decode(R.self, from: data).search
    }

    func deleteSavedSearch(id: String) async throws {
        let url = URL(string: "\(apiBase)/api/saved-searches/\(id)")!
        let req = try authedRequest(url, method: "DELETE")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error eliminando búsqueda")
    }

    func getSavedSearchResults(id: String) async throws -> SavedSearchResponse {
        let url = URL(string: "\(apiBase)/api/saved-searches/\(id)")!
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando resultados")
        return try decoder.decode(SavedSearchResponse.self, from: data)
    }

    // MARK: - Meta Ads (read-only management for iOS — creation stays on web)

    func getMetaStatus() async throws -> MetaStatusResponse {
        let url = URL(string: "\(apiBase)/api/paid-ads/meta/status")!
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando estado")
        return try decoder.decode(MetaStatusResponse.self, from: data)
    }

    func getAdCampaigns() async throws -> AdCampaignsResponse {
        let url = URL(string: "\(apiBase)/api/paid-ads/meta/campaigns")!
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando campañas")
        return try decoder.decode(AdCampaignsResponse.self, from: data)
    }

    func toggleAdCampaign(id: String) async throws {
        let url = URL(string: "\(apiBase)/api/paid-ads/meta/campaigns/\(id)/toggle-status")!
        let req = try authedRequest(url, method: "POST")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cambiando estado")
    }

    func deleteAdCampaign(id: String) async throws {
        let url = URL(string: "\(apiBase)/api/paid-ads/meta/campaigns/\(id)")!
        let req = try authedRequest(url, method: "DELETE")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error eliminando campaña")
    }

    private func filtersToDict(_ f: SavedSearchFilters) -> [String: Any] {
        var d: [String: Any] = [:]
        if let v = f.type        { d["type"] = v }
        if let v = f.condition   { d["condition"] = v }
        if let v = f.province    { d["province"] = v }
        if let v = f.city        { d["city"] = v }
        if let v = f.priceMin    { d["priceMin"] = v }
        if let v = f.priceMax    { d["priceMax"] = v }
        if let v = f.bedroomsMin { d["bedroomsMin"] = v }
        if let v = f.tags        { d["tags"] = v }
        return d
    }

    // MARK: - Favorites

    func addFavorite(listingId: String) async throws {
        guard let t = token else { return }
        let url = URL(string: "\(apiBase)/api/user/favorites/\(listingId)")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// Log a recently viewed listing. Fire-and-forget.
    func trackRecentlyViewed(_ listingId: String) {
        guard let t = token else { return }
        guard let url = URL(string: "\(apiBase)/api/user/recently-viewed/\(listingId)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: req).resume()
    }

    func removeFavorite(listingId: String) async throws {
        guard let t = token else { return }
        let url = URL(string: "\(apiBase)/api/user/favorites/\(listingId)")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    func changePassword(current: String, newPassword: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/auth/change-password")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: String] = ["currentPassword": current, "newPassword": newPassword]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al cambiar la contraseña")
        }
    }

    // MARK: - Avatar Upload

    func uploadAvatar(imageData: Data) async throws -> String {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/upload/avatar")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")

        let boundary = "----AvatarUpload\(Int(Date().timeIntervalSince1970))"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        // Part header
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"avatar\"; filename=\"avatar.jpg\"\r\n".utf8))
        body.append(Data("Content-Type: image/jpeg\r\n".utf8))
        body.append(Data("\r\n".utf8))
        // File content
        body.append(imageData)
        // Closing boundary
        body.append(Data("\r\n".utf8))
        body.append(Data("--\(boundary)--\r\n".utf8))

        // Use upload(for:from:) instead of httpBody — handles large payloads better
        let (data, resp) = try await session.upload(for: req, from: body)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al subir la foto (HTTP \(http.statusCode))")
        }
        // Server returns { "success": true, "avatarUrl": "..." } — mixed types
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let avatarUrl = json["avatarUrl"] as? String else {
            throw APIError.server("Respuesta inesperada")
        }

        // Update local user with new avatar
        if let user = currentUser {
            let userData = try JSONEncoder().encode(user)
            if var dict = try JSONSerialization.jsonObject(with: userData) as? [String: Any] {
                dict["avatarUrl"] = avatarUrl
                let newData = try JSONSerialization.data(withJSONObject: dict)
                let updatedUser = try decoder.decode(User.self, from: newData)
                await persist(user: updatedUser, token: t)
            }
        }

        return avatarUrl
    }

    // MARK: - Push Notifications

    func registerPushToken(token: String) async throws {
        guard let t = self.token else { return }
        let url = URL(string: "\(apiBase)/api/push/subscribe")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "type": "ios",
            "deviceToken": token
        ])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al registrar notificaciones")
        }
    }

    func unregisterPushToken() async throws {
        guard let t = self.token else { return }
        let url = URL(string: "\(apiBase)/api/push/subscribe")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (_, _) = try await session.data(for: req)
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
