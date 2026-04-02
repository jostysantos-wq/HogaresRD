import SwiftUI

// MARK: - Broker Dashboard (Main)

struct BrokerDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var selectedTab = 0

    private let tabs = ["Aplicaciones", "Analíticas", "Ventas", "Contabilidad", "Archivo", "Auditoría"]

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(tabs.enumerated()), id: \.offset) { i, title in
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { selectedTab = i }
                        } label: {
                            Text(title)
                                .font(.caption).bold()
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(selectedTab == i ? Color.rdBlue : Color(.secondarySystemFill))
                                .foregroundStyle(selectedTab == i ? .white : .primary)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
            }
            .background(Color(.systemBackground))

            Divider()

            // Content
            TabView(selection: $selectedTab) {
                DashboardApplicationsTab().tag(0)
                DashboardAnalyticsTab().tag(1)
                DashboardSalesTab().tag(2)
                DashboardAccountingTab().tag(3)
                DashboardArchiveTab().tag(4)
                DashboardAuditTab().tag(5)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .environmentObject(api)
        }
        .navigationTitle("Dashboard")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
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
                        DashboardSettingsView().environmentObject(api)
                    } label: {
                        Label("Configuración", systemImage: "gearshape.fill")
                    }
                    NavigationLink {
                        SubmitListingView()
                    } label: {
                        Label("Publicar propiedad", systemImage: "plus.circle.fill")
                    }
                    Link(destination: URL(string: "https://hogaresrd.com/broker")!) {
                        Label("Abrir en web", systemImage: "safari.fill")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
            }
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
        return applications.filter { $0.status.lowercased() == filterStatus }
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

                // Filter pills
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        filterPill("Todas", value: "all")
                        filterPill("En Revisión", value: "reviewing")
                        filterPill("Aprobadas", value: "approved")
                        filterPill("Rechazadas", value: "rejected")
                        filterPill("Cerradas", value: "closed")
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
                            ApplicationRow(app: app)
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
                            pipelineRow("Enviadas", count: a.pipeline.submitted, color: .gray)
                            pipelineRow("En Revisión", count: a.pipeline.reviewing, color: .orange)
                            pipelineRow("Aprobadas", count: a.pipeline.approved, color: .green)
                            pipelineRow("Rechazadas", count: a.pipeline.rejected, color: .red)
                            pipelineRow("Cerradas", count: a.pipeline.closed, color: .blue)
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
                        DashStatCard(icon: "tag.fill", label: "Precio Promedio", value: formatCurrency(s.avgPrice), color: .purple)
                        DashStatCard(icon: "hourglass", label: "Valor Pipeline", value: formatCurrency(s.pipelineValue), color: .orange)
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
                    if !s.recentSales.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Ventas Recientes")
                                .font(.headline)
                                .padding(.horizontal)

                            ForEach(s.recentSales) { sale in
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
    @State private var accounting: DashboardAccounting?
    @State private var loading = true
    @State private var commissionRate = "3"

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if loading {
                    ProgressView().padding(.top, 40)
                } else if let a = accounting {
                    // Commission rate control
                    HStack(spacing: 10) {
                        Text("Tasa de comisión:")
                            .font(.subheadline)
                        TextField("3", text: $commissionRate)
                            .keyboardType(.decimalPad)
                            .frame(width: 60)
                            .padding(8)
                            .background(Color(.secondarySystemFill))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        Text("%")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        Button("Aplicar") {
                            Task { await load() }
                        }
                        .font(.caption).bold()
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.rdBlue)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                    }
                    .padding(.horizontal)

                    // Metric cards
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        DashStatCard(icon: "dollarsign.circle.fill", label: "Total Ganado", value: formatCurrency(a.totalEarned), color: .green)
                        DashStatCard(icon: "hourglass", label: "Comisión Pendiente", value: formatCurrency(a.pendingCommission), color: .orange)
                        DashStatCard(icon: "percent", label: "Tasa de Comisión", value: String(format: "%.1f%%", a.commissionRate * 100), color: .blue)
                        DashStatCard(icon: "checkmark.seal.fill", label: "Pagos Verificados", value: "\(a.verifiedPayments)", color: .green)
                    }
                    .padding(.horizontal)

                    // Monthly commissions chart
                    if !a.monthlyCommissions.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Comisiones Mensuales")
                                .font(.headline)
                                .padding(.horizontal)

                            SimpleBarChart(data: a.monthlyCommissions.suffix(12).map { ($0.month, Int($0.commission)) })
                                .frame(height: 160)
                                .padding(.horizontal)
                        }
                    }

                    // Records
                    if !a.records.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Registros Financieros")
                                .font(.headline)
                                .padding(.horizontal)

                            ForEach(a.records) { record in
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(record.property ?? "Propiedad")
                                            .font(.subheadline).bold()
                                            .lineLimit(1)
                                        if let client = record.client {
                                            Text(client)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 3) {
                                        if let c = record.commission {
                                            Text(formatCurrency(c))
                                                .font(.subheadline).bold()
                                                .foregroundStyle(.green)
                                        }
                                        if let ps = record.paymentStatus {
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

                    if a.records.isEmpty {
                        emptyState(icon: "banknote", title: "Sin registros", subtitle: "Tus registros financieros aparecerán aquí.")
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
        let rate = (Double(commissionRate) ?? 3.0) / 100.0
        accounting = try? await api.getDashboardAccounting(commissionRate: rate)
        loading = false
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
                                HStack(spacing: 12) {
                                    Image(systemName: docIcon(doc.type))
                                        .font(.title3)
                                        .foregroundStyle(Color.rdBlue)
                                        .frame(width: 36)

                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(doc.name ?? "Documento")
                                            .font(.subheadline).bold()
                                            .lineLimit(1)
                                        HStack(spacing: 8) {
                                            if let client = doc.client {
                                                Text(client).font(.caption).foregroundStyle(.secondary)
                                            }
                                            if let size = doc.fileSize {
                                                Text(size).font(.caption2).foregroundStyle(.tertiary)
                                            }
                                        }
                                    }

                                    Spacer()

                                    if let s = doc.status {
                                        StatusBadge(status: s)
                                    }
                                }
                                .padding(12)
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
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
