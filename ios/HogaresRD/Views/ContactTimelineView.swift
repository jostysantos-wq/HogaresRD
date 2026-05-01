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

                // Filter chips
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(filters, id: \.label) { f in
                            Button {
                                withAnimation(.easeInOut(duration: 0.15)) { selectedFilter = f.type }
                                Task { await load() }
                            } label: {
                                Text(f.label)
                                    .font(.caption.bold())
                                    .padding(.horizontal, 14).padding(.vertical, 7)
                                    .background(selectedFilter == f.type ? Color.rdBlue : Color(.tertiarySystemFill))
                                    .foregroundStyle(selectedFilter == f.type ? .white : .primary)
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.vertical, 12)

                if loading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Cargando timeline...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 40)
                } else if events.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text("Sin actividad")
                            .font(.headline)
                        Text("No hay eventos registrados para este contacto.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 40)
                    .padding(.horizontal)
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
                    .font(.system(size: 26, weight: .bold))
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
                            .font(.system(size: 10))
                        Text(phone)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            // Stats row — four badges matching the web profile
            HStack(spacing: 20) {
                statBadge(icon: "doc.text.fill",   label: "Apps",      count: c.applications ?? 0, color: .rdBlue)
                statBadge(icon: "bubble.left.and.bubble.right.fill", label: "Mensajes", count: c.conversations ?? 0, color: .purple)
                statBadge(icon: "calendar",        label: "Visitas",   count: c.tours ?? 0, color: .green)
                statBadge(icon: "checkmark.circle", label: "Tareas",    count: c.tasks ?? 0, color: .orange)
            }
            .padding(.top, 4)
        }
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemGroupedBackground))
    }

    private func statBadge(icon: String, label: String, count: Int, color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(color)
            Text("\(count)")
                .font(.subheadline.bold())
            Text(label)
                .font(.system(size: 10))
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
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                if !isLast {
                    Rectangle()
                        .fill(Color(.separator))
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
                            .font(.system(size: 10))
                        Text("\(date) \(time)")
                            .font(.caption2)
                        if let tourType = event.tourType {
                            Text(tourType == "virtual" ? "Virtual" : "Presencial")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color(.tertiarySystemFill))
                                .clipShape(Capsule())
                        }
                    }
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                }

                if event.type == "conversation", let count = event.messageCount, count > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "text.bubble")
                            .font(.system(size: 10))
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
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
            .padding(.bottom, 20)
        }
    }

    // MARK: - Status Badge

    private func statusBadge(_ status: String) -> some View {
        let label: String
        let color: Color
        switch status {
        case "aprobado", "completada", "completed", "confirmed":
            label = status.capitalized; color = .rdGreen
        case "rechazado", "rejected", "cancelled", "cancelada":
            label = status.capitalized; color = .rdRed
        case "en_revision", "pending", "pendiente":
            label = "Pendiente"; color = .orange
        case "activa":
            label = "Activa"; color = .rdBlue
        case "cerrada":
            label = "Cerrada"; color = .secondary
        default:
            label = status.capitalized; color = .secondary
        }

        return Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.1))
            .clipShape(Capsule())
    }
}
