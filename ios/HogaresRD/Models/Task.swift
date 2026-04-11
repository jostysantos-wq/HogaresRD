import Foundation

struct TaskItem: Decodable, Identifiable {
    let id: String
    let title: String
    let description: String?
    let status: String
    let priority: String
    let dueDate: String?
    let assignedTo: String
    let assignedBy: String
    let approverId: String?
    let applicationId: String?
    let listingId: String?
    let source: String?
    let sourceEvent: String?
    // Related listing metadata enriched by the server
    let listingTitle: String?
    let listingImage: String?
    let listingCity: String?
    // Approval workflow fields
    let approvalStatus: String?   // null | pending_review | approved | rejected
    let reviewNotes: String?
    let reviewedAt: String?
    let reviewedBy: String?
    let submittedAt: String?
    let completedAt: String?
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, description, status, priority, source
        case dueDate        = "due_date"
        case assignedTo     = "assigned_to"
        case assignedBy     = "assigned_by"
        case approverId     = "approver_id"
        case applicationId  = "application_id"
        case listingId      = "listing_id"
        case sourceEvent    = "source_event"
        case listingTitle   = "listing_title"
        case listingImage   = "listing_image"
        case listingCity    = "listing_city"
        case approvalStatus = "approval_status"
        case reviewNotes    = "review_notes"
        case reviewedAt     = "reviewed_at"
        case reviewedBy     = "reviewed_by"
        case submittedAt    = "submitted_at"
        case completedAt    = "completed_at"
        case createdAt      = "created_at"
        case updatedAt      = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id             = try c.decode(String.self, forKey: .id)
        title          = try c.decode(String.self, forKey: .title)
        description    = try? c.decode(String.self, forKey: .description)
        status         = (try? c.decode(String.self, forKey: .status)) ?? "pendiente"
        priority       = (try? c.decode(String.self, forKey: .priority)) ?? "media"
        dueDate        = try? c.decode(String.self, forKey: .dueDate)
        assignedTo     = (try? c.decode(String.self, forKey: .assignedTo)) ?? ""
        assignedBy     = (try? c.decode(String.self, forKey: .assignedBy)) ?? ""
        approverId     = try? c.decode(String.self, forKey: .approverId)
        applicationId  = try? c.decode(String.self, forKey: .applicationId)
        listingId      = try? c.decode(String.self, forKey: .listingId)
        source         = try? c.decode(String.self, forKey: .source)
        sourceEvent    = try? c.decode(String.self, forKey: .sourceEvent)
        listingTitle   = try? c.decode(String.self, forKey: .listingTitle)
        listingImage   = try? c.decode(String.self, forKey: .listingImage)
        listingCity    = try? c.decode(String.self, forKey: .listingCity)
        approvalStatus = try? c.decode(String.self, forKey: .approvalStatus)
        reviewNotes    = try? c.decode(String.self, forKey: .reviewNotes)
        reviewedAt     = try? c.decode(String.self, forKey: .reviewedAt)
        reviewedBy     = try? c.decode(String.self, forKey: .reviewedBy)
        submittedAt    = try? c.decode(String.self, forKey: .submittedAt)
        completedAt    = try? c.decode(String.self, forKey: .completedAt)
        createdAt      = try? c.decode(String.self, forKey: .createdAt)
        updatedAt      = try? c.decode(String.self, forKey: .updatedAt)
    }

    var isOverdue: Bool {
        guard let due = dueDate, status != "completada" else { return false }
        return due < ISO8601DateFormatter().string(from: Date())
    }

    /// True when this task was submitted by the assignee and is waiting
    /// for the approver to review it.
    var isPendingReview: Bool {
        status == "pending_review"
    }

    /// True when this task was rejected and sent back for revision.
    var wasRejected: Bool {
        approvalStatus == "rejected" && status != "completada"
    }

    /// True when this task requires a separate approver (i.e. assignee
    /// ≠ approver). Used by the UI to decide whether to show
    /// "Submit for Review" vs "Mark Complete".
    var requiresApproval: Bool {
        guard let approver = approverId, !approver.isEmpty else { return false }
        return approver != assignedTo
    }

    var priorityLabel: String {
        switch priority {
        case "alta": return "Alta"
        case "baja": return "Baja"
        default:     return "Media"
        }
    }

    var statusLabel: String {
        switch status {
        case "en_progreso":    return "En Progreso"
        case "pending_review": return "Pendiente Revisión"
        case "completada":     return "Completada"
        default:               return "Pendiente"
        }
    }
}

struct TasksResponse: Decodable {
    let tasks: [TaskItem]
}
