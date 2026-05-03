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
        VStack(alignment: .leading, spacing: 6) {
            Text(greeting.uppercased())
                .font(.system(size: 11, weight: .heavy))
                .tracking(1.2)
                .foregroundStyle(.secondary)
            Text(userName.isEmpty ? "Bienvenido" : userName)
                .font(.system(size: 28, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            HStack(spacing: 6) {
                Text(api.currentUser?.role.capitalized ?? "Agente")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 3)
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
                    todayRow(icon: "doc.text.fill", iconColor: .orange, label: "\(pendingApps) aplicaciones en revision") {
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
                ZStack {
                    Circle().fill(iconColor.opacity(0.13)).frame(width: 34, height: 34)
                    Image(systemName: icon)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(iconColor)
                }
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
            sectionTitle("Métricas", systemImage: "chart.bar.fill")

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                KPICard(
                    icon: "doc.text.fill",
                    label: "Aplicaciones",
                    value: "\(analytics?.totalApps ?? 0)",
                    delta: (analytics?.newThisMonth ?? 0) > 0 ? "+\(analytics?.newThisMonth ?? 0)" : nil,
                    deltaPositive: true,
                    footnote: (analytics?.newThisMonth ?? 0) > 0 ? "este mes" : nil,
                    color: Color.rdBlue
                )
                KPICard(
                    icon: "arrow.triangle.2.circlepath",
                    label: "Tasa Conversión",
                    value: String(format: "%.1f%%", (analytics?.conversionRate ?? 0) * 100),
                    delta: nil,
                    deltaPositive: true,
                    footnote: "vs total",
                    color: .orange
                )
                if showSalesMetrics {
                    KPICard(
                        icon: "dollarsign.circle.fill",
                        label: "Ingresos",
                        value: formatCurrency(sales?.totalRevenue ?? 0),
                        delta: (sales?.totalSales ?? 0) > 0 ? "\(sales?.totalSales ?? 0)" : nil,
                        deltaPositive: true,
                        footnote: "ventas",
                        color: Color.rdGreen
                    )
                }
                KPICard(
                    icon: "clock.fill",
                    label: "Días Prom. Cierre",
                    value: String(format: "%.0f", analytics?.avgDaysToClose ?? 0),
                    delta: nil,
                    deltaPositive: false,
                    footnote: "días",
                    color: .purple
                )
            }
        }
    }

    // MARK: - Pipeline Funnel

    private struct PipelineStageInfo {
        let label: String
        let count: Int
        let color: Color
        let status: String
    }

    private var pipelineStages: [PipelineStageInfo] {
        [
            .init(label: "Enviadas",   count: analytics?.enviadas   ?? 0, color: Color.rdBlue,  status: "aplicado"),
            .init(label: "Revisión",   count: analytics?.enRevision ?? 0, color: .orange,       status: "en_revision"),
            .init(label: "Aprobadas",  count: analytics?.aprobadas  ?? 0, color: Color.rdGreen, status: "aprobado"),
            .init(label: "Rechazadas", count: analytics?.rechazadas ?? 0, color: Color.rdRed,   status: "rechazado"),
            .init(label: "Cerradas",   count: analytics?.cerradas   ?? 0, color: .purple,       status: "completado"),
        ]
    }

    private var pipelineSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Pipeline", systemImage: "arrow.right.arrow.left")

            // Donut summary card — total leads in the center, segments
            // sized by stage. Mirrors the web's lead-funnel donut.
            VStack(alignment: .leading, spacing: 14) {
                let total = pipelineStages.reduce(0) { $0 + $1.count }
                HStack(spacing: 18) {
                    ZStack {
                        DonutChart(
                            segments: pipelineStages.map { .init(value: $0.count, color: $0.color) },
                            lineWidth: 16
                        )
                        .frame(width: 108, height: 108)

                        VStack(spacing: 0) {
                            Text("\(total)")
                                .font(.title3.bold())
                            Text("aplicaciones")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(pipelineStages, id: \.status) { stage in
                            HStack(spacing: 8) {
                                Circle().fill(stage.color).frame(width: 8, height: 8)
                                Text(stage.label)
                                    .font(.caption)
                                Spacer()
                                Text("\(stage.count)")
                                    .font(.caption.bold())
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))

            // Tap-to-filter chips — quick affordance to jump straight
            // into the Aplicaciones tab pre-filtered by status.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(pipelineStages, id: \.status) { stage in
                        pipelineStage(stage)
                    }
                }
            }
        }
    }

    private func pipelineStage(_ stage: PipelineStageInfo) -> some View {
        Button {
            onTapPipelineStage(stage.status)
        } label: {
            HStack(spacing: 8) {
                Text("\(stage.count)")
                    .font(.subheadline.bold())
                    .foregroundStyle(stage.color)
                Text(stage.label)
                    .font(.caption.bold())
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(stage.color.opacity(0.10), in: Capsule())
            .overlay(Capsule().stroke(stage.color.opacity(0.22), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Team Leaderboard

    private var leaderboardSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Ranking del Equipo", systemImage: "trophy.fill")

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
                                .font(.system(size: 12, weight: .bold))
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
            sectionTitle("Actividad Reciente", systemImage: "clock.arrow.circlepath")

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
            ZStack {
                Circle().fill(item.iconColor.opacity(0.13)).frame(width: 34, height: 34)
                if let initials = item.avatarInitials, !initials.isEmpty {
                    Text(initials)
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(item.iconColor)
                } else {
                    Image(systemName: item.icon)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(item.iconColor)
                }
            }

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
                                    .font(.system(size: 10, weight: .bold))
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
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    // MARK: - Build Activity Items

    private func buildActivityItems() -> [HomeActivityItem] {
        var items: [HomeActivityItem] = []

        // Tours
        for tour in tours.prefix(5) {
            let date = parseDate(tour.created_at) ?? Date.distantPast
            items.append(HomeActivityItem(
                id: "tour_\(tour.id)",
                icon: tour.status == "pending" ? "calendar.badge.clock" : "calendar.badge.checkmark",
                iconColor: tour.status == "pending" ? .orange : Color.rdGreen,
                title: "\(tour.client_name) solicitó visita",
                subtitle: "\(tour.listing_title) · \(tour.requested_date) \(formatTime(tour.requested_time))",
                time: date,
                actions: tour.status == "pending" ? [
                    HomeQuickAction(label: "Confirmar", icon: "checkmark", color: Color.rdGreen) {
                        Task { try? await api.updateTourStatus(tourId: tour.id, status: "confirmed") }
                    },
                ] : [],
                avatarInitials: initials(tour.client_name)
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
                    title: "\(otherName) envió un mensaje",
                    subtitle: conv.propertyTitle + (conv.lastMessage.map { " · \($0.prefix(40))" } ?? ""),
                    time: date,
                    actions: [
                        HomeQuickAction(label: "Responder", icon: "arrowshape.turn.up.left.fill", color: Color.rdBlue) {
                            onTapMessages()
                        },
                    ],
                    avatarInitials: initials(otherName)
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

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let chars = parts.compactMap { $0.first }.map { String($0) }
        return chars.joined().uppercased()
    }

    private func sectionTitle(_ text: String, systemImage: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.rdBlue)
            Text(text)
                .font(.system(size: 17, weight: .heavy))
                .tracking(-0.2)
            Spacer()
        }
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
//
// Mirrors the web dashboard's stat cards: tinted icon circle in the top-
// left, a colored ↑/↓ delta pill on the top-right, large value, label,
// and a small footnote line. The delta pill is hidden when no delta is
// available (some metrics — e.g. avg-days-to-close — don't have a
// period-over-period number to show).

struct KPICard: View {
    let icon: String
    let label: String
    let value: String
    var delta: String? = nil
    var deltaPositive: Bool = true
    var footnote: String? = nil
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                ZStack {
                    Circle().fill(color.opacity(0.13)).frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(color)
                }
                Spacer()
                if let d = delta {
                    HStack(spacing: 2) {
                        Image(systemName: deltaPositive ? "arrow.up" : "arrow.down")
                            .font(.system(size: 9, weight: .heavy))
                        Text(d)
                            .font(.system(size: 10, weight: .heavy))
                    }
                    .foregroundStyle(deltaPositive ? Color.rdGreen : Color.rdRed)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background((deltaPositive ? Color.rdGreen : Color.rdRed).opacity(0.13), in: Capsule())
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(value)
                    .font(.system(size: 26, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                HStack(spacing: 4) {
                    Text(label)
                        .font(.caption.bold())
                        .foregroundStyle(.primary)
                    if let f = footnote {
                        Text("· \(f)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
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
    /// When non-nil, the avatar circle shows these initials instead of
    /// the SF Symbol icon. Used for activity items that are tied to a
    /// specific person (clients, agents) so the feed reads more like
    /// the web's activity timeline.
    var avatarInitials: String? = nil

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
