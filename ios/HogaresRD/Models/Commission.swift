import Foundation

// MARK: - Commission

/// Per-sale commission on an application, mirroring the backend shape
/// defined in routes/applications.js. Lives under application.commission.
///
/// Lifecycle:
///   • Agent submits         → status == "pending_review"
///   • Inmobiliaria reviews  → status == "approved" | "rejected"
///   • Approved + adjusted records also keep the new numbers in place;
///     the change is tracked in `history`.
struct Commission: Codable, Equatable {
    var sale_amount:          Double
    var agent_percent:        Double
    var agent_amount:         Double
    var inmobiliaria_percent: Double
    var inmobiliaria_amount:  Double
    var agent_net:            Double
    var status:               String  // pending_review | approved | rejected
    var submitted_by:         String?
    var submitted_name:       String?
    var submitted_at:         String?
    var reviewed_by:          String?
    var reviewer_name:        String?
    var reviewed_at:          String?
    var adjustment_note:      String?

    /// Server returns numbers; Swift decodes them as Double.
    /// History is not decoded here — it's only needed in admin-level
    /// audit views which are web-only for now.

    var statusLabel: String {
        switch status {
        case "pending_review": return "Pendiente"
        case "approved":       return "Aprobada"
        case "rejected":       return "Rechazada"
        default:               return status.capitalized
        }
    }

    var statusColor: String {
        switch status {
        case "pending_review": return "orange"
        case "approved":       return "green"
        case "rejected":       return "red"
        default:               return "gray"
        }
    }
}

// MARK: - Commission Summary (from /api/applications/commissions/summary)

struct CommissionsSummaryResponse: Codable {
    let role:        String
    let summary:     CommissionsSummary
    let commissions: [CommissionRow]
}

struct CommissionsSummary: Codable {
    let agent_pending:          Double
    let agent_approved:         Double
    let agent_total_sales:      Double
    let inmobiliaria_pending:   Double
    let inmobiliaria_approved:  Double
    let total_pending_count:    Int
    let total_approved_count:   Int
}

struct CommissionRow: Codable, Identifiable, Equatable {
    let application_id: String
    let listing_title:  String?
    let listing_price:  Double?
    let client_name:    String?
    let agent_user_id:  String?
    let agent_name:     String?
    let commission:     Commission
    let status:         String?     // application status, e.g. 'completado'
    let created_at:     String?
    let updated_at:     String?

    var id: String { application_id }
}
