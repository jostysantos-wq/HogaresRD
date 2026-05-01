import SwiftUI

// MARK: - Contact Timeline (CRM — unified activity feed per contact)

struct ContactTimelineView: View {
    @EnvironmentObject var api: APIService
    let contactId: String
    let contactName: String

    @State private var contact: ContactSummary?
    @State private var events: [TimelineEvent] = []
    @State private var loading = true
    @State private var selectedFilter: String? = nil

    private let filters: [(label: String, type: String?)] = [
        ("Todo", nil),
        ("Aplicaciones", "application"),
        ("Mensajes", "conversation"),
        ("Visitas", "tour"),
        ("Tareas", "task"),
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Contact header card
                if let c = contact {
                    contactHeader(c)
                }

                // Filter chips — design-system ChipRow
                ChipRow(
                    items: filters.map { f in
                        ChipRow<String>.Chip(id: f.type ?? "_all", label: f.label)
                    },
                    selection: Binding(
                        get: { selectedFilter ?? "_all" },
                        set: { newValue in
                            selectedFilter = newValue == "_all" ? nil : newValue
                            Task { await load() }
                        }
                    )
                )
                .padding(.vertical, Spacing.s8)

                if loading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Cargando timeline...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 40)
                } else if events.isEmpty {
                    EmptyStateView.calm(
                        systemImage: "clock.arrow.circlepath",
                        title: "Sin actividad",
                        description: "No hay eventos registrados para este contacto."
                    )
                    .padding(.top, 40)
                } else {
                    // Timeline
                    LazyVStack(spacing: 0) {
                        ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                            timelineRow(event, isLast: index == events.count - 1)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
        }
        .navigationTitle(contactName.isEmpty ? "Timeline" : contactName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        if events.isEmpty { loading = true }
        do {
            let result = try await api.getContactTimeline(contactId: contactId, type: selectedFilter)
            contact = result.contact
            events = result.events
        } catch is CancellationError {
        } catch {
            events = []
        }
        loading = false
    }

    // MARK: - Contact Header

    private func contactHeader(_ c: ContactSummary) -> some View {
        VStack(spacing: 14) {
            // Avatar
            ZStack {
                Circle()
                    .fill(Color.rdBlue.opacity(0.12))
                    .frame(width: 72, height: 72)
                Text(c.initials)
                    .font(.title.weight(.bold))
                    .foregroundStyle(Color.rdBlue)
            }

            VStack(spacing: 4) {
                Text(c.name.isEmpty ? (c.email ?? "Contacto") : c.name)
                    .font(.title3.bold())
                if let email = c.email, !email.isEmpty {
                    Text(email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let phone = c.phone, !phone.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "phone.fill")
                            .font(.caption2)
                        Text(phone)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            // Stats row — four badges matching the web profile
            HStack(spacing: 20) {
                statBadge(icon: "doc.text.fill",   label: "Apps",      count: c.applications ?? 0, color: .rdBlue)
                statBadge(icon: "bubble.left.and.bubble.right.fill", label: "Mensajes", count: c.conversations ?? 0, color: .rdPurple)
                statBadge(icon: "calendar",        label: "Visitas",   count: c.tours ?? 0, color: .rdGreen)
                statBadge(icon: "checkmark.circle", label: "Tareas",    count: c.tasks ?? 0, color: .rdOrange)
            }
            .padding(.top, 4)
        }
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity)
        .background(Color.rdSurfaceMuted)
    }

    private func statBadge(icon: String, label: String, count: Int, color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(color)
            Text("\(count)")
                .font(.subheadline.bold())
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Timeline Row

    private func timelineRow(_ event: TimelineEvent, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: 14) {
            // Left timeline indicator
            VStack(spacing: 0) {
                Circle()
                    .fill(event.iconColor)
                    .frame(width: 32, height: 32)
                    .overlay {
                        Image(systemName: event.iconName)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                if !isLast {
                    Rectangle()
                        .fill(Color.rdLine)
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                }
            }

            // Content
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(event.title)
                        .font(.subheadline.bold())
                    Spacer()
                    Text(event.timeAgo)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let sub = event.subtitle, !sub.isEmpty {
                    Text(sub)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                // Type-specific details
                if event.type == "tour", let date = event.tourDate, let time = event.tourTime {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar")
                            .font(.caption2)
                        Text("\(date) \(time)")
                            .font(.caption2)
                        if let tourType = event.tourType {
                            Text(tourType == "virtual" ? "Virtual" : "Presencial")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.rdSurfaceMuted)
                                .clipShape(Capsule())
                        }
                    }
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }

                if event.type == "conversation", let count = event.messageCount, count > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "text.bubble")
                            .font(.caption2)
                        Text("\(count) mensajes")
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }

                if let status = event.status, !status.isEmpty, event.type != "status_change" {
                    statusBadge(status)
                        .padding(.top, 2)
                }

                Text(event.formattedDate)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
            .padding(.bottom, 20)
        }
    }

    // MARK: - Status Badge
    //
    // Maps the event status onto the design-system `DSStatusBadge` so
    // chip styling stays consistent across the app.
    private func statusBadge(_ status: String) -> some View {
        let label: String
        let color: Color
        switch status {
        case "aprobado", "completada", "completed", "confirmed":
            label = status.capitalized; color = .rdGreen
        case "rechazado", "rejected", "cancelled", "cancelada":
            label = status.capitalized; color = .rdRed
        case "en_revision", "pending", "pendiente":
            label = "Pendiente"; color = .rdOrange
        case "activa":
            label = "Activa"; color = .rdBlue
        case "cerrada":
            label = "Cerrada"; color = .rdMuted
        default:
            label = status.capitalized; color = .rdMuted
        }
        return DSStatusBadge(label: label, tint: color)
    }
}
