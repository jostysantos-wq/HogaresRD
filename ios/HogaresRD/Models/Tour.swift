import Foundation

// MARK: - Available Time Slot (from API)

struct AvailableSlot: Codable {
    let time:     String
    let end_time: String
}

struct AvailableSlotsResponse: Codable {
    let date:      String
    let broker_id: String
    let slots:     [AvailableSlot]
}

struct ScheduleResponse: Codable {
    let month:           String
    let broker_id:       String
    let available_dates: [String]
}

// MARK: - Tour Request

struct TourRequest: Codable, Identifiable {
    let id:              String
    let listing_id:      String
    let listing_title:   String
    let broker_id:       String
    var client_id:       String?
    let client_name:     String
    let client_email:    String
    let client_phone:    String
    let requested_date:  String
    let requested_time:  String
    var status:          String  // pending, confirmed, rejected, cancelled
    var broker_notes:    String?
    let client_notes:    String?
    let created_at:      String
    var updated_at:      String

    var statusLabel: String {
        switch status {
        case "pending":    return "Pendiente"
        case "confirmed":  return "Confirmada"
        case "rejected":   return "Rechazada"
        case "cancelled":  return "Cancelada"
        case "completed":  return "Completada"
        default:           return status.capitalized
        }
    }

    var isPending:   Bool { status == "pending" }
    var isConfirmed: Bool { status == "confirmed" }

    var formattedDate: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: requested_date) else { return requested_date }
        formatter.dateFormat = "EEEE d 'de' MMMM"
        formatter.locale = Locale(identifier: "es_DO")
        return formatter.string(from: date)
    }

    var formattedTime: String {
        let parts = requested_time.split(separator: ":")
        guard parts.count >= 2, let h = Int(parts[0]) else { return requested_time }
        let m = parts[1]
        let ampm = h >= 12 ? "PM" : "AM"
        let h12 = h > 12 ? h - 12 : (h == 0 ? 12 : h)
        return "\(h12):\(m) \(ampm)"
    }
}

// MARK: - Broker Availability Slot

struct AvailabilitySlot: Codable, Identifiable {
    let id:                String
    let broker_id:         String
    let day_of_week:       Int
    let start_time:        String
    let end_time:          String
    let slot_duration_min: Int
    let max_concurrent:    Int
    let active:            Bool
    let type:              String?   // "weekly" or "override"
    let date:              String?   // for overrides only
    let available:         Bool?     // for overrides only

    var dayName: String {
        let names = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
        guard day_of_week >= 0, day_of_week < 7 else { return "?" }
        return names[day_of_week]
    }
}

struct BrokerAvailabilityResponse: Codable {
    let weekly:    [AvailabilitySlot]
    let overrides: [AvailabilitySlot]
}
