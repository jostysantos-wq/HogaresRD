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

    // MARK: - Ads

    func fetchActiveAds() async -> [Ad] {
        guard let url = URL(string: "\(apiBase)/api/ads/active") else { return [] }
        guard let (data, _) = try? await URLSession.shared.data(from: url) else { return [] }
        return (try? decoder.decode([Ad].self, from: data)) ?? []
    }

    func trackAdImpression(_ adID: String) {
        guard let url = URL(string: "\(apiBase)/api/ads/\(adID)/impression") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
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
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["ok"] as? Bool == true else { return false }
        return true
    }

    func trackAdClick(_ adID: String) {
        guard let url = URL(string: "\(apiBase)/api/ads/\(adID)/click") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de broker")
        }
        return try await login(email: email, password: password)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode != 201 && http.statusCode != 200 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al crear la cuenta de inmobiliaria")
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

    // MARK: - Tours

    func fetchAvailableSlots(brokerId: String, date: String) async throws -> [AvailableSlot] {
        let url = URL(string: "\(Self.baseURL)/api/tours/availability/\(brokerId)?date=\(date)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(AvailableSlotsResponse.self, from: data).slots
    }

    func fetchSchedule(brokerId: String, month: String) async throws -> [String] {
        let url = URL(string: "\(Self.baseURL)/api/tours/schedule/\(brokerId)?month=\(month)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(ScheduleResponse.self, from: data).available_dates
    }

    func requestTour(listingId: String, brokerId: String, date: String, time: String,
                     name: String, phone: String, email: String, notes: String) async throws -> TourRequest {
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/request")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let body: [String: String] = [
            "listing_id": listingId, "broker_id": brokerId, "date": date,
            "time": time, "name": name, "phone": phone, "email": email, "notes": notes
        ]
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode == 409 {
            throw APIError.server("Este horario ya no está disponible.")
        }
        return try JSONDecoder().decode(TourRequest.self, from: data)
    }

    func fetchMyTourRequests() async throws -> [TourRequest] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/my-requests")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode([TourRequest].self, from: data)
    }

    func fetchBrokerTourRequests() async throws -> [TourRequest] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-requests")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
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
        let (_, resp) = try await URLSession.shared.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al actualizar visita")
        }
    }

    func cancelTour(tourId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/\(tourId)/cancel")!)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (_, resp) = try await URLSession.shared.data(for: req)
        if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode != 200 {
            throw APIError.server("Error al cancelar visita")
        }
    }

    func fetchBrokerAvailability() async throws -> BrokerAvailabilityResponse {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
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
        _ = try await URLSession.shared.data(for: req)
    }

    func deleteBrokerAvailability(slotId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(Self.baseURL)/api/tours/broker-availability/\(slotId)")!)
        req.httpMethod = "DELETE"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: req)
    }

    // MARK: - Conversations

    func getConversations() async throws -> [Conversation] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/conversations")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
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
        let (data, _) = try await URLSession.shared.data(for: req)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
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
        _ = try? await URLSession.shared.data(for: req)
    }

    // MARK: - Applications

    func getApplications() async throws -> [Application] {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/applications/my")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar la propiedad")
        }
    }

    // MARK: - Broker Dashboard

    func getDashboardAnalytics(range: String = "30d") async throws -> DashboardAnalytics {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker-dashboard/analytics")!
        comps.queryItems = [URLQueryItem(name: "range", value: range)]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode(DashboardAnalytics.self, from: data)
    }

    func getDashboardSales() async throws -> DashboardSales {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/broker-dashboard/sales")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode(DashboardSales.self, from: data)
    }

    func getDashboardAccounting(commissionRate: Double = 0.03) async throws -> DashboardAccounting {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker-dashboard/accounting")!
        comps.queryItems = [URLQueryItem(name: "commission_rate", value: "\(commissionRate)")]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode(DashboardAccounting.self, from: data)
    }

    func getDashboardDocuments(status: String? = nil, type: String? = nil, search: String? = nil, page: Int = 1) async throws -> DashboardDocuments {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker-dashboard/documents/archive")!
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
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode(DashboardDocuments.self, from: data)
    }

    func getDashboardAudit(search: String? = nil, type: String? = nil, page: Int = 1) async throws -> DashboardAudit {
        guard let t = token else { throw APIError.server("No autenticado") }
        var comps = URLComponents(string: "\(apiBase)/api/broker-dashboard/audit")!
        var items: [URLQueryItem] = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "limit", value: "50")
        ]
        if let s = search { items.append(.init(name: "search", value: s)) }
        if let t = type   { items.append(.init(name: "type", value: t)) }
        comps.queryItems = items
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
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
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode(TeamResponse.self, from: data)
    }

    func getBrokerDetail(brokerId: String) async throws -> BrokerDetail {
        guard let t = token else { throw APIError.server("No autenticado") }
        var req = URLRequest(url: URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/details")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode(BrokerDetail.self, from: data)
    }

    func approveBroker(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/approve")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al desvincular agente")
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al guardar notas")
        }
    }

    func sendBrokerPasswordReset(brokerId: String) async throws {
        guard let t = token else { throw APIError.server("No autenticado") }
        let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers/\(brokerId)/send-reset")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al enviar reset de contraseña")
        }
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
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = err["error"] { throw APIError.server(msg) }
            throw APIError.server("Error al cambiar la contraseña")
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
