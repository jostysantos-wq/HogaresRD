import Foundation

struct TaskItem: Codable, Identifiable {
    let id: String
    let title: String
    let description: String?
    let status: String
    let priority: String
    let dueDate: String?
    let assignedTo: String
    let assignedBy: String
    let applicationId: String?
    let listingId: String?
    let source: String?
    let sourceEvent: String?
    let completedAt: String?
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, description, status, priority, source
        case dueDate = "due_date"
        case assignedTo = "assigned_to"
        case assignedBy = "assigned_by"
        case applicationId = "application_id"
        case listingId = "listing_id"
        case sourceEvent = "source_event"
        case completedAt = "completed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var isOverdue: Bool {
        guard let due = dueDate, status != "completada" else { return false }
        return due < ISO8601DateFormatter().string(from: Date())
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
        case "en_progreso": return "En Progreso"
        case "completada":  return "Completada"
        default:            return "Pendiente"
        }
    }
}

struct TasksResponse: Decodable {
    let tasks: [TaskItem]
}
