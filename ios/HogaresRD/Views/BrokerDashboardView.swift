import SwiftUI
import SafariServices

// MARK: - Broker Dashboard (Main)

struct BrokerDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var selectedTab = 0

    private let tabs = ["Inicio", "Aplicaciones", "Contactos", "Pagos", "Analiticas", "Ventas", "Contabilidad", "Archivo", "Auditoria", "Propiedades"]

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(tabs.enumerated()), id: \.offset) { i, title in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) { selectedTab = i }
                            } label: {
                                HStack(spacing: 4) {
                                    if i == 0 {
                                        Image(systemName: "house.fill")
                                            .font(.system(size: 10))
                                    }
                                    Text(title)
                                        .font(.caption).bold()
                                }
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(selectedTab == i ? Color.rdBlue : Color(.secondarySystemFill))
                                .foregroundStyle(selectedTab == i ? .white : .primary)
                                .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .id(i)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                }
                .onChange(of: selectedTab) {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo(selectedTab, anchor: .center)
                    }
                }
            }
            .background(Color(.systemBackground))

            Divider()

            // Content
            TabView(selection: $selectedTab) {
                DashboardHomeView(
                    showSalesMetrics: true,
                    onTapTab: { tab in selectedTab = tab + 1 },
                    onTapMessages: {},
                    onTapTours: {}
                ).tag(0)
                DashboardApplicationsTab().tag(1)
                ContactsListView().tag(2)
                PaymentsTabView().tag(3)
                DashboardAnalyticsTab().tag(4)
                DashboardSalesTab().tag(5)
                DashboardAccountingTab().tag(6)
                DashboardArchiveTab().tag(7)
                DashboardAuditTab().tag(8)
                DashboardListingAnalyticsTab().tag(9)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .environmentObject(api)
        }
        .navigationTitle("Dashboard")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                // Quick access to messages with the existing red unread
                // badge behavior driven by ContentView's poll loop.
                NavigationLink {
                    ConversationsView().environmentObject(api)
                } label: {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.title3)
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                brokerMoreMenu
            }
        }
    }

    /// The "Más" menu mirrors the web broker dashboard sidebar: it
    /// exposes every page/view that the web sidebar has so iOS-only
    /// users never have to reach for a computer. Sections are:
    ///   1. Communication  — Chat IA, Mensajes, Notificaciones
    ///   2. Workflow       — Tareas, Tours, Disponibilidad
    ///   3. Marketing      — Publicidad
    ///   4. Team mgmt      — only shown to inmobiliaria/constructora
    ///   5. Settings       — Publicar, Configuración, Abrir en web
    @ViewBuilder
    private var brokerMoreMenu: some View {
        let role = api.currentUser?.role ?? ""
        let isInmOwner = ["inmobiliaria", "constructora"].contains(role)

        Menu {
            // ── Communication ──
            Section("Comunicación") {
                NavigationLink {
                    ChatIAView().environmentObject(api)
                } label: {
                    Label("Chat IA", systemImage: "brain.head.profile.fill")
                }
                NavigationLink {
                    ConversationsView().environmentObject(api)
                } label: {
                    Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill")
                }
                NavigationLink {
                    NotificationsView().environmentObject(api)
                } label: {
                    Label("Notificaciones", systemImage: "bell.fill")
                }
            }

            // ── Workflow ──
            Section("Trabajo") {
                NavigationLink {
                    TasksView().environmentObject(api)
                } label: {
                    Label("Tareas", systemImage: "checklist")
                }
                NavigationLink {
                    BrokerToursView().environmentObject(api)
                } label: {
                    Label("Solicitudes de visita", systemImage: "calendar.badge.clock")
                }
                NavigationLink {
                    BrokerAvailabilityView().environmentObject(api)
                } label: {
                    Label("Disponibilidad", systemImage: "clock.badge.checkmark")
                }
            }

            // ── Marketing ──
            Section("Marketing") {
                NavigationLink {
                    AdCampaignsView().environmentObject(api)
                } label: {
                    Label("Publicidad (Meta Ads)", systemImage: "megaphone.fill")
                }
            }

            // ── Team management (inmobiliaria owners only) ──
            if isInmOwner {
                Section("Gestión de Equipo") {
                    NavigationLink {
                        InmobiliariaTeamListView().environmentObject(api)
                    } label: {
                        Label("Mis agentes", systemImage: "person.2.fill")
                    }
                    NavigationLink {
                        InmobiliariaRequestsListView().environmentObject(api)
                    } label: {
                        Label("Solicitudes de afiliación", systemImage: "person.badge.plus")
                    }
                    NavigationLink {
                        InmobiliariaPerformanceListView().environmentObject(api)
                    } label: {
                        Label("Rendimiento del equipo", systemImage: "chart.line.uptrend.xyaxis")
                    }
                }
            }

            // ── Property & settings ──
            Section {
                NavigationLink {
                    SubmitListingView()
                } label: {
                    Label("Publicar propiedad", systemImage: "plus.circle.fill")
                }
                NavigationLink {
                    DashboardSettingsView().environmentObject(api)
                } label: {
                    Label("Configuración", systemImage: "gearshape.fill")
                }
                Link(destination: URL(string: "https://hogaresrd.com/broker")!) {
                    Label("Abrir en web", systemImage: "safari.fill")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
        }
    }
}

// MARK: - Stat Card Component

struct DashStatCard: View {
    let icon: String
    let label: String
    let value: String
    let color: Color
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(color)
                    .frame(width: 30, height: 30)
                    .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                Spacer()
            }
            Text(value)
                .font(.title2).bold()
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let sub = subtitle {
                Text(sub)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Status Badge

struct StatusBadge: View {
    let status: String

    private var label: String {
        switch status.lowercased() {
        case "submitted", "pendiente":    return "Pendiente"
        case "reviewing", "en_revision":  return "En Revisión"
        case "docs_pending":              return "Docs Pendientes"
        case "approved", "aprobada":      return "Aprobada"
        case "rejected", "rechazada":     return "Rechazada"
        case "closed", "cerrada":         return "Cerrada"
        case "verified", "verificado":    return "Verificado"
        case "uploaded", "subido":        return "Subido"
        default:                          return status.capitalized
        }
    }

    private var color: Color {
        switch status.lowercased() {
        case "submitted", "pendiente", "reviewing", "en_revision", "docs_pending", "uploaded", "subido":
            return .orange
        case "approved", "aprobada", "verified", "verificado", "closed", "cerrada":
            return .green
        case "rejected", "rechazada":
            return .red
        default:
            return .secondary
        }
    }

    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .bold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 1: Aplicaciones
// ────────────────────────────────────────────────────────────────────

struct DashboardApplicationsTab: View {
    @EnvironmentObject var api: APIService
    @State private var analytics: DashboardAnalytics?
    @State private var applications: [Application] = []
    @State private var loading = true
    @State private var filterStatus = "all"

    private var filtered: [Application] {
        if filterStatus == "all" { return applications }
        // Filter groups mirror the web dashboard's filter pills. Each
        // entry maps a group key to the set of backend status values
        // it covers (so "Documentos" captures both requested + sent +
        // insufficient variants in one tap).
        let groups: [String: Set<String>] = [
            "aplicado":      ["aplicado"],
            "en_revision":   ["en_revision"],
            "documentos":    ["documentos_requeridos", "documentos_enviados", "documentos_insuficientes"],
            "en_aprobacion": ["en_aprobacion", "reservado"],
            "aprobado":      ["aprobado", "pendiente_pago", "pago_enviado", "pago_aprobado"],
            "completado":    ["completado"],
            "rechazado":     ["rechazado"],
        ]
        let keys = groups[filterStatus] ?? [filterStatus]
        return applications.filter { keys.contains($0.status) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Stats row
                if let a = analytics {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            DashStatCard(icon: "doc.text.fill", label: "Total", value: "\(a.totalApps)", color: .blue)
                                .frame(width: 140)
                            DashStatCard(icon: "clock.fill", label: "En Revisión", value: "\(a.enRevision)", color: .orange)
                                .frame(width: 140)
                            DashStatCard(icon: "exclamationmark.triangle.fill", label: "Docs Pendientes", value: "\(a.docsPendientes)", color: .orange)
                                .frame(width: 140)
                            DashStatCard(icon: "checkmark.circle.fill", label: "Aprobadas", value: "\(a.aprobadas)", color: .green)
                                .frame(width: 140)
                            DashStatCard(icon: "xmark.circle.fill", label: "Rechazadas", value: "\(a.rechazadas)", color: .red)
                                .frame(width: 140)
                        }
                        .padding(.horizontal)
                    }
                }

                // Filter pills — values match the backend status keys
                // so the filter actually matches rows. The set of pills
                // mirrors the web dashboard's filter row order.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        filterPill("Todas",         value: "all")
                        filterPill("Aplicadas",     value: "aplicado")
                        filterPill("En Revisión",   value: "en_revision")
                        filterPill("Documentos",    value: "documentos")
                        filterPill("En Aprobación", value: "en_aprobacion")
                        filterPill("Aprobadas",     value: "aprobado")
                        filterPill("Completadas",   value: "completado")
                        filterPill("Rechazadas",    value: "rechazado")
                    }
                    .padding(.horizontal)
                }

                // Application list
                if loading {
                    ProgressView("Cargando aplicaciones...")
                        .padding(.top, 40)
                } else if filtered.isEmpty {
                    emptyState(icon: "doc.text.magnifyingglass", title: "Sin aplicaciones", subtitle: "No hay aplicaciones con este filtro.")
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(filtered) { app in
                            NavigationLink {
                                ApplicationDetailView(id: app.id)
                                    .environmentObject(api)
                            } label: {
                                ApplicationRow(app: app)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func filterPill(_ label: String, value: String) -> some View {
        Button {
            filterStatus = value
        } label: {
            Text(label)
                .font(.caption2).bold()
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(filterStatus == value ? Color.rdBlue : Color(.tertiarySystemFill))
                .foregroundStyle(filterStatus == value ? .white : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        loading = true
        async let analyticsTask = try? api.getDashboardAnalytics()
        async let appsTask = try? api.getApplications()
        analytics = await analyticsTask
        applications = await appsTask ?? []
        loading = false
    }
}

struct ApplicationRow: View {
    let app: Application

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(app.listingTitle)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                    Text(app.priceFormatted)
                        .font(.caption)
                        .foregroundStyle(Color.rdBlue)
                }
                Spacer()
                StatusBadge(status: app.status)
            }
            HStack(spacing: 12) {
                Label(app.intent.capitalized, systemImage: "tag.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Label(app.timeAgo, systemImage: "clock")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 2: Analíticas
// ────────────────────────────────────────────────────────────────────

struct DashboardAnalyticsTab: View {
    @EnvironmentObject var api: APIService
    @State private var analytics: DashboardAnalytics?
    @State private var loading = true
    @State private var range = "30d"

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Range picker
                Picker("Rango", selection: $range) {
                    Text("7 días").tag("7d")
                    Text("30 días").tag("30d")
                    Text("90 días").tag("90d")
                    Text("12 meses").tag("12m")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .onChange(of: range) { _, _ in Task { await load() } }

                if loading {
                    ProgressView().padding(.top, 40)
                } else if let a = analytics {
                    // Metric cards
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        DashStatCard(icon: "doc.text.fill", label: "Total Aplicaciones", value: "\(a.totalApps)", color: .blue)
                        DashStatCard(icon: "chart.line.uptrend.xyaxis", label: "Tasa de Conversión", value: String(format: "%.1f%%", a.conversionRate * 100), color: .green)
                        DashStatCard(icon: "calendar.badge.clock", label: "Días Prom. al Cierre", value: String(format: "%.0f", a.avgDaysToClose), color: .blue)
                        DashStatCard(icon: "sparkles", label: "Nuevas Este Mes", value: "\(a.newThisMonth)", color: .purple)
                    }
                    .padding(.horizontal)

                    // Pipeline breakdown
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Pipeline")
                            .font(.headline)
                            .padding(.horizontal)

                        VStack(spacing: 8) {
                            pipelineRow("Enviadas", count: a.enviadas, color: .gray)
                            pipelineRow("En Revisión", count: a.enRevision, color: .orange)
                            pipelineRow("Aprobadas", count: a.aprobadas, color: .green)
                            pipelineRow("Rechazadas", count: a.rechazadas, color: .red)
                            pipelineRow("Cerradas", count: a.cerradas, color: .blue)
                        }
                        .padding(.horizontal)
                    }

                    // Top listings
                    if !a.topListings.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Top Propiedades por Aplicaciones")
                                .font(.headline)
                                .padding(.horizontal)

                            ForEach(a.topListings) { item in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.title)
                                            .font(.subheadline).bold()
                                            .lineLimit(1)
                                        if let loc = item.location {
                                            Text(loc)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Text("\(item.appCount)")
                                        .font(.title3).bold()
                                        .foregroundStyle(Color.rdBlue)
                                }
                                .padding(12)
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .padding(.horizontal)
                            }
                        }
                    }

                    // Monthly trend
                    if !a.appsPerMonth.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Aplicaciones por Mes")
                                .font(.headline)
                                .padding(.horizontal)

                            SimpleBarChart(data: a.appsPerMonth.suffix(12).map { ($0.month, $0.count) })
                                .frame(height: 160)
                                .padding(.horizontal)
                        }
                    }
                }
            }
            .padding(.vertical)
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func pipelineRow(_ label: String, count: Int, color: Color) -> some View {
        HStack {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(label).font(.subheadline)
            Spacer()
            Text("\(count)")
                .font(.subheadline).bold()
                .foregroundStyle(color)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func load() async {
        loading = true
        analytics = try? await api.getDashboardAnalytics(range: range)
        loading = false
    }
}

// MARK: - Simple Bar Chart (no Charts framework needed)

struct SimpleBarChart: View {
    let data: [(label: String, value: Int)]

    private var maxValue: Int { data.map(\.value).max() ?? 1 }

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(data.enumerated()), id: \.offset) { i, item in
                VStack(spacing: 4) {
                    Text("\(item.value)")
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.rdBlue.gradient)
                        .frame(height: maxValue > 0 ? CGFloat(item.value) / CGFloat(maxValue) * 120 : 0)
                    Text(shortMonth(item.label))
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func shortMonth(_ s: String) -> String {
        // "2026-01" → "Ene"
        let months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]
        if s.count >= 7, let m = Int(s.suffix(2)), m >= 1, m <= 12 {
            return months[m - 1]
        }
        return String(s.suffix(3))
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 3: Ventas
// ────────────────────────────────────────────────────────────────────

struct DashboardSalesTab: View {
    @EnvironmentObject var api: APIService
    @State private var sales: DashboardSales?
    @State private var loading = true

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if loading {
                    ProgressView().padding(.top, 40)
                } else if let s = sales {
                    // Metric cards
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        DashStatCard(icon: "dollarsign.circle.fill", label: "Ingresos Totales", value: formatCurrency(s.totalRevenue), color: .green)
                        DashStatCard(icon: "chart.bar.fill", label: "Total Ventas", value: "\(s.totalSales)", color: .blue)
                        DashStatCard(icon: "tag.fill", label: "Precio Promedio", value: formatCurrency(s.avgSalePrice), color: .purple)
                        DashStatCard(icon: "hourglass", label: "Valor Pipeline", value: formatCurrency(s.activePipelineValue), color: .orange)
                    }
                    .padding(.horizontal)

                    // Sales by type
                    if !s.salesByType.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Ventas por Tipo")
                                .font(.headline)
                                .padding(.horizontal)

                            ForEach(s.salesByType) { item in
                                HStack {
                                    Circle()
                                        .fill(item.type == "venta" ? Color.rdGreen : item.type == "alquiler" ? Color.rdBlue : Color.rdRed)
                                        .frame(width: 10, height: 10)
                                    Text(typeLabel(item.type))
                                        .font(.subheadline)
                                    Spacer()
                                    VStack(alignment: .trailing) {
                                        Text("\(item.count) ventas")
                                            .font(.caption).bold()
                                        Text(formatCurrency(item.revenue))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .padding(12)
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .padding(.horizontal)
                            }
                        }
                    }

                    // Recent sales
                    if !s.completedSales.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Ventas Recientes")
                                .font(.headline)
                                .padding(.horizontal)

                            ForEach(s.completedSales) { sale in
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(sale.property ?? "Propiedad")
                                            .font(.subheadline).bold()
                                            .lineLimit(1)
                                        if let client = sale.client {
                                            Text(client)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 3) {
                                        Text(sale.priceFormatted)
                                            .font(.subheadline).bold()
                                            .foregroundStyle(Color.rdBlue)
                                        if let ps = sale.paymentStatus {
                                            StatusBadge(status: ps)
                                        }
                                    }
                                }
                                .padding(12)
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .padding(.horizontal)
                            }
                        }
                    }

                    if s.totalSales == 0 {
                        emptyState(icon: "chart.bar.xaxis", title: "Sin ventas", subtitle: "Tus ventas completadas aparecerán aquí.")
                    }
                }
            }
            .padding(.vertical)
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        sales = try? await api.getDashboardSales()
        loading = false
    }

    private func typeLabel(_ t: String) -> String {
        switch t {
        case "venta":    return "En Venta"
        case "alquiler": return "En Alquiler"
        case "proyecto": return "Nuevo Proyecto"
        default:         return t.capitalized
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 4: Contabilidad
// ────────────────────────────────────────────────────────────────────

struct DashboardAccountingTab: View {
    @EnvironmentObject var api: APIService
    @State private var loading  = true
    @State private var response: CommissionsSummaryResponse?
    @State private var filter:   CommissionFilter = .all
    @State private var errorMsg: String?
    @State private var editingRow: CommissionRow?
    @State private var reviewingRow: CommissionRow?

    enum CommissionFilter: String, CaseIterable, Identifiable {
        case all             = "Todas"
        case pending_review  = "Pendientes"
        case approved        = "Aprobadas"
        case rejected        = "Rechazadas"
        var id: String { rawValue }
        var statusKey: String? {
            switch self {
            case .all:             return nil
            case .pending_review:  return "pending_review"
            case .approved:        return "approved"
            case .rejected:        return "rejected"
            }
        }
    }

    private var isInmView: Bool {
        ["inmobiliaria", "constructora"].contains(response?.role ?? "")
    }

    private var filteredRows: [CommissionRow] {
        let rows = response?.commissions ?? []
        guard let status = filter.statusKey else { return rows }
        return rows.filter { $0.commission.status == status }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if loading {
                    ProgressView().padding(.top, 40)
                } else if let err = errorMsg, response == nil {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 32)).foregroundStyle(.orange)
                        Text(err).font(.subheadline).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.rdBlue)
                    }
                    .padding(32)
                } else if let r = response {
                    // Metric cards
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        DashStatCard(
                            icon: "checkmark.seal.fill",
                            label: "Aprobadas",
                            value: formatCurrency(r.summary.agent_approved),
                            color: .green,
                            subtitle: "Neto al agente"
                        )
                        DashStatCard(
                            icon: "hourglass",
                            label: "Pendientes",
                            value: formatCurrency(r.summary.agent_pending),
                            color: .orange,
                            subtitle: "\(r.summary.total_pending_count) sin revisar"
                        )
                        if isInmView {
                            DashStatCard(
                                icon: "building.2.fill",
                                label: "Cuota Inmobiliaria",
                                value: formatCurrency(r.summary.inmobiliaria_approved),
                                color: .blue,
                                subtitle: "Aprobada del equipo"
                            )
                        }
                        DashStatCard(
                            icon: "chart.line.uptrend.xyaxis",
                            label: "Ventas Totales",
                            value: formatCurrency(r.summary.agent_total_sales),
                            color: .purple,
                            subtitle: "Monto aprobado"
                        )
                    }
                    .padding(.horizontal)

                    // Filter chips
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(CommissionFilter.allCases) { f in
                                Button {
                                    filter = f
                                } label: {
                                    Text(f.rawValue)
                                        .font(.caption).bold()
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(filter == f ? Color.rdBlue : Color(.secondarySystemFill))
                                        .foregroundStyle(filter == f ? .white : .primary)
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)
                    }

                    // Commission rows
                    if filteredRows.isEmpty {
                        emptyState(
                            icon: "banknote",
                            title: "Sin comisiones",
                            subtitle: isInmView
                                ? "Los agentes de tu inmobiliaria todavía no han registrado comisiones."
                                : "Registra la comisión de tus ventas cerradas desde la aplicación."
                        )
                        .padding(.top, 16)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(filteredRows) { row in
                                commissionCard(row)
                            }
                        }
                        .padding(.horizontal)
                    }
                }
            }
            .padding(.vertical)
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editingRow) { row in
            CommissionFormSheet(row: row, mode: .edit) {
                Task { await load() }
            }
            .environmentObject(api)
        }
        .sheet(item: $reviewingRow) { row in
            CommissionFormSheet(row: row, mode: .review) {
                Task { await load() }
            }
            .environmentObject(api)
        }
    }

    // MARK: - Row card

    @ViewBuilder
    private func commissionCard(_ row: CommissionRow) -> some View {
        let c = row.commission
        let iAmAgent = row.agent_user_id == api.currentUser?.id
        let iAmInmOwner = isInmView
        let canReview = iAmInmOwner && c.status == "pending_review"
        let canEdit   = iAmAgent && (c.status == "pending_review" || c.status == "rejected")

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.listing_title ?? "Propiedad")
                        .font(.subheadline).bold()
                        .lineLimit(2)
                    if let client = row.client_name, !client.isEmpty {
                        Text(client)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if isInmView, let agent = row.agent_name, !agent.isEmpty {
                        Label(agent, systemImage: "person.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                commissionStatusPill(c.status)
            }

            // Numbers grid
            VStack(spacing: 6) {
                commissionRowLine(
                    label: "Venta",
                    value: formatCurrency(c.sale_amount),
                    valueColor: .primary
                )
                commissionRowLine(
                    label: "Comisión agente",
                    value: "\(pctLabel(c.agent_percent)) · \(formatCurrency(c.agent_amount))",
                    valueColor: .primary
                )
                if c.inmobiliaria_amount > 0 {
                    commissionRowLine(
                        label: "Cuota inmobiliaria",
                        value: "\(pctLabel(c.inmobiliaria_percent)) · \(formatCurrency(c.inmobiliaria_amount))",
                        valueColor: .blue
                    )
                }
                Divider().padding(.vertical, 2)
                commissionRowLine(
                    label: "Neto al agente",
                    value: formatCurrency(c.agent_net),
                    valueColor: .green,
                    bold: true
                )
            }

            if let note = c.adjustment_note, !note.isEmpty {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "text.bubble").font(.caption)
                        .foregroundStyle(.secondary)
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 2)
            }

            if canReview || canEdit {
                HStack(spacing: 8) {
                    if canReview {
                        Button {
                            reviewingRow = row
                        } label: {
                            Text("Revisar")
                                .font(.caption).bold()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 9)
                                .background(Color.rdBlue)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                    if canEdit {
                        Button {
                            editingRow = row
                        } label: {
                            Text("Editar")
                                .font(.caption).bold()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 9)
                                .background(Color(.secondarySystemFill))
                                .foregroundStyle(Color.rdBlue)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func commissionRowLine(label: String, value: String, valueColor: Color, bold: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(bold ? .subheadline.bold() : .subheadline)
                .foregroundStyle(valueColor)
        }
    }

    private func commissionStatusPill(_ status: String) -> some View {
        let (label, bg, fg): (String, Color, Color) = {
            switch status {
            case "pending_review": return ("Pendiente", Color.orange.opacity(0.15), .orange)
            case "approved":       return ("Aprobada",  Color.green.opacity(0.15),  .green)
            case "rejected":       return ("Rechazada", Color.red.opacity(0.15),    .red)
            default:               return (status.capitalized, Color.gray.opacity(0.15), .gray)
            }
        }()
        return Text(label)
            .font(.caption2).bold()
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(bg)
            .foregroundStyle(fg)
            .clipShape(Capsule())
    }

    private func pctLabel(_ n: Double) -> String {
        if n.truncatingRemainder(dividingBy: 1) == 0 { return "\(Int(n))%" }
        return String(format: "%.1f%%", n)
    }

    private func load() async {
        loading = true
        errorMsg = nil
        do {
            response = try await api.fetchCommissionsSummary()
        } catch {
            if case .server(let msg)? = error as? APIError { errorMsg = msg }
            else { errorMsg = "Error al cargar comisiones" }
        }
        loading = false
    }
}

// MARK: - Commission Form Sheet (submit / edit / review)

struct CommissionFormSheet: View {
    enum Mode { case edit, review }

    let row: CommissionRow
    let mode: Mode
    let onSaved: () -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var saleAmount  = ""
    @State private var agentPct    = ""
    @State private var inmPct      = ""
    @State private var note        = ""
    @State private var saving      = false
    @State private var errorMsg:   String?
    @State private var showRejectConfirm = false

    private var saleValue: Double {
        let cleaned = saleAmount.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "$", with: "")
        return Double(cleaned.trimmingCharacters(in: .whitespaces)) ?? 0
    }
    private var agentPctValue: Double { Double(agentPct) ?? 0 }
    private var inmPctValue:   Double { Double(inmPct)   ?? 0 }

    private var agentAmount: Double  { saleValue * agentPctValue / 100 }
    private var inmAmount:   Double  { saleValue * inmPctValue / 100 }
    private var agentNet:    Double  { max(0, agentAmount - inmAmount) }

    private var canSubmit: Bool {
        saleValue > 0 && agentPctValue > 0 && inmPctValue <= agentPctValue
    }

    private var title: String {
        switch mode {
        case .review: return "Revisar comisión"
        case .edit:   return row.commission.sale_amount > 0 ? "Editar comisión" : "Registrar comisión"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.listing_title ?? "Propiedad")
                            .font(.subheadline).bold()
                        if let client = row.client_name, !client.isEmpty {
                            Text(client)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if mode == .review, let agent = row.agent_name, !agent.isEmpty {
                            Text("Enviado por \(agent)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Detalles de la comisión") {
                    HStack {
                        Text("Monto de venta (USD)")
                        Spacer()
                        TextField("150000", text: $saleAmount)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("% Comisión agente")
                        Spacer()
                        TextField("3", text: $agentPct)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 80)
                    }
                    HStack {
                        Text("% Cuota inmobiliaria")
                        Spacer()
                        TextField("0", text: $inmPct)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 80)
                    }
                }

                Section("Resumen") {
                    HStack {
                        Text("Total agente")
                            .foregroundStyle(.secondary).font(.caption)
                        Spacer()
                        Text(formatCurrency(agentAmount)).font(.subheadline.bold())
                    }
                    HStack {
                        Text("Cuota inmobiliaria")
                            .foregroundStyle(.secondary).font(.caption)
                        Spacer()
                        Text(formatCurrency(inmAmount)).font(.subheadline.bold())
                            .foregroundStyle(Color.rdBlue)
                    }
                    HStack {
                        Text("Neto al agente")
                            .bold()
                        Spacer()
                        Text(formatCurrency(agentNet))
                            .font(.headline.bold())
                            .foregroundStyle(.green)
                    }
                }

                Section("Nota (opcional)") {
                    TextField(mode == .review
                              ? "Motivo del ajuste o rechazo…"
                              : "Ej: firmado el 2026-04-15",
                              text: $note, axis: .vertical)
                        .lineLimit(2...4)
                }

                if let err = errorMsg {
                    Section {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "…" : (mode == .review ? "Aprobar" : "Enviar")) {
                        Task { await save(action: mode == .review ? "adjust" : "submit") }
                    }
                    .disabled(!canSubmit || saving)
                }
                if mode == .review {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(role: .destructive) {
                            showRejectConfirm = true
                        } label: {
                            Text("Rechazar")
                                .foregroundStyle(.red)
                        }
                        .disabled(saving)
                    }
                }
            }
            .alert("Rechazar comisión", isPresented: $showRejectConfirm) {
                Button("Cancelar", role: .cancel) { }
                Button("Rechazar", role: .destructive) {
                    Task { await save(action: "reject") }
                }
            } message: {
                Text("Indica una nota en el campo 'Nota' antes de rechazar, para que el agente sepa por qué.")
            }
        }
        .onAppear {
            let c = row.commission
            if c.sale_amount > 0 {
                saleAmount = String(format: "%g", c.sale_amount)
                agentPct   = String(format: "%g", c.agent_percent)
                inmPct     = String(format: "%g", c.inmobiliaria_percent)
            } else if let listingPrice = row.listing_price, listingPrice > 0 {
                saleAmount = String(format: "%g", listingPrice)
                agentPct   = "3"
                inmPct     = "0"
            } else {
                agentPct = "3"
                inmPct   = "0"
            }
        }
    }

    private func save(action: String) async {
        saving = true
        errorMsg = nil
        defer { saving = false }

        do {
            if mode == .review {
                if action == "reject" && note.trimmingCharacters(in: .whitespaces).isEmpty {
                    errorMsg = "Indica una nota para rechazar la comisión."
                    return
                }
                try await api.reviewCommission(
                    applicationId:       row.application_id,
                    action:              action,
                    saleAmount:          action == "adjust" ? saleValue      : nil,
                    agentPercent:        action == "adjust" ? agentPctValue  : nil,
                    inmobiliariaPercent: action == "adjust" ? inmPctValue    : nil,
                    note:                note.trimmingCharacters(in: .whitespaces)
                )
            } else {
                try await api.submitCommission(
                    applicationId:       row.application_id,
                    saleAmount:          saleValue,
                    agentPercent:        agentPctValue,
                    inmobiliariaPercent: inmPctValue,
                    note:                note.trimmingCharacters(in: .whitespaces)
                )
            }
            onSaved()
            dismiss()
        } catch {
            if case .server(let msg)? = error as? APIError { errorMsg = msg }
            else { errorMsg = "Error al guardar" }
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 5: Archivo
// ────────────────────────────────────────────────────────────────────

struct DashboardArchiveTab: View {
    @EnvironmentObject var api: APIService
    @State private var docs: DashboardDocuments?
    @State private var loading = true
    @State private var searchText = ""
    @State private var filterType = ""
    @State private var filterStatus = ""
    @State private var currentPage = 1
    @State private var reviewingDoc: ArchiveDocument?
    @State private var previewURL: ArchiveDocURL?

    private let docTypes = [
        ("", "Todos"),
        ("cedula", "Cédula"),
        ("pasaporte", "Pasaporte"),
        ("comprobante_ingresos", "Comprobante de Ingresos"),
        ("estado_cuenta", "Estado de Cuenta"),
        ("carta_trabajo", "Carta de Trabajo"),
        ("declaracion_impuestos", "Declaración de Impuestos"),
        ("pre_aprobacion", "Pre-Aprobación"),
        ("prueba_fondos", "Prueba de Fondos"),
        ("otro", "Otro")
    ]

    private let statusOptions = [
        ("", "Todos"),
        ("uploaded", "Subido"),
        ("approved", "Aprobado"),
        ("rejected", "Rechazado"),
        ("requested", "Solicitado")
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                // Search
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Buscar documento...", text: $searchText)
                        .font(.subheadline)
                        .onSubmit { Task { await load() } }
                }
                .padding(10)
                .background(Color(.secondarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)

                // Filters
                HStack(spacing: 10) {
                    Menu {
                        ForEach(docTypes, id: \.0) { value, label in
                            Button(label) {
                                filterType = value
                                Task { await load() }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.fill")
                            Text(filterType.isEmpty ? "Tipo" : docTypes.first { $0.0 == filterType }?.1 ?? "Tipo")
                            Image(systemName: "chevron.down").font(.caption2)
                        }
                        .font(.caption).bold()
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Capsule())
                    }

                    Menu {
                        ForEach(statusOptions, id: \.0) { value, label in
                            Button(label) {
                                filterStatus = value
                                Task { await load() }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "line.3.horizontal.decrease")
                            Text(filterStatus.isEmpty ? "Estado" : statusOptions.first { $0.0 == filterStatus }?.1 ?? "Estado")
                            Image(systemName: "chevron.down").font(.caption2)
                        }
                        .font(.caption).bold()
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Capsule())
                    }

                    Spacer()
                }
                .padding(.horizontal)

                // Documents
                if loading {
                    ProgressView().padding(.top, 40)
                } else if let d = docs {
                    if d.documents.isEmpty {
                        emptyState(icon: "archivebox", title: "Sin documentos", subtitle: "Los documentos de tus aplicaciones aparecerán aquí.")
                    } else {
                        LazyVStack(spacing: 8) {
                            ForEach(d.documents) { doc in
                                Button {
                                    reviewingDoc = doc
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: docIcon(doc.type))
                                            .font(.title3)
                                            .foregroundStyle(Color.rdBlue)
                                            .frame(width: 36)

                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(doc.name ?? "Documento")
                                                .font(.subheadline).bold()
                                                .lineLimit(1)
                                                .foregroundStyle(.primary)
                                            HStack(spacing: 8) {
                                                if let client = doc.client {
                                                    Text(client).font(.caption).foregroundStyle(.secondary)
                                                }
                                                if let prop = doc.property {
                                                    Text("·").font(.caption).foregroundStyle(.tertiary)
                                                    Text(prop).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                                }
                                            }
                                            HStack(spacing: 6) {
                                                if let size = doc.fileSize {
                                                    Text(size).font(.caption2).foregroundStyle(.tertiary)
                                                }
                                                if let date = doc.uploadDate {
                                                    Text(formatShort(date)).font(.caption2).foregroundStyle(.tertiary)
                                                }
                                            }
                                        }

                                        Spacer()

                                        VStack(alignment: .trailing, spacing: 4) {
                                            StatusBadge(status: doc.status ?? "pending")
                                            Image(systemName: "chevron.right")
                                                .font(.caption2)
                                                .foregroundStyle(.tertiary)
                                        }
                                    }
                                    .padding(12)
                                    .background(Color(.secondarySystemGroupedBackground))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)

                        // Pagination
                        if d.pages > 1 {
                            HStack(spacing: 14) {
                                Button {
                                    if currentPage > 1 { currentPage -= 1; Task { await load() } }
                                } label: {
                                    Image(systemName: "chevron.left")
                                }
                                .disabled(currentPage <= 1)

                                Text("Página \(d.page) de \(d.pages)")
                                    .font(.caption).foregroundStyle(.secondary)

                                Button {
                                    if currentPage < d.pages { currentPage += 1; Task { await load() } }
                                } label: {
                                    Image(systemName: "chevron.right")
                                }
                                .disabled(currentPage >= d.pages)
                            }
                            .padding()
                        }
                    }
                }
            }
            .padding(.vertical)
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $reviewingDoc) { doc in
            NavigationStack {
                ReviewDocumentSheet(
                    doc: doc,
                    onReviewed: {
                        reviewingDoc = nil
                        Task { await load() }
                    },
                    onPreview: {
                        if let appId = doc.appId, let docId = doc.docId,
                           let url = api.documentDownloadURL(applicationId: appId, documentId: docId) {
                            previewURL = ArchiveDocURL(url: url)
                        }
                    }
                )
                .environmentObject(api)
            }
        }
        .sheet(item: $previewURL) { wrap in
            ArchiveDocPreview(url: wrap.url)
                .ignoresSafeArea()
        }
    }

    private func load() async {
        loading = true
        docs = try? await api.getDashboardDocuments(
            status: filterStatus.isEmpty ? nil : filterStatus,
            type: filterType.isEmpty ? nil : filterType,
            search: searchText.isEmpty ? nil : searchText,
            page: currentPage
        )
        loading = false
    }

    private func formatShort(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let date = d else { return "" }
        let df = DateFormatter()
        df.locale = Locale(identifier: "es_DO")
        df.dateFormat = "d MMM"
        return df.string(from: date)
    }

    private func docIcon(_ type: String?) -> String {
        switch type {
        case "cedula", "pasaporte":         return "person.text.rectangle.fill"
        case "comprobante_ingresos":        return "dollarsign.circle.fill"
        case "estado_cuenta":              return "building.columns.fill"
        case "carta_trabajo":              return "briefcase.fill"
        case "declaracion_impuestos":      return "doc.text.fill"
        case "pre_aprobacion":             return "checkmark.seal.fill"
        case "prueba_fondos":              return "banknote.fill"
        default:                           return "doc.fill"
        }
    }
}

// MARK: - Identifiable URL wrappers + document preview

struct ArchiveDocURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct ArchiveDocPreview: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

// MARK: - Review Document Sheet

/// Opened from the Archive tab when the broker taps a document. Shows the
/// metadata, a button to preview the file, and approve/reject actions that
/// hit the PUT /applications/:id/documents/:docId/review endpoint.
struct ReviewDocumentSheet: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    let doc: ArchiveDocument
    let onReviewed: () -> Void
    let onPreview: () -> Void

    @State private var note = ""
    @State private var showReject = false
    @State private var submitting = false
    @State private var errorMsg: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        Image(systemName: iconFor(doc.type))
                            .font(.title)
                            .foregroundStyle(Color.rdBlue)
                            .frame(width: 44, height: 44)
                            .background(Color.rdBlue.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        VStack(alignment: .leading, spacing: 3) {
                            Text(doc.name ?? "Documento")
                                .font(.subheadline).bold()
                                .lineLimit(2)
                            Text(labelFor(doc.type))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusBadge(status: doc.status ?? "pending")
                    }

                    Divider()

                    infoRow(label: "Cliente", value: doc.client)
                    infoRow(label: "Email",   value: doc.clientEmail)
                    infoRow(label: "Propiedad", value: doc.property)
                    infoRow(label: "Tamaño",  value: doc.fileSize)
                    if let date = doc.uploadDate {
                        infoRow(label: "Subido", value: date)
                    }
                    if let existingNote = doc.reviewNote, !existingNote.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Nota previa")
                                .font(.caption).bold()
                                .foregroundStyle(.secondary)
                            Text(existingNote)
                                .font(.caption)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(.tertiarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)

                // Preview button
                Button(action: onPreview) {
                    HStack {
                        Image(systemName: "doc.text.magnifyingglass")
                        Text("Ver Documento")
                            .font(.subheadline).bold()
                        Spacer()
                        Image(systemName: "arrow.up.right.square")
                    }
                    .padding()
                    .background(Color(.secondarySystemGroupedBackground))
                    .foregroundStyle(Color.rdBlue)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .padding(.horizontal)

                // Rejection note
                if showReject {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Motivo del rechazo")
                            .font(.caption).bold()
                            .foregroundStyle(.secondary)
                        TextField("Ej: Documento ilegible, fecha vencida, etc.", text: $note, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(10)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .padding(.horizontal)
                }

                if let e = errorMsg {
                    Text(e)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                // Actions
                if doc.status != "approved" && doc.status != "rejected" {
                    HStack(spacing: 10) {
                        Button {
                            if showReject {
                                showReject = false
                                note = ""
                            } else {
                                showReject = true
                            }
                        } label: {
                            HStack {
                                Image(systemName: showReject ? "xmark.circle" : "xmark")
                                Text(showReject ? "Cancelar" : "Rechazar")
                            }
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.red.opacity(0.12))
                            .foregroundStyle(.red)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(submitting)

                        if showReject {
                            Button {
                                Task { await submit(status: "rejected") }
                            } label: {
                                HStack {
                                    if submitting {
                                        ProgressView().tint(.white)
                                    } else {
                                        Image(systemName: "paperplane.fill")
                                        Text("Enviar Rechazo")
                                    }
                                }
                                .font(.subheadline).bold()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color.red)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .disabled(submitting || note.trimmingCharacters(in: .whitespaces).isEmpty)
                        } else {
                            Button {
                                Task { await submit(status: "approved") }
                            } label: {
                                HStack {
                                    if submitting {
                                        ProgressView().tint(.white)
                                    } else {
                                        Image(systemName: "checkmark.circle.fill")
                                        Text("Aprobar")
                                    }
                                }
                                .font(.subheadline).bold()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color.rdGreen)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .disabled(submitting)
                        }
                    }
                    .padding(.horizontal)
                } else {
                    Text("Este documento ya fue revisado.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding()
                }
            }
            .padding(.vertical)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Revisar Documento")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button("Cerrar") { dismiss() }
            }
        }
    }

    private func infoRow(label: String, value: String?) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value?.isEmpty == false ? value! : "—")
                .font(.caption).bold()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func iconFor(_ type: String?) -> String {
        switch type {
        case "cedula", "pasaporte":   return "person.text.rectangle.fill"
        case "comprobante_ingresos":  return "dollarsign.circle.fill"
        case "estado_cuenta":         return "building.columns.fill"
        case "carta_trabajo":         return "briefcase.fill"
        case "declaracion_impuestos": return "doc.text.fill"
        case "pre_aprobacion":        return "checkmark.seal.fill"
        case "prueba_fondos":         return "banknote.fill"
        default:                      return "doc.fill"
        }
    }

    private func labelFor(_ type: String?) -> String {
        switch type {
        case "cedula":                return "Cédula de Identidad"
        case "pasaporte", "passport": return "Pasaporte"
        case "comprobante_ingresos", "income_proof": return "Comprobante de Ingresos"
        case "estado_cuenta", "bank_statement":      return "Estado de Cuenta"
        case "carta_trabajo", "employment_letter":   return "Carta de Trabajo"
        case "declaracion_impuestos", "tax_return":  return "Declaración de Impuestos"
        case "pre_aprobacion", "pre_approval":       return "Pre-Aprobación Bancaria"
        case "prueba_fondos", "proof_of_funds":      return "Prueba de Fondos"
        default:                                     return type?.capitalized ?? "Documento"
        }
    }

    private func submit(status: String) async {
        guard let appId = doc.appId, let docId = doc.docId else {
            errorMsg = "Información del documento incompleta"
            return
        }
        submitting = true
        errorMsg = nil
        do {
            try await api.reviewDocument(
                applicationId: appId,
                documentId: docId,
                status: status,
                note: note.trimmingCharacters(in: .whitespaces)
            )
            onReviewed()
        } catch {
            errorMsg = error.localizedDescription
        }
        submitting = false
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 6: Auditoría
// ────────────────────────────────────────────────────────────────────

struct DashboardAuditTab: View {
    @EnvironmentObject var api: APIService
    @State private var audit: DashboardAudit?
    @State private var loading = true
    @State private var searchText = ""
    @State private var filterType = ""
    @State private var currentPage = 1

    private let eventTypes = [
        ("", "Todos"),
        ("status_change", "Cambio de Estado"),
        ("checklist_complete", "Checklist Completado"),
        ("checklist_item", "Item de Checklist"),
        ("document", "Documento"),
        ("tour", "Tour"),
        ("payment", "Pago"),
        ("note", "Nota")
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                // Search
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Buscar en auditoría...", text: $searchText)
                        .font(.subheadline)
                        .onSubmit { Task { await load() } }
                }
                .padding(10)
                .background(Color(.secondarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)

                // Event type filter
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(eventTypes, id: \.0) { value, label in
                            Button {
                                filterType = value
                                Task { await load() }
                            } label: {
                                Text(label)
                                    .font(.caption2).bold()
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(filterType == value ? Color.rdBlue : Color(.tertiarySystemFill))
                                    .foregroundStyle(filterType == value ? .white : .primary)
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }

                // Events
                if loading {
                    ProgressView().padding(.top, 40)
                } else if let a = audit {
                    if a.events.isEmpty {
                        emptyState(icon: "clock.arrow.circlepath", title: "Sin eventos", subtitle: "La actividad de tus aplicaciones aparecerá aquí.")
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(a.events) { event in
                                HStack(alignment: .top, spacing: 12) {
                                    // Timeline dot
                                    VStack(spacing: 0) {
                                        Circle()
                                            .fill(event.iconColor)
                                            .frame(width: 32, height: 32)
                                            .overlay(
                                                Image(systemName: event.icon)
                                                    .font(.system(size: 13))
                                                    .foregroundStyle(.white)
                                            )
                                        Rectangle()
                                            .fill(Color(.separator))
                                            .frame(width: 1)
                                            .frame(maxHeight: .infinity)
                                    }

                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(event.description ?? "Evento")
                                            .font(.subheadline)
                                            .fixedSize(horizontal: false, vertical: true)

                                        HStack(spacing: 8) {
                                            if let actor = event.actor {
                                                Label(actor, systemImage: "person.fill")
                                                    .font(.caption2)
                                                    .foregroundStyle(.secondary)
                                            }
                                            if let ts = event.timestamp {
                                                Text(formatTimestamp(ts))
                                                    .font(.caption2)
                                                    .foregroundStyle(.tertiary)
                                            }
                                        }
                                    }
                                    .padding(.bottom, 16)

                                    Spacer()
                                }
                                .padding(.horizontal)
                            }
                        }

                        // Pagination
                        if a.pages > 1 {
                            HStack(spacing: 14) {
                                Button {
                                    if currentPage > 1 { currentPage -= 1; Task { await load() } }
                                } label: {
                                    Image(systemName: "chevron.left")
                                }
                                .disabled(currentPage <= 1)

                                Text("Página \(a.page) de \(a.pages)")
                                    .font(.caption).foregroundStyle(.secondary)

                                Button {
                                    if currentPage < a.pages { currentPage += 1; Task { await load() } }
                                } label: {
                                    Image(systemName: "chevron.right")
                                }
                                .disabled(currentPage >= a.pages)
                            }
                            .padding()
                        }
                    }
                }
            }
            .padding(.vertical)
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        audit = try? await api.getDashboardAudit(
            search: searchText.isEmpty ? nil : searchText,
            type: filterType.isEmpty ? nil : filterType,
            page: currentPage
        )
        loading = false
    }

    private func formatTimestamp(_ ts: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: ts) else { return ts }
        let rel = RelativeDateTimeFormatter()
        rel.locale = Locale(identifier: "es_DO")
        return rel.localizedString(for: date, relativeTo: Date())
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Settings View
// ────────────────────────────────────────────────────────────────────

struct DashboardSettingsView: View {
    @EnvironmentObject var api: APIService
    @State private var currentPw = ""
    @State private var newPw = ""
    @State private var confirmPw = ""
    @State private var loading = false
    @State private var successMsg: String?
    @State private var errorMsg: String?

    var body: some View {
        List {
            // Password change
            Section("Cambiar Contraseña") {
                SecureField("Contraseña actual", text: $currentPw)
                SecureField("Nueva contraseña", text: $newPw)
                SecureField("Confirmar contraseña", text: $confirmPw)

                if let err = errorMsg {
                    Label(err, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                if let msg = successMsg {
                    Label(msg, systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }

                Button {
                    Task { await changePassword() }
                } label: {
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Cambiar Contraseña")
                            .frame(maxWidth: .infinity)
                    }
                }
                .disabled(currentPw.isEmpty || newPw.isEmpty || newPw != confirmPw || loading)
            }

            // Links
            Section("Legal") {
                Link(destination: URL(string: "https://hogaresrd.com/terminos")!) {
                    HStack {
                        Label("Términos y Condiciones", systemImage: "doc.text.fill")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                Link(destination: URL(string: "https://hogaresrd.com/privacidad")!) {
                    HStack {
                        Label("Política de Privacidad", systemImage: "lock.shield.fill")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }

            Section("Soporte") {
                Link(destination: URL(string: "https://hogaresrd.com/contacto")!) {
                    HStack {
                        Label("Contactar Soporte", systemImage: "message.fill")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .navigationTitle("Configuración")
    }

    private func changePassword() async {
        guard newPw == confirmPw else { errorMsg = "Las contraseñas no coinciden."; return }
        guard newPw.count >= 8 else { errorMsg = "La contraseña debe tener al menos 8 caracteres."; return }
        loading = true; errorMsg = nil; successMsg = nil
        do {
            try await api.changePassword(current: currentPw, newPassword: newPw)
            successMsg = "Contraseña actualizada correctamente."
            currentPw = ""; newPw = ""; confirmPw = ""
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Helpers
// ────────────────────────────────────────────────────────────────────

private func formatCurrency(_ value: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: value)) ?? "$\(Int(value))"
}

private func emptyState(icon: String, title: String, subtitle: String) -> some View {
    VStack(spacing: 14) {
        Image(systemName: icon)
            .font(.system(size: 44))
            .foregroundStyle(Color(.tertiaryLabel))
        Text(title)
            .font(.headline)
            .foregroundStyle(.secondary)
        Text(subtitle)
            .font(.caption)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 40)
}
