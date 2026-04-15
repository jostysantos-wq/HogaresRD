import Foundation

// Change to "http://localhost:3000" for local development
let apiBase = "https://hogaresrd.com"

/// Safe URL construction — returns a guaranteed URL, falling back to
/// the base URL if the string is somehow malformed (should never happen
/// with hardcoded paths but prevents force-unwrap crashes).
private func apiURL(_ path: String) -> URL {
    URL(string: "\(apiBase)\(path)") ?? URL(string: apiBase)!
}

/// Detect MIME type from filename extension
private func mimeType(for filename: String) -> String {
    let ext = (filename as NSString).pathExtension.lowercased()
    switch ext {
    case "pdf":  return "application/pdf"
    case "png":  return "image/png"
    case "heic": return "image/heic"
    case "gif":  return "image/gif"
    case "webp": return "image/webp"
    case "doc":  return "application/msword"
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case "xls":  return "application/vnd.ms-excel"
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    default:     return "image/jpeg"
    }
}

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

    private let maxEntries = 200

    func set(_ key: String, value: Any, ttl: TimeInterval = 120) {
        lock.lock(); defer { lock.unlock() }
        // Evict expired entries when approaching capacity
        if store.count >= maxEntries {
            let now = Date()
            store = store.filter { now < $0.value.expires }
        }
        // If still at capacity, evict oldest entries
        if store.count >= maxEntries {
            let oldest = store.sorted { $0.value.expires < $1.value.expires }
            for entry in oldest.prefix(store.count - maxEntries + 1) {
                store.removeValue(forKey: entry.key)
            }
        }
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

@MainActor
class APIService: ObservableObject {
    static let shared = APIService()
    static let baseURL = apiBase

    @Published var currentUser: User?
    @Published var token: String?

    /// Handles 401 Unauthorized — token expired or invalidated.
    /// Logs the user out so the app shows the login screen instead of
    /// repeatedly failing with "No autorizado" on every request.
    nonisolated func handleUnauthorized(_ response: URLResponse?) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 401 else { return }
        Task { @MainActor in
            if self.currentUser != nil {
            debugLog("[APIService] 401 received — token expired, logging out")
                ErrorReporter.shared.report("Token expired — auto-logout", context: "401 handler")
                self.logout()
            }
        }
    }

    /// Affiliate ref token from a deep link. Set when the app opens via
    /// a Universal Link with ?ref=TOKEN. Included in conversation and
    /// application requests so the lead is attributed to the sharing agent.
    var pendingRefToken: String?

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
        config.requestCachePolicy = .useProtocolCachePolicy
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
        let url = apiURL("/api/listings/\(id)")
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
        let allAds = (try? decoder.decode([Ad].self, from: data)) ?? []
        // Exclude popup ads — those are shown by fetchPopupAd(), not in the feed
        let feedAds = allAds.filter { $0.ad_type != "popup" }
        cache.set("ads:active", value: feedAds, ttl: 300)
        return feedAds
    }

    /// Fetch the highest-priority active popup ad
    func fetchPopupAd() async -> Ad? {
        guard let url = URL(string: "\(apiBase)/api/ads/active?type=popup") else { return nil }
        guard let (data, _) = try? await session.data(from: url) else { return nil }
        let ads = (try? decoder.decode([Ad].self, from: data)) ?? []
        return ads.first // Already sorted by priority DESC on server
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

    /// Submit a full application to /api/applications with extended fields
    /// (personal data, employment, co-applicant, deferred documents).
    /// Returns the created application id on success.
    func submitApplication(
        listing: Listing,
        payload: [String: Any]
    ) async throws -> String {
        guard let url = URL(string: "\(apiBase)/api/applications") else {
            throw APIError.server("URL inválida")
        }
        var body = payload
        body["listing_id"]    = listing.id
        body["listing_title"] = listing.title
        body["listing_price"] = listing.price
        body["listing_type"]  = listing.type
        if let me = currentUser { body["user_id"] = me.id }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = self.token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw APIError.server("Respuesta inválida")
        }
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if http.statusCode >= 400 {
            let msg = (json?["error"] as? String) ?? "Error al enviar la aplicación"
            throw APIError.server(msg)
        }
        guard let id = json?["id"] as? String, !id.isEmpty else {
            throw APIError.server("Respuesta sin id")
        }
        return id
    }

    /// Upload a document during the initial apply window (no auth required
    /// for the first 10 minutes after application creation).
    func uploadInitialDocument(
        applicationId: String,
        type: String,
        label: String,
        fileURL: URL? = nil,
        data: Data? = nil,
        filename: String
    ) async throws {
        guard let url = URL(string: "\(apiBase)/api/applications/\(applicationId)/initial-upload") else { return }

        let fileData: Data
        if let d = data { fileData = d }
        else if let fileURL { fileData = try Data(contentsOf: fileURL) }
        else { throw APIError.server("Archivo inválido") }

        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }

        for (name, value) in [("type", type), ("label", label)] {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            append("\(value)\r\n")
        }

        let mime: String = {
            let ext = (filename as NSString).pathExtension.lowercased()
            switch ext {
            case "pdf":  return "application/pdf"
            case "png":  return "image/png"
            case "heic": return "image/heic"
            case "gif":  return "image/gif"
            case "webp": return "image/webp"
            default:     return "image/jpeg"
            }
        }()

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"files\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(mime)\r\n\r\n")
        body.append(fileData)
        append("\r\n--\(boundary)--\r\n")

        req.httpBody = body
        let (respData, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: respData) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error subiendo archivo")
        }
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
        let url = apiURL("/api/auth/forgot-password")
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
        let url = apiURL("/api/auth/login")
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
        let url = apiURL("/api/auth/apple")
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
        let url = apiURL("/api/auth/apple-subscription")
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
        let url = apiURL("/api/auth/register")
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
        let url = apiURL("/api/auth/register/agency")
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
        let url = apiURL("/api/auth/register/broker")
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
        let url = apiURL("/api/auth/register/inmobiliaria")
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
        let url = apiURL("/api/auth/register/constructora")
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
    /// Always bypasses cache to ensure fresh auth state.
    func refreshUser() async {
        guard let t = token else { return }
        var req = URLRequest(url: apiURL("/api/auth/me"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, resp) = try? await session.data(for: req) else { return }
        handleUnauthorized(resp)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let user = try? decoder.decode(User.self, from: data) else { return }
        await MainActor.run {
            self.currentUser = user
            UserDefaults.standard.set(try? JSONEncoder().encode(user), forKey: "rd_user")
        }
    }

    /// Ask the server to send a new email verification link.
    /// Throws a special error if the server reports the email is already
    /// verified — that way the UI can dismiss the popup instead of pretending
    /// an email was sent.
    func resendVerificationEmail() async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/auth/resend-verification"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw APIError.server("Error al reenviar verificacion")
        }
        // The backend returns { success: true, message: 'Tu correo ya está
        // verificado.' } when the user is actually verified. If we detect
        // that, refresh the user profile and throw a soft error so the UI
        // knows to close the popup.
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg  = json["message"] as? String,
           msg.lowercased().contains("ya está verificado") || msg.lowercased().contains("ya esta verificado") {
            await refreshUser()
            throw APIError.server("Tu correo ya está verificado")
        }
    }

    /// Verify email via deep link token. Calls the server endpoint which marks
    /// the email verified, then refreshes the local user profile so the
    /// verification popup dismisses automatically.
    func verifyEmail(token: String) async -> Bool {
        // Build the verify URL — same endpoint the web flow uses.
        // We don't need to follow the redirect; the server processes
        // the verification on the GET itself.
        guard let url = URL(string: "\(apiBase)/api/auth/verify-email?token=\(token)") else { return false }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        // Use a session that does NOT follow redirects — we only need the
        // server to process the token; the 302 response is irrelevant.
        let config = URLSessionConfiguration.ephemeral
        let noRedirectSession = URLSession(configuration: config, delegate: NoRedirectDelegate.shared, delegateQueue: nil)
        guard let (_, resp) = try? await noRedirectSession.data(for: req),
              let http = resp as? HTTPURLResponse,
              (200...399).contains(http.statusCode) else { return false }
        await refreshUser()
        return true
    }

    func deleteAccount() async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/auth/delete-account"))
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
        let url = apiURL("/api/listings/agencies")
        let (data, _) = try await session.data(from: url)
        return (try decoder.decode(AgenciesResponse.self, from: data)).agencies
    }

    // MARK: - Inquiry

    func sendInquiry(listingId: String, name: String, email: String, phone: String, message: String) async throws {
        let url = apiURL("/api/listings/\(listingId)/inquiry")
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
        let url = apiURL("/api/auth/2fa/verify")
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
        let url = apiURL("/api/auth/2fa/resend")
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
        var req = URLRequest(url: apiURL("/api/auth/2fa/enable"))
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
        var req = URLRequest(url: apiURL("/api/auth/2fa/confirm-enable"))
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
        var req = URLRequest(url: apiURL("/api/auth/2fa/disable"))
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
        var req = URLRequest(url: apiURL("/api/auth/biometric/register"))
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
        let url = apiURL("/api/auth/biometric/login")
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
        // Save rotated biometric token (server issues a new one on each login)
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let newBio = json["newBiometricToken"] as? String {
            try? BiometricService.shared.saveBiometricToken(newBio, for: email)
        }
        return .success(user)
    }

    func revokeBiometric() async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/auth/biometric/revoke"))
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
        var req = URLRequest(url: apiURL("/api/listing-analytics/listing/\(id)"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(ListingAnalyticsDetail.self, from: data)
    }

    // MARK: - Conversations

    func getConversations(archived: Bool = false) async throws -> [Conversation] {
        guard let t = token else { throw APIError.server("No autenticado") }
        let suffix = archived ? "?archived=true" : ""
        var req = URLRequest(url: apiURL("/api/conversations\(suffix)"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await session.data(for: req)
        handleUnauthorized(resp)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error cargando conversaciones")
        }
        do {
            return try decoder.decode([Conversation].self, from: data)
        } catch {
            let raw = String(data: data.prefix(500), encoding: .utf8) ?? "(binary)"
            debugLog("[Conversations] decode error: \(error)\nraw: \(raw)")
            ErrorReporter.shared.reportDecodeError(error, endpoint: "GET /api/conversations", rawPrefix: raw)
            throw error
        }
    }

    func getConversation(id: String, since: String? = nil) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/conversations/\(id)")!
        if let since = since {
            comps.queryItems = [URLQueryItem(name: "since", value: since)]
        }
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.cachePolicy = .reloadIgnoringLocalCacheData
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
        let url = apiURL("/api/conversations")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        var body: [String: String] = [
            "propertyId":    propertyId,
            "propertyTitle": propertyTitle,
            "message":       message
        ]
        // Include affiliate ref token if the app was opened via a deep link
        if let ref = pendingRefToken, !ref.isEmpty {
            body["refToken"] = ref
        }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al iniciar la conversación")
        }
        let result = try decoder.decode(ConversationResponse.self, from: data)
        // Clear the ref token after first use — it's been attributed
        pendingRefToken = nil
        return result.conversation
    }

    func sendMessage(conversationId: String, text: String) async throws -> ConvMessage {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/conversations/\(conversationId)/messages")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.cachePolicy = .reloadIgnoringLocalCacheData
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
        let url = apiURL("/api/conversations/\(id)/read")
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// List the teammates in the same inmobiliaria that the current
    /// broker is allowed to transfer this conversation to.
    func fetchTransferTargets(conversationId: String) async throws -> [TransferTarget] {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/conversations/\(conversationId)/transfer-targets")
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "No se pudieron cargar los compañeros")
        }
        struct Wrapper: Decodable { let targets: [TransferTarget] }
        return try decoder.decode(Wrapper.self, from: data).targets
    }

    /// Transfer the conversation's broker side to another teammate.
    /// Backend enforces the same-inmobiliaria rule — this will 403 if
    /// the target agent belongs to a different organization.
    func transferConversation(id: String, targetUserId: String, reason: String) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/conversations/\(id)/transfer")
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["targetUserId": targetUserId, "reason": reason]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al transferir la conversación")
        }
        struct Wrapper: Decodable { let conversation: Conversation }
        return try decoder.decode(Wrapper.self, from: data).conversation
    }

    /// Total unread conversations across every thread the authenticated
    /// user has access to. Used to populate the red badge on the iOS
    /// Messages tab bar icon.
    func getConversationsUnreadCount() async -> Int {
        guard let t = token else { return 0 }
        guard let url = URL(string: "\(apiBase)/api/conversations/unread") else { return 0 }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return 0 }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return (json?["count"] as? Int) ?? 0
        } catch {
            return 0
        }
    }

    /// Resets the server-side badge counter so the next push notification
    /// starts from zero. Called when the app becomes active.
    func resetPushBadge() async {
        guard let t = token else { return }
        guard let url = URL(string: "\(apiBase)/api/push/badge-reset") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await session.data(for: req)
    }

    /// Pros only (agent/broker/inmobiliaria/constructora). Closes the
    /// conversation so no further messages can be sent from either side.
    func closeConversation(id: String, reason: String) async throws -> Conversation {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/conversations/\(id)/close")
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
        let url = apiURL("/api/conversations/\(id)/reopen")
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
        let url = apiURL("/api/conversations/\(id)/claim")
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
        let url = apiURL("/api/conversations/\(id)/archive")
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
        let url = apiURL("/api/conversations/\(id)/unarchive")
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

    /// Fetch applications visible to the current user.
    ///
    /// Role-scoped by the backend at GET /api/applications:
    ///   • admin                    → every application
    ///   • inmobiliaria/constructora → applications assigned to any
    ///     broker on their team
    ///   • secretary                → parent inmobiliaria's applications
    ///   • agency/broker            → applications where they're the
    ///     assigned broker
    ///
    /// Before this fix, the broker dashboard was calling the wrong
    /// Fetch the current user's OWN applications (as a client/buyer).
    /// Calls /api/applications/my which works for all roles and returns
    /// enriched data (listing_image, listing_city).
    func getMyApplications() async throws -> [Application] {
        let url = apiURL("/api/applications/my")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando mis aplicaciones")
        if let arr = try? decoder.decode([Application].self, from: data) { return arr }
        return []
    }

    /// Fetch applications managed by this broker/agent (for broker dashboard).
    /// Returns 403 for regular users — use getMyApplications() for client views.
    func getApplications() async throws -> [Application] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/applications"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al cargar aplicaciones")
        }
        // The /api/applications endpoint returns a raw array.
        if let arr = try? decoder.decode([Application].self, from: data) {
            return arr
        }
        // Legacy wrapper fallback — some older endpoints returned { applications: [...] }
        if let wrapper = try? decoder.decode(ApplicationsResponse.self, from: data) {
            return wrapper.applications
        }
        return []
    }

    // MARK: - Submit Listing

    func submitListing(_ body: [String: Any]) async throws {
        let url = apiURL("/submit")
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
        var req = URLRequest(url: apiURL("/api/broker/sales"))
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

    // MARK: - Application detail / workflow (broker-side)

    /// Full application detail for the broker dashboard.
    /// GET /api/applications/:id
    func fetchApplicationDetail(id: String) async throws -> ApplicationDetail {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(id)")
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Aplicación no encontrada")
        }
        return try decoder.decode(ApplicationDetail.self, from: data)
    }

    /// Change an application's status. PUT /api/applications/:id/status
    /// Backend validates the transition against STATUS_FLOW; reason is
    /// required when moving to "rechazado".
    @discardableResult
    func updateApplicationStatus(id: String, newStatus: String, reason: String = "") async throws -> ApplicationDetail {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(id)/status")
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["status": newStatus, "reason": reason]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al cambiar el estado")
        }
        return try decoder.decode(ApplicationDetail.self, from: data)
    }

    /// Request one or more documents from the client on an application.
    /// POST /api/applications/:id/documents/request
    /// Body: { documents: [{ type, label, required }] }
    @discardableResult
    func requestApplicationDocuments(id: String, documents: [(type: String, label: String, required: Bool)]) async throws -> ApplicationDetail {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(id)/documents/request")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let docs: [[String: Any]] = documents.map { d in
            ["type": d.type, "label": d.label, "required": d.required]
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["documents": docs])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error solicitando documentos")
        }
        return try decoder.decode(ApplicationDetail.self, from: data)
    }

    /// Send an in-app message to the application's client from the broker.
    /// POST /api/applications/:id/contact-client — creates/reuses the
    /// client↔broker conversation and pushes a notification to the client.
    func contactApplicationClient(applicationId: String, message: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(applicationId)/contact-client")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["message": message])
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al contactar al cliente")
        }
    }

    // MARK: - Commissions (per-sale with inmobiliaria approval flow)

    /// Fetch the aggregated commissions summary for the current user.
    /// Role-scoped server-side — an agent sees only their own rows;
    /// an inmobiliaria owner sees the whole team plus their own cut.
    func fetchCommissionsSummary() async throws -> CommissionsSummaryResponse {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/commissions/summary")
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al cargar comisiones")
        }
        return try decoder.decode(CommissionsSummaryResponse.self, from: data)
    }

    /// Agent submits (or re-submits) a commission for an application.
    /// Server will put it in pending_review status.
    @discardableResult
    func submitCommission(
        applicationId: String,
        saleAmount: Double,
        agentPercent: Double,
        inmobiliariaPercent: Double,
        note: String
    ) async throws -> Commission {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(applicationId)/commission")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "sale_amount":          saleAmount,
            "agent_percent":        agentPercent,
            "inmobiliaria_percent": inmobiliariaPercent,
            "note":                 note,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al registrar comisión")
        }
        struct Wrapper: Decodable { let commission: Commission }
        return try decoder.decode(Wrapper.self, from: data).commission
    }

    /// Inmobiliaria owner reviews a pending commission.
    /// action: "approve" | "adjust" | "reject"
    /// For "adjust", pass the new numbers; otherwise they're ignored.
    @discardableResult
    func reviewCommission(
        applicationId: String,
        action: String,
        saleAmount: Double? = nil,
        agentPercent: Double? = nil,
        inmobiliariaPercent: Double? = nil,
        note: String
    ) async throws -> Commission {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(applicationId)/commission/review")
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["action": action, "note": note]
        if let s = saleAmount          { body["sale_amount"] = s }
        if let a = agentPercent        { body["agent_percent"] = a }
        if let i = inmobiliariaPercent { body["inmobiliaria_percent"] = i }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError.server((json?["error"] as? String) ?? "Error al revisar comisión")
        }
        struct Wrapper: Decodable { let commission: Commission }
        return try decoder.decode(Wrapper.self, from: data).commission
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
        let url = apiURL("/api/chat")
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
        var req = URLRequest(url: apiURL("/api/inmobiliaria/brokers"))
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
        var req = URLRequest(url: apiURL("/api/inmobiliaria/brokers/\(brokerId)/details"))
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
        let url = apiURL("/api/inmobiliaria/brokers/\(brokerId)/approve")
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
        let url = apiURL("/api/inmobiliaria/brokers/\(brokerId)/reject")
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
        let url = apiURL("/api/inmobiliaria/brokers/\(brokerId)/remove")
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
        var req = URLRequest(url: apiURL("/api/inmobiliaria/secretaries"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try decoder.decode(SecretariesResponse.self, from: data).secretaries
    }

    func inviteSecretary(email: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/inmobiliaria/secretaries/invite"))
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
        var req = URLRequest(url: apiURL("/api/inmobiliaria/secretaries/\(id)/remove"))
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
        let url = apiURL("/api/inmobiliaria/brokers/\(brokerId)/notes")
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
        let url = apiURL("/api/inmobiliaria/team/\(userId)/role")
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
        var req = URLRequest(url: apiURL("/api/inmobiliaria/my-access"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder().decode(MyAccessResponse.self, from: data)
    }

    func sendBrokerPasswordReset(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/inmobiliaria/brokers/\(brokerId)/send-reset")
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
        let url = apiURL("/api/reports")
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
        let url = apiURL("/api/inventory/\(listingId)")
        let (data, _) = try await session.data(from: url)
        return try decoder.decode(InventoryResponse.self, from: data)
    }

    func addInventoryUnit(listingId: String, label: String, type: String, floor: String = "") async throws -> UnitInventoryItem {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/inventory/\(listingId)/units")
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
        let url = apiURL("/api/inventory/\(listingId)/units/\(unitId)")
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
        let url = apiURL("/api/inventory/\(listingId)/units/\(unitId)/assign")
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
        let url = apiURL("/api/inventory/\(listingId)/units/\(unitId)/release")
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

    /// Lightweight count of tasks that need the user's attention. Used
    /// to drive the red badge on the Tareas menu entry. Returns 0 on
    /// any error so the UI degrades gracefully.
    func getTasksBadgeCount() async -> Int {
        guard let t = token else { return 0 }
        guard let url = URL(string: "\(apiBase)/api/tasks/badge-count") else { return 0 }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        do {
            let (data, resp) = try await session.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 { return 0 }
            struct Wrapper: Decodable { let count: Int }
            return (try? decoder.decode(Wrapper.self, from: data))?.count ?? 0
        } catch {
            return 0
        }
    }

    /// Mark a task as complete. Behind the scenes the server routes
    /// this to either `/complete` (→ direct completada for self-assigned
    /// tasks) or `/pending_review` (for tasks that require a separate
    /// approver to sign off). The returned task object tells the caller
    /// which branch happened via task.status.
    func completeTask(id: String) async throws -> TaskItem {
        let url = apiURL("/api/tasks/\(id)/complete")
        let req = try authedRequest(url, method: "POST")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error completando tarea")
        return try decoder.decode(TaskItem.self, from: data)
    }

    /// Approver signs off on a submitted task. 403 if the caller is the
    /// assignee. Server sets status → completada.
    func approveTask(id: String, note: String = "") async throws -> TaskItem {
        let url = apiURL("/api/tasks/\(id)/approve")
        let body: [String: Any] = ["note": note]
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "POST", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error aprobando tarea")
        return try decoder.decode(TaskItem.self, from: data)
    }

    /// Approver rejects a submitted task and sends it back for revision.
    /// Note is required. Server sets status → en_progreso and notifies
    /// the assignee.
    func rejectTask(id: String, note: String) async throws -> TaskItem {
        let url = apiURL("/api/tasks/\(id)/reject")
        let body: [String: Any] = ["note": note]
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "POST", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error rechazando tarea")
        return try decoder.decode(TaskItem.self, from: data)
    }

    /// Mark a task as not applicable. Either the assignee or the approver
    /// can dismiss tasks that don't apply to the situation.
    func markTaskNotApplicable(id: String, note: String = "") async throws -> TaskItem {
        let url = apiURL("/api/tasks/\(id)/not-applicable")
        let body: [String: Any] = ["note": note]
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "POST", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error marcando tarea como no aplica")
        return try decoder.decode(TaskItem.self, from: data)
    }

    /// Reassign the approver for a task. Only the current approver (or
    /// admin) can delegate. New approver cannot be the task assignee —
    /// server enforces separation of duties.
    func reassignTaskApprover(id: String, newApproverId: String) async throws -> TaskItem {
        let url = apiURL("/api/tasks/\(id)/approver")
        let body: [String: Any] = ["approver_id": newApproverId]
        let json = try JSONSerialization.data(withJSONObject: body)
        let req = try authedRequest(url, method: "PUT", body: json)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error reasignando aprobador")
        return try decoder.decode(TaskItem.self, from: data)
    }

    func createTask(title: String, description: String, priority: String, dueDate: String?, assignedTo: String?) async throws -> TaskItem {
        let url = apiURL("/api/tasks")
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
        // 402 = subscription required — special error for UI handling
        if http.statusCode == 402 {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
               obj["needsSubscription"] as? Bool == true {
                throw APIError.subscriptionRequired
            }
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String:Any],
           let msg = obj["error"] as? String { throw APIError.server(msg) }
        throw APIError.server(fallback)
    }

    func listSavedSearches() async throws -> [SavedSearch] {
        let url = apiURL("/api/saved-searches")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando búsquedas")
        return try decoder.decode(SavedSearchesResponse.self, from: data).searches
    }

    func createSavedSearch(name: String, filters: SavedSearchFilters, notify: Bool) async throws -> SavedSearch {
        let url = apiURL("/api/saved-searches")
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
        let url = apiURL("/api/saved-searches/\(id)")
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
        let url = apiURL("/api/saved-searches/\(id)")
        let req = try authedRequest(url, method: "DELETE")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error eliminando búsqueda")
    }

    func getSavedSearchResults(id: String) async throws -> SavedSearchResponse {
        let url = apiURL("/api/saved-searches/\(id)")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando resultados")
        return try decoder.decode(SavedSearchResponse.self, from: data)
    }

    // MARK: - Meta Ads (read-only management for iOS — creation stays on web)

    func getMetaStatus() async throws -> MetaStatusResponse {
        let url = apiURL("/api/paid-ads/meta/status")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando estado")
        return try decoder.decode(MetaStatusResponse.self, from: data)
    }

    func getAdCampaigns() async throws -> AdCampaignsResponse {
        let url = apiURL("/api/paid-ads/meta/campaigns")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando campañas")
        return try decoder.decode(AdCampaignsResponse.self, from: data)
    }

    func toggleAdCampaign(id: String) async throws {
        let url = apiURL("/api/paid-ads/meta/campaigns/\(id)/toggle-status")
        let req = try authedRequest(url, method: "POST")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cambiando estado")
    }

    func deleteAdCampaign(id: String) async throws {
        let url = apiURL("/api/paid-ads/meta/campaigns/\(id)")
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
        let url = apiURL("/api/user/favorites/\(listingId)")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// Log a recently viewed listing. Fire-and-forget.
    /// Fetch recently viewed listing objects (up to 8 for the home carousel)
    func getRecentlyViewedListings() async -> [Listing] {
        guard token != nil else { return [] }
        guard let url = URL(string: "\(apiBase)/api/user/recently-viewed") else { return [] }
        do {
            let req = try authedRequest(url)
            let (data, _) = try await session.data(for: req)
            struct RVResponse: Decodable { let ids: [String] }
            let ids = (try? decoder.decode(RVResponse.self, from: data))?.ids ?? []
            // Fetch up to 8 listings by ID
            var listings: [Listing] = []
            for id in ids.prefix(8) {
                if let listing = try? await getListing(id: id) { listings.append(listing) }
            }
            return listings
        } catch { return [] }
    }

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
        let url = apiURL("/api/user/favorites/\(listingId)")
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: req)
    }

    /// Toggle the current user's like on a listing.
    /// Returns the fresh server-side like count on success, or nil on failure
    /// (so the caller can keep its optimistic count).
    @discardableResult
    func toggleLike(listingId: String, liked: Bool) async throws -> Int? {
        guard let t = token else { return nil }
        guard let url = URL(string: "\(apiBase)/api/listings/\(listingId)/like") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["liked": liked])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode < 400 else { return nil }
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["likeCount"] as? Int
    }

    func changePassword(current: String, newPassword: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/auth/change-password")
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
        let url = apiURL("/api/upload/avatar")
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
        let url = apiURL("/api/push/subscribe")
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
        let url = apiURL("/api/push/subscribe")
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

    // MARK: - Contact Timeline CRM

    func getContacts() async throws -> [ContactSummary] {
        let url = apiURL("/api/contacts")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando contactos")
        return try decoder.decode(ContactsResponse.self, from: data).contacts
    }

    func getContactTimeline(contactId: String, type: String? = nil) async throws -> ContactTimelineResponse {
        var comps = URLComponents(string: "\(apiBase)/api/contacts/\(contactId)/timeline")!
        if let type = type { comps.queryItems = [URLQueryItem(name: "type", value: type)] }
        let req = try authedRequest(comps.url!)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando timeline")
        return try decoder.decode(ContactTimelineResponse.self, from: data)
    }

    // MARK: - Buyer Document Upload

    /// Full application details (includes documents_requested, documents_uploaded)
    func getMyApplicationsFull() async throws -> [[String: Any]] {
        let url = apiURL("/api/applications/my")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando aplicaciones")
        return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
    }

    /// Upload a document for an application
    func uploadDocument(applicationId: String, requestId: String?, type: String, fileData: Data, filename: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(applicationId)/documents/upload")
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        // File
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"files\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        let mime = mimeType(for: filename)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n".data(using: .utf8)!)
        // Type
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"type\"\r\n\r\n\(type)\r\n".data(using: .utf8)!)
        // Request ID
        if let rid = requestId {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"request_id\"\r\n\r\n\(rid)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error subiendo documento")
    }

    /// Upload payment receipt
    func uploadPaymentReceipt(applicationId: String, amount: String, notes: String, fileData: Data, filename: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(applicationId)/payment/upload")
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"receipt\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        let mime = mimeType(for: filename)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n".data(using: .utf8)!)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"amount\"\r\n\r\n\(amount)\r\n".data(using: .utf8)!)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"notes\"\r\n\r\n\(notes)\r\n".data(using: .utf8)!)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error subiendo comprobante")
    }

    /// Upload processed receipt (broker/agent side) after verifying payment
    func uploadProcessedReceipt(applicationId: String, fileData: Data, filename: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = apiURL("/api/applications/\(applicationId)/payment/processed-receipt")
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"receipt\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        let mime = mimeType(for: filename)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error subiendo recibo procesado")
    }

    // MARK: - Cancel / Retention

    func getCancelStats() async throws -> CancelStats {
        let url = apiURL("/api/stripe/cancel-stats")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando estadisticas")
        return try decoder.decode(CancelStats.self, from: data)
    }

    func submitCancelFeedback(reason: String, feedback: String, acceptedOffer: String?) async throws -> CancelFeedbackResponse {
        let url = apiURL("/api/stripe/cancel-feedback")
        var body: [String: Any] = ["reason": reason, "feedback": feedback]
        if let offer = acceptedOffer { body["accepted_offer"] = offer }
        let req = try authedRequest(url, method: "POST", body: try JSONSerialization.data(withJSONObject: body))
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error procesando solicitud")
        return try decoder.decode(CancelFeedbackResponse.self, from: data)
    }

    // MARK: - Payments CRM

    func getApplicationsForPaymentPlan() async throws -> [Application] {
        var comps = URLComponents(string: "\(apiBase)/api/applications")!
        comps.queryItems = [URLQueryItem(name: "status", value: "pendiente_pago")]
        let req = try authedRequest(comps.url!)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando aplicaciones")
        return try decoder.decode([Application].self, from: data)
    }

    func createPaymentPlan(applicationId: String, plan: [String: Any]) async throws {
        let url = apiURL("/api/applications/\(applicationId)/payment-plan")
        let body = try JSONSerialization.data(withJSONObject: plan)
        let req = try authedRequest(url, method: "POST", body: body)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error creando plan de pago")
    }

    func getPaymentsSummary() async throws -> PaymentsSummaryResponse {
        let url = apiURL("/api/payments/summary")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando pagos")
        return try decoder.decode(PaymentsSummaryResponse.self, from: data)
    }

    func sendPaymentReminder(applicationId: String, installmentId: String) async throws {
        let url = apiURL("/api/applications/\(applicationId)/payment-plan/\(installmentId)/notify")
        let req = try authedRequest(url, method: "POST")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error enviando recordatorio")
    }

    // MARK: - Subscription Status

    func getSubscriptionStatus() async throws -> SubscriptionStatus {
        let url = apiURL("/api/stripe/status")
        let req = try authedRequest(url)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error verificando suscripcion")
        return try decoder.decode(SubscriptionStatus.self, from: data)
    }

    // MARK: - Application state poll

    /// Lightweight GET /:id/state — returns a ~200-byte envelope with
    /// just enough fields to decide "do I need to re-fetch the full
    /// detail?". Intended for periodic polling while a detail view is
    /// open. Returns nil on any error so the caller can just ignore it.
    func getApplicationState(id: String) async -> ApplicationState? {
        guard let t = token else { return nil }
        guard let url = URL(string: "\(apiBase)/api/applications/\(id)/state") else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        do {
            let (data, resp) = try await session.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 { return nil }
            return try? decoder.decode(ApplicationState.self, from: data)
        } catch {
            return nil
        }
    }

    // MARK: - Document Review (archive tab)

    /// PUT /api/applications/:id/documents/:docId/review
    /// status must be "approved" or "rejected". Optional note for rejections.
    func reviewDocument(
        applicationId: String,
        documentId: String,
        status: String,
        note: String = ""
    ) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/applications/\(applicationId)/documents/\(documentId)/review"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "status": status,
            "note":   note,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error revisando documento")
    }

    /// Returns a URL to open an uploaded document in Safari. The server
    /// validates authorization against the listing owner / admin before
    /// serving the file. Includes the access token as a query param.
    func documentDownloadURL(applicationId: String, documentId: String) -> URL? {
        guard let t = token else { return nil }
        var comps = URLComponents(string: "\(apiBase)/api/applications/\(applicationId)/documents/\(documentId)/file")!
        comps.queryItems = [URLQueryItem(name: "token", value: t)]
        return comps.url
    }

    // MARK: - Payment Review (broker verifies client proof)

    /// PUT /api/applications/:id/payment-plan/:iid/review — inmobiliaria reviews
    /// a single installment's proof. Approved installments auto-advance the
    /// application to pago_aprobado once ALL installments are approved.
    func reviewPaymentInstallment(
        applicationId: String,
        installmentId: String,
        approved: Bool,
        reviewNotes: String = ""
    ) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/applications/\(applicationId)/payment-plan/\(installmentId)/review"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "approved": approved,
            "review_notes": reviewNotes,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error revisando pago")
    }

    /// PUT /api/applications/:id/payment/verify — broker verifies the
    /// single-payment flow (not installments). Full amount.
    func verifySinglePayment(
        applicationId: String,
        approved: Bool,
        notes: String = ""
    ) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/applications/\(applicationId)/payment/verify"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "approved": approved,
            "notes": notes,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error verificando pago")
    }

    /// Returns the authenticated URL to open a receipt in an SFSafariViewController.
    /// The server redirects to the S3/local file after validating authorization.
    func paymentReceiptURL(applicationId: String) -> URL? {
        guard let t = token else { return nil }
        var comps = URLComponents(string: "\(apiBase)/api/applications/\(applicationId)/payment/receipt")!
        comps.queryItems = [URLQueryItem(name: "token", value: t)]
        return comps.url
    }

    // MARK: - My Listings (all statuses)

    /// Fetches ALL listings owned by the current user, regardless of status.
    /// Used by the broker dashboard's "Mis Propiedades" section to show
    /// pending/edits_requested/rejected submissions alongside approved ones.
    func getMyListings() async throws -> [Listing] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/user/listings"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error cargando propiedades")
        struct Wrapper: Decodable { let listings: [Safe<Listing>] }
        let wrap = try decoder.decode(Wrapper.self, from: data)
        return wrap.listings.compactMap { $0.value }
    }

    // MARK: - Listing Promo Content

    func getListingPromoContent(id: String) async throws -> ListingPromoContent {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/listing-analytics/listing/\(id)/promo"))
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error generando contenido")
        return try decoder.decode(ListingPromoContent.self, from: data)
    }

    // MARK: - Update listing (edit)

    /// Sends a PUT to /api/listings/:id. Body may contain any subset of
    /// editable fields (title, description, price, etc.). Server returns the
    /// updated record; we ignore the body and just surface errors.
    func updateListing(id: String, body: [String: Any]) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: apiURL("/api/listings/\(id)"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        try throwIfErr(data, resp, fallback: "Error actualizando propiedad")
    }
}

// MARK: - Application state poll payload

/// Lightweight envelope returned by GET /api/applications/:id/state.
/// iOS uses the `version` string as an etag: if it differs from the
/// last seen version, the caller re-fetches the full detail.
struct ApplicationState: Decodable, Equatable {
    let id: String
    let status: String
    let lastEventAt: String?
    let lastEventType: String?
    let docCount: Int
    let docPendingReview: Int
    let paymentStatus: String
    let installmentCount: Int
    let installmentPendingReview: Int
    let version: String

    enum CodingKeys: String, CodingKey {
        case id, status, version
        case lastEventAt             = "last_event_at"
        case lastEventType           = "last_event_type"
        case docCount                = "doc_count"
        case docPendingReview        = "doc_pending_review"
        case paymentStatus           = "payment_status"
        case installmentCount        = "installment_count"
        case installmentPendingReview = "installment_pending_review"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id                       = (try? c.decode(String.self, forKey: .id)) ?? ""
        status                   = (try? c.decode(String.self, forKey: .status)) ?? ""
        lastEventAt              = try? c.decode(String.self, forKey: .lastEventAt)
        lastEventType            = try? c.decode(String.self, forKey: .lastEventType)
        docCount                 = (try? c.decode(Int.self, forKey: .docCount)) ?? 0
        docPendingReview         = (try? c.decode(Int.self, forKey: .docPendingReview)) ?? 0
        paymentStatus            = (try? c.decode(String.self, forKey: .paymentStatus)) ?? "none"
        installmentCount         = (try? c.decode(Int.self, forKey: .installmentCount)) ?? 0
        installmentPendingReview = (try? c.decode(Int.self, forKey: .installmentPendingReview)) ?? 0
        version                  = (try? c.decode(String.self, forKey: .version)) ?? ""
    }
}

// MARK: - Promo content payload

struct ListingPromoContent: Decodable {
    struct Meta: Decodable {
        let id: String
        let title: String
        let typeLabel: String?
        let condLabel: String?
        let city: String?
        let province: String?
        let sector: String?
        let images: [String]?
    }
    struct GoogleAds: Decodable {
        let headlines: [String]
        let descriptions: [String]
        let finalUrl: String?
    }
    let listing: Meta
    let url: String
    let content: PromoContentBody
}

struct PromoContentBody: Decodable {
    let facebook: String
    let instagram: String
    let whatsapp: String
    let linkedin: String
    let google_business: String?
    let google_ads: ListingPromoContent.GoogleAds?
}

/// Teammate that a broker can transfer a conversation to. Returned by
/// GET /api/conversations/:id/transfer-targets — the server only lists
/// agents in the same inmobiliaria as the caller.
struct TransferTarget: Decodable, Identifiable, Equatable {
    let id:         String
    let name:       String
    let email:      String
    let role:       String
    let agencyName: String?
    let avatarUrl:  String?
}

struct SubscriptionStatus: Decodable {
    let required: Bool
    let status: String?
    let trialEndsAt: String?
    let isActive: Bool?
    let canAccessDashboard: Bool?
    let paywallRequired: Bool?
    let isLegacyTrial: Bool?
    let planName: String?
    let hasPaymentMethod: Bool?
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
    case subscriptionRequired
    var errorDescription: String? {
        switch self {
        case .server(let msg): return msg
        case .subscriptionRequired: return "Tu suscripción no está activa. Renueva tu plan para continuar."
        }
    }
}

// MARK: - No-redirect URLSession delegate (used by verifyEmail)

private class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = NoRedirectDelegate()
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil // Don't follow redirects
    }
}
