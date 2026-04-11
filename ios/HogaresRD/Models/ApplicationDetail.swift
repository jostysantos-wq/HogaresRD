import Foundation

// MARK: - Application Detail
//
// Full application object returned by GET /api/applications/:id — used by
// the broker dashboard's new detail screen. The lightweight `Application`
// type is still used by the list view for fast decoding. This type is
// intentionally permissive (most fields are optional) because older
// applications in production may be missing newer columns like
// employment_status, commission, etc.

struct ApplicationDetail: Decodable, Identifiable {
    let id:             String
    let listing_id:     String?
    let listing_title:  String?
    let listing_price:  Double?
    let listing_type:   String?
    let status:         String
    let status_reason:  String?

    let client:         AppClient
    let broker:         AppBroker?
    let co_applicant:   AppCoApplicant?

    let intent:         String?
    let timeline:       String?
    let financing:      String?
    let pre_approved:   Bool?
    let budget:         String?
    let contact_method: String?
    let notes:          String?

    let documents_requested: [AppDocumentRequest]?
    let documents_uploaded:  [AppDocumentUploaded]?

    let commission:     Commission?
    let inmobiliaria_id:   String?
    let inmobiliaria_name: String?

    let timeline_events: [AppTimelineEvent]?

    let created_at:     String?
    let updated_at:     String?

    /// Accept raw number OR string for listing_price because the server
    /// has been known to send either.
    enum CodingKeys: String, CodingKey {
        case id, listing_id, listing_title, listing_price, listing_type
        case status, status_reason
        case client, broker, co_applicant
        case intent, timeline, financing, pre_approved, budget, contact_method, notes
        case documents_requested, documents_uploaded
        case commission, inmobiliaria_id, inmobiliaria_name
        case timeline_events, created_at, updated_at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id             = try c.decode(String.self, forKey: .id)
        listing_id     = try? c.decode(String.self, forKey: .listing_id)
        listing_title  = try? c.decode(String.self, forKey: .listing_title)
        // listing_price can arrive as Double OR numeric-string
        if let d = try? c.decode(Double.self, forKey: .listing_price) {
            listing_price = d
        } else if let s = try? c.decode(String.self, forKey: .listing_price), let d = Double(s) {
            listing_price = d
        } else {
            listing_price = nil
        }
        listing_type   = try? c.decode(String.self, forKey: .listing_type)
        status         = (try? c.decode(String.self, forKey: .status)) ?? "aplicado"
        status_reason  = try? c.decode(String.self, forKey: .status_reason)

        client         = (try? c.decode(AppClient.self, forKey: .client))
                      ?? AppClient(name: "", phone: nil, email: nil, user_id: nil,
                                   id_type: nil, id_number: nil, nationality: nil,
                                   current_address: nil, date_of_birth: nil,
                                   employment_status: nil, employer_name: nil,
                                   job_title: nil, monthly_income: nil, income_currency: nil)
        broker         = try? c.decode(AppBroker.self, forKey: .broker)
        co_applicant   = try? c.decode(AppCoApplicant.self, forKey: .co_applicant)

        intent         = try? c.decode(String.self, forKey: .intent)
        timeline       = try? c.decode(String.self, forKey: .timeline)
        financing      = try? c.decode(String.self, forKey: .financing)
        pre_approved   = try? c.decode(Bool.self, forKey: .pre_approved)
        budget         = try? c.decode(String.self, forKey: .budget)
        contact_method = try? c.decode(String.self, forKey: .contact_method)
        notes          = try? c.decode(String.self, forKey: .notes)

        documents_requested = try? c.decode([AppDocumentRequest].self, forKey: .documents_requested)
        documents_uploaded  = try? c.decode([AppDocumentUploaded].self, forKey: .documents_uploaded)

        commission        = try? c.decode(Commission.self, forKey: .commission)
        inmobiliaria_id   = try? c.decode(String.self, forKey: .inmobiliaria_id)
        inmobiliaria_name = try? c.decode(String.self, forKey: .inmobiliaria_name)

        timeline_events   = try? c.decode([AppTimelineEvent].self, forKey: .timeline_events)
        created_at        = try? c.decode(String.self, forKey: .created_at)
        updated_at        = try? c.decode(String.self, forKey: .updated_at)
    }

    // Convenience labels
    var statusLabel: String {
        ApplicationStatus.label(for: status)
    }
    var priceFormatted: String {
        guard let p = listing_price, p > 0 else { return "Precio a consultar" }
        if p >= 1_000_000 { return String(format: "$%.1fM", p / 1_000_000) }
        if p >= 1_000     { return String(format: "$%.0fK", p / 1_000) }
        return "$\(Int(p))"
    }
}

// MARK: - Nested

struct AppClient: Decodable, Equatable {
    let name:              String
    let phone:             String?
    let email:             String?
    let user_id:           String?
    let id_type:           String?
    let id_number:         String?
    let nationality:       String?
    let current_address:   String?
    let date_of_birth:     String?
    let employment_status: String?
    let employer_name:     String?
    let job_title:         String?
    let monthly_income:    String?
    let income_currency:   String?
}

struct AppBroker: Decodable, Equatable {
    let user_id:     String?
    let name:        String?
    let email:       String?
    let phone:       String?
    let agency_name: String?
}

struct AppCoApplicant: Decodable, Equatable {
    let name:           String?
    let phone:          String?
    let email:          String?
    let id_number:      String?
    let monthly_income: String?
}

struct AppDocumentRequest: Decodable, Identifiable, Equatable {
    let id:           String
    let type:         String
    let label:        String?
    let required:     Bool?
    let status:       String?      // pending | uploaded | approved | rejected
    let deferred:     Bool?
    let requested_at: String?
}

struct AppDocumentUploaded: Decodable, Identifiable, Equatable {
    let id:            String
    let type:          String?
    let label:         String?
    let filename:      String?
    let original_name: String?
    let size:          Int?
    let uploaded_at:   String?
    let review_status: String?     // pending | approved | rejected
    let review_note:   String?
}

struct AppTimelineEvent: Decodable, Identifiable, Equatable {
    let id:          String
    let type:        String
    let description: String?
    let actor_name:  String?
    let created_at:  String?
}

// MARK: - Status catalog (mirrors backend STATUS_LABELS + STATUS_FLOW)

enum ApplicationStatus {
    static let labels: [String: String] = [
        "aplicado":                "Aplicado",
        "en_revision":             "En Revisión",
        "documentos_requeridos":   "Documentos Requeridos",
        "documentos_enviados":     "Documentos Enviados",
        "documentos_insuficientes":"Documentos Insuficientes",
        "en_aprobacion":           "En Aprobación",
        "reservado":               "Reservado",
        "aprobado":                "Aprobado",
        "pendiente_pago":          "Pendiente de Pago",
        "pago_enviado":            "Pago Enviado",
        "pago_aprobado":           "Pago Aprobado",
        "completado":              "Completado",
        "rechazado":               "Rechazado",
    ]

    /// Next-status whitelist matching backend STATUS_FLOW
    static let flow: [String: [String]] = [
        "aplicado":                ["en_revision", "rechazado"],
        "en_revision":             ["documentos_requeridos", "en_aprobacion", "rechazado"],
        "documentos_requeridos":   ["documentos_enviados", "rechazado"],
        "documentos_enviados":     ["en_aprobacion", "documentos_insuficientes", "rechazado"],
        "documentos_insuficientes":["documentos_requeridos", "rechazado"],
        "en_aprobacion":           ["reservado", "aprobado", "rechazado"],
        "reservado":               ["aprobado", "rechazado"],
        "aprobado":                ["pendiente_pago", "rechazado"],
        "pendiente_pago":          ["pago_enviado", "rechazado"],
        "pago_enviado":            ["pago_aprobado", "pendiente_pago", "rechazado"],
        "pago_aprobado":           ["completado"],
        "completado":              [],
        "rechazado":               ["aplicado"],
    ]

    /// Status ownership — mirrors the server STATUS_OWNERSHIP map in
    /// routes/applications.js. Only `broker` statuses should appear in
    /// the manual "Cambiar estado" sheet — the others are side effects
    /// of dedicated flows (client uploads a receipt / docs, or broker
    /// completes a review) and the server will 400 any attempt to set
    /// them manually.
    static let ownership: [String: String] = [
        "aplicado":                 "broker",
        "en_revision":              "broker",
        "documentos_requeridos":    "broker",
        "documentos_enviados":      "client_auto",
        "documentos_insuficientes": "review_auto",
        "en_aprobacion":            "broker",
        "reservado":                "broker",
        "aprobado":                 "broker",
        "pendiente_pago":           "broker",
        "pago_enviado":             "client_auto",
        "pago_aprobado":            "review_auto",
        "completado":               "broker",
        "rechazado":                "broker",
    ]

    static func label(for key: String) -> String {
        labels[key] ?? key.capitalized
    }

    /// Raw next options from the flow map (includes auto statuses).
    /// Used internally — prefer `manualNextOptions(from:)` for UI.
    static func nextOptions(from key: String) -> [String] {
        flow[key] ?? []
    }

    /// Next statuses a broker can legitimately PICK manually from the
    /// "Cambiar estado" sheet. Filters out client-auto and review-auto
    /// statuses that are set as side effects of other workflows, so the
    /// broker can't race the client's automation or bypass a review.
    static func manualNextOptions(from key: String) -> [String] {
        nextOptions(from: key).filter { ownership[$0] == "broker" }
    }

    static func isBrokerSettable(_ key: String) -> Bool {
        ownership[key] == "broker"
    }
}

// MARK: - Document type catalog (matches backend DOCUMENT_TYPES)

enum DocumentCatalog {
    static let types: [(key: String, label: String)] = [
        ("cedula",            "Cédula de Identidad"),
        ("passport",          "Pasaporte"),
        ("income_proof",      "Comprobante de Ingresos"),
        ("bank_statement",    "Estado de Cuenta Bancario"),
        ("employment_letter", "Carta de Trabajo"),
        ("tax_return",        "Declaración de Impuestos"),
        ("pre_approval",      "Carta de Pre-Aprobación Bancaria"),
        ("proof_of_funds",    "Prueba de Fondos"),
        ("other",             "Otro Documento"),
    ]

    static func label(for key: String) -> String {
        types.first(where: { $0.key == key })?.label ?? key
    }
}
