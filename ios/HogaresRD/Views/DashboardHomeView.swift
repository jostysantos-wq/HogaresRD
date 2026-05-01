import SwiftUI

// MARK: - Dashboard Home View (Reusable across all roles)

struct DashboardHomeView: View {
    @EnvironmentObject var api: APIService

    // Configuration
    var showSalesMetrics: Bool = true
    var showLeaderboard: Bool = false
    var teamMembers: [TeamBroker] = []
    var onTapTab: (Int) -> Void = { _ in }
    var onTapMessages: () -> Void = {}
    var onTapTours: () -> Void = {}
    var onTapPipelineStage: (String) -> Void = { _ in }

    // Data
    @State private var analytics: DashboardAnalytics?
    @State private var sales: DashboardSales?
    @State private var tours: [TourRequest] = []
    @State private var conversations: [Conversation] = []
    @State private var loading = true

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        if hour < 12 { return "Buenos días" }
        if hour < 18 { return "Buenas tardes" }
        return "Buenas noches"
    }

    private var userName: String {
        api.currentUser?.name.components(separatedBy: " ").first ?? ""
    }

    private var pendingApps: Int { analytics?.enRevision ?? 0 }
    private var pendingDocs: Int {
        // docs_requeridos + docs_enviados + docs_insuficientes
        (analytics?.pipeline["documentos_requeridos"] ?? 0) +
        (analytics?.pipeline["documentos_enviados"]   ?? 0) +
        (analytics?.pipeline["documentos_insuficientes"] ?? 0)
    }
    private var unreadMessages: Int {
        let myId = api.currentUser?.id ?? ""
        return conversations.filter { conv in
            let isClient = conv.clientId == myId
            let count = isClient ? (conv.unreadClient ?? 0) : (conv.unreadBroker ?? 0)
            return count > 0
        }.count
    }
    private var todaysTours: [TourRequest] {
        let today = DateFormatter.yyyyMMdd.string(from: Date())
        return tours.filter { $0.requested_date == today && ($0.status == "confirmed" || $0.status == "pending") }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if loading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Cargando dashboard...")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 300)
                } else {
                    greetingHeader
                    todayCard
                    kpiSection
                    pipelineSection
                    if showLeaderboard && !teamMembers.isEmpty {
                        leaderboardSection
                    }
                    activityFeed
                }
            }
            .padding(16)
        }
        .refreshable { await loadAll() }
        .task { await loadAll() }
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationReceived)) { _ in
            // A push just arrived — refresh KPIs so the dashboard reflects
            // the new server-side state (new application, status change,
            // payment review, etc.) without waiting for the user to pull.
            Task { await loadAll() }
        }
    }

    // MARK: - Data Loading

    private func loadAll() async {
        if analytics == nil { loading = true }
        async let a = try? api.getDashboardAnalytics()
        async let s = showSalesMetrics ? (try? api.getDashboardSales()) : nil
        async let t = try? api.fetchBrokerTourRequests()
        async let c = try? api.getConversations(archived: false)

        analytics = await a
        sales = await s
        tours = await t ?? []
        conversations = await c ?? []
        loading = false
    }

    // MARK: - Greeting Header

    private var greetingHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(greeting), \(userName)")
                .font(.title2.bold())
            HStack(spacing: 6) {
                Text(api.currentUser?.role.capitalized ?? "Agente")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.rdBlue, in: Capsule())
                if let company = api.currentUser?.agencyName, !company.isEmpty {
                    Text(company)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Today's Priorities

    private var todayCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Hoy", systemImage: "star.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdBlue)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)

            Divider()

            VStack(spacing: 0) {
                if pendingApps > 0 {
                    todayRow(icon: "doc.text.fill", iconColor: .rdOrange, label: "\(pendingApps) aplicaciones en revision") {
                        onTapTab(0)
                    }
                }
                if unreadMessages > 0 {
                    todayRow(icon: "bubble.left.fill", iconColor: Color.rdBlue, label: "\(unreadMessages) mensajes sin leer") {
                        onTapMessages()
                    }
                }
                if !todaysTours.isEmpty {
                    let next = todaysTours.first
                    todayRow(icon: "calendar.badge.clock", iconColor: Color.rdGreen,
                             label: "\(todaysTours.count) visita\(todaysTours.count > 1 ? "s" : "") hoy" + (next != nil ? " · \(formatTime(next!.requested_time))" : "")) {
                        onTapTours()
                    }
                }
                if pendingDocs > 0 {
                    todayRow(icon: "exclamationmark.triangle.fill", iconColor: Color.rdRed, label: "\(pendingDocs) documentos pendientes") {
                        onTapTab(4)
                    }
                }
                if pendingApps == 0 && unreadMessages == 0 && todaysTours.isEmpty && pendingDocs == 0 {
                    HStack {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Color.rdGreen)
                        Text("Todo al dia. Sin tareas pendientes.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(14)
                }
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func todayRow(icon: String, iconColor: Color, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.subheadline)
                    .foregroundStyle(iconColor)
                    .frame(width: 28, height: 28)
                    .background(iconColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.bold())
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }

    // MARK: - KPI Metrics

    private var kpiSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Metricas", systemImage: "chart.bar.fill")
                .font(.headline)

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                KPICard(icon: "doc.text.fill", label: "Aplicaciones", value: "\(analytics?.totalApps ?? 0)",
                        trend: analytics?.newThisMonth ?? 0 > 0 ? "+\(analytics?.newThisMonth ?? 0) este mes" : nil,
                        trendPositive: true, color: Color.rdBlue)
                KPICard(icon: "arrow.triangle.2.circlepath", label: "Tasa Conversion",
                        value: String(format: "%.1f%%", (analytics?.conversionRate ?? 0) * 100),
                        trend: nil, trendPositive: true, color: .rdOrange)
                if showSalesMetrics {
                    KPICard(icon: "dollarsign.circle.fill", label: "Ingresos",
                            value: formatCurrency(sales?.totalRevenue ?? 0),
                            trend: "\(sales?.totalSales ?? 0) ventas", trendPositive: true, color: Color.rdGreen)
                }
                KPICard(icon: "clock.fill", label: "Dias Prom. Cierre",
                        value: String(format: "%.0f", analytics?.avgDaysToClose ?? 0),
                        trend: nil, trendPositive: false, color: .rdPurple)
            }
        }
    }

    // MARK: - Pipeline Funnel

    private var pipelineSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Pipeline", systemImage: "arrow.right.arrow.left")
                .font(.headline)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    pipelineStage("Enviadas", count: analytics?.enviadas ?? 0, color: Color.rdBlue, status: "aplicado")
                    pipelineArrow
                    pipelineStage("Revision", count: analytics?.enRevision ?? 0, color: .rdOrange, status: "en_revision")
                    pipelineArrow
                    pipelineStage("Aprobadas", count: analytics?.aprobadas ?? 0, color: Color.rdGreen, status: "aprobado")
                    pipelineArrow
                    pipelineStage("Rechazadas", count: analytics?.rechazadas ?? 0, color: Color.rdRed, status: "rechazado")
                    pipelineArrow
                    pipelineStage("Cerradas", count: analytics?.cerradas ?? 0, color: .rdPurple, status: "completado")
                }
            }
        }
    }

    private func pipelineStage(_ label: String, count: Int, color: Color, status: String) -> some View {
        Button {
            onTapPipelineStage(status)
        } label: {
            VStack(spacing: 6) {
                Text("\(count)")
                    .font(.title3.bold())
                    .foregroundStyle(color)
                Text(label)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .frame(width: 72, height: 64)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.2), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var pipelineArrow: some View {
        Image(systemName: "chevron.right")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.quaternary)
    }

    // MARK: - Team Leaderboard

    private var leaderboardSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Ranking del Equipo", systemImage: "trophy.fill")
                .font(.headline)

            let sorted = teamMembers.sorted { $0.appCount > $1.appCount }
            let maxCount = sorted.first?.appCount ?? 1

            VStack(spacing: 8) {
                ForEach(Array(sorted.prefix(5).enumerated()), id: \.element.id) { idx, member in
                    HStack(spacing: 12) {
                        // Medal or rank
                        Text(idx < 3 ? ["🥇", "🥈", "🥉"][idx] : "\(idx + 1)")
                            .font(idx < 3 ? .title3 : .caption.bold())
                            .frame(width: 28)

                        // Avatar
                        ZStack {
                            Circle().fill(Color.rdBlue.opacity(0.12)).frame(width: 36, height: 36)
                            Text(member.initials)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.rdBlue)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.name)
                                .font(.caption.bold())
                                .lineLimit(1)
                            // Progress bar
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color(.systemGray5)).frame(height: 6)
                                    Capsule().fill(Color.rdBlue)
                                        .frame(width: geo.size.width * CGFloat(member.appCount) / CGFloat(max(maxCount, 1)), height: 6)
                                }
                            }
                            .frame(height: 6)
                        }

                        Text("\(member.appCount)")
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdBlue)
                            .frame(width: 30, alignment: .trailing)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(idx == 0 ? Color.rdBlue.opacity(0.04) : Color.clear,
                                in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    // MARK: - Activity Feed

    private var activityFeed: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Actividad Reciente", systemImage: "clock.arrow.circlepath")
                .font(.headline)

            let items = buildActivityItems()

            if items.isEmpty {
                HStack {
                    Spacer()
                    VStack(spacing: 8) {
                        Image(systemName: "tray").font(.title2).foregroundStyle(.tertiary)
                        Text("Sin actividad reciente").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.vertical, 20)
            } else {
                VStack(spacing: 0) {
                    ForEach(items.prefix(8)) { item in
                        activityRow(item)
                        if item.id != items.prefix(8).last?.id {
                            Divider().padding(.leading, 48)
                        }
                    }
                }
                .padding(.vertical, 4)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private func activityRow(_ item: HomeActivityItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.icon)
                .font(.footnote)
                .foregroundStyle(item.iconColor)
                .frame(width: 30, height: 30)
                .background(item.iconColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.caption.bold())
                    .lineLimit(2)
                Text(item.subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if !item.actions.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(item.actions) { action in
                            Button(action: action.action) {
                                Label(action.label, systemImage: action.icon)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(action.color)
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(action.color.opacity(0.1), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 2)
                }
            }

            Spacer()

            Text(item.timeAgo)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    // MARK: - Build Activity Items

    private func buildActivityItems() -> [HomeActivityItem] {
        var items: [HomeActivityItem] = []

        // Tours
        for tour in tours.prefix(5) {
            let date = parseDate(tour.created_at ?? tour.requested_date) ?? Date.distantPast
            items.append(HomeActivityItem(
                id: "tour_\(tour.id)",
                icon: tour.status == "pending" ? "calendar.badge.clock" : "calendar.badge.checkmark",
                iconColor: tour.status == "pending" ? .rdOrange : Color.rdGreen,
                title: "\(tour.client_name) solicito visita",
                subtitle: "\(tour.listing_title) · \(tour.requested_date) \(formatTime(tour.requested_time))",
                time: date,
                actions: tour.status == "pending" ? [
                    HomeQuickAction(label: "Confirmar", icon: "checkmark", color: Color.rdGreen) {
                        Task { try? await api.updateTourStatus(tourId: tour.id, status: "confirmed") }
                    },
                ] : []
            ))
        }

        // Conversations with unread
        let myId = api.currentUser?.id ?? ""
        for conv in conversations.prefix(5) {
            let isClient = conv.clientId == myId
            let unread = isClient ? (conv.unreadClient ?? 0) : (conv.unreadBroker ?? 0)
            if unread > 0 {
                let date = parseDate(conv.updatedAt) ?? Date.distantPast
                let otherName = isClient ? (conv.brokerName ?? "Agente") : conv.clientName
                items.append(HomeActivityItem(
                    id: "conv_\(conv.id)",
                    icon: "bubble.left.fill",
                    iconColor: Color.rdBlue,
                    title: "\(otherName) envio un mensaje",
                    subtitle: conv.propertyTitle + (conv.lastMessage.map { " · \($0.prefix(40))" } ?? ""),
                    time: date,
                    actions: [
                        HomeQuickAction(label: "Responder", icon: "arrowshape.turn.up.left.fill", color: Color.rdBlue) {
                            onTapMessages()
                        },
                    ]
                ))
            }
        }

        return items.sorted { $0.time > $1.time }
    }

    // MARK: - Helpers

    private func formatTime(_ time: String) -> String {
        let parts = time.split(separator: ":")
        guard parts.count >= 2, let h = Int(parts[0]) else { return time }
        let m = parts[1]
        let ampm = h >= 12 ? "PM" : "AM"
        let h12 = h > 12 ? h - 12 : (h == 0 ? 12 : h)
        return "\(h12):\(m) \(ampm)"
    }

    private func formatCurrency(_ v: Double) -> String {
        if v >= 1_000_000 { return String(format: "$%.1fM", v / 1_000_000) }
        if v >= 1_000 { return String(format: "$%.0fK", v / 1_000) }
        return "$\(Int(v))"
    }

    private func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fmt.date(from: s) { return d }
        fmt.formatOptions = [.withInternetDateTime]
        if let d = fmt.date(from: s) { return d }
        let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd"
        return df.date(from: s)
    }
}

// MARK: - KPI Card Component

struct KPICard: View {
    let icon: String
    let label: String
    let value: String
    var trend: String? = nil
    var trendPositive: Bool = true
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                    .font(.footnote)
                    .foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                Spacer()
            }

            Text(value)
                .font(.title2.bold())
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let t = trend {
                Text(t)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(trendPositive ? Color.rdGreen : Color.rdRed)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Activity Item Models

struct HomeActivityItem: Identifiable {
    let id: String
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    let time: Date
    let actions: [HomeQuickAction]

    var timeAgo: String {
        let diff = Date().timeIntervalSince(time)
        if diff < 60 { return "Ahora" }
        if diff < 3600 { return "\(Int(diff / 60))m" }
        if diff < 86400 { return "\(Int(diff / 3600))h" }
        return "\(Int(diff / 86400))d"
    }
}

struct HomeQuickAction: Identifiable {
    let id = UUID()
    let label: String
    let icon: String
    let color: Color
    let action: () -> Void
}

// MARK: - DateFormatter Extension

private extension DateFormatter {
    static let yyyyMMdd: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }()
}
