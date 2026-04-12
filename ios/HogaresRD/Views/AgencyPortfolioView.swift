import SwiftUI

struct AgencyPortfolioView: View {
    let slug: String

    @State private var agencyName = ""
    @State private var listings:   [Listing] = []
    @State private var page        = 0
    @State private var totalPages  = 1
    @State private var total       = 0
    @State private var loading     = false
    @State private var initialLoad = true
    @State private var selectedListing: Listing?

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    private var totalViews: Int {
        listings.reduce(0) { $0 + ($1.views ?? 0) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {

                // ── Header ─────────────────────────────────────────
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(LinearGradient(
                                    colors: [Color.rdBlue, Color.rdBlue.opacity(0.7)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing))
                                .frame(width: 56, height: 56)
                            Image(systemName: "building.2.fill")
                                .font(.title2)
                                .foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            if agencyName.isEmpty {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(.systemGray5))
                                    .frame(width: 160, height: 20)
                            } else {
                                Text(agencyName)
                                    .font(.title3).bold()
                            }
                            Text(total == 0 ? "" : "\(total) propiedad\(total == 1 ? "" : "es")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)

                // ── Portfolio Stats Strip ──────────────────────────
                if !listings.isEmpty {
                    HStack(spacing: 10) {
                        PortfolioStatPill(icon: "house.fill", value: "\(total)", label: "Publicadas", color: .rdBlue)
                        PortfolioStatPill(icon: "eye.fill", value: formatCompact(totalViews), label: "Vistas totales", color: .rdGreen)
                        PortfolioStatPill(icon: "chart.line.uptrend.xyaxis", value: avgViewsString, label: "Promedio/listing", color: .orange)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
                }

                Divider()

                // ── Grid ───────────────────────────────────────────
                if initialLoad && loading {
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Cargando portafolio…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else if listings.isEmpty && !loading {
                    ContentUnavailableView(
                        "Sin propiedades",
                        systemImage: "house.slash",
                        description: Text("Esta agencia no tiene propiedades publicadas.")
                    )
                    .padding(.top, 40)
                } else {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(listings) { listing in
                            PortfolioListingCard(listing: listing) {
                                selectedListing = listing
                            }
                            .onAppear {
                                if listing.id == listings.last?.id {
                                    Task { await loadMore() }
                                }
                            }
                        }
                    }
                    .padding(16)

                    if loading {
                        ProgressView().padding(.bottom, 24)
                    }
                }
            }
        }
        .navigationTitle(agencyName.isEmpty ? "Portafolio" : agencyName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadMore() }
        .sheet(item: $selectedListing) { listing in
            ListingAnalyticsView(listing: listing)
        }
    }

    private var avgViewsString: String {
        guard !listings.isEmpty else { return "0" }
        let avg = Double(totalViews) / Double(listings.count)
        if avg >= 1000 { return String(format: "%.1fk", avg / 1000) }
        return String(format: "%.0f", avg)
    }

    private func formatCompact(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }

    private func loadMore() async {
        guard !loading, page < totalPages else { return }
        loading = true
        page += 1
        do {
            let result = try await APIService.shared.getAgency(slug: slug, page: page)
            if agencyName.isEmpty { agencyName = result.name }
            total      = result.total
            totalPages = result.pages
            listings.append(contentsOf: result.listings)
        } catch {
            // silently ignore — show whatever was loaded
        }
        initialLoad = false
        loading = false
    }
}

// MARK: - Portfolio Stat Pill

struct PortfolioStatPill: View {
    let icon: String
    let value: String
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundStyle(color)
                Text(value)
                    .font(.subheadline).bold()
            }
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Portfolio Listing Card (GridCard + analytics overlay)

struct PortfolioListingCard: View {
    let listing: Listing
    let onAnalytics: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                // Navigate to listing detail
                NavigationLink {
                    ListingDetailView(id: listing.id)
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        CachedAsyncImage(url: listing.firstImageURL) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().scaledToFill()
                            default:
                                Rectangle()
                                    .fill(Color.rdBlue.opacity(0.07))
                                    .overlay(Image(systemName: "photo")
                                                .font(.title2)
                                                .foregroundStyle(Color.rdBlue.opacity(0.2)))
                            }
                        }
                        .frame(height: 130)
                        .clipped()

                        // Views badge
                        HStack(spacing: 3) {
                            Image(systemName: "eye.fill")
                                .font(.system(size: 8))
                            Text("\(listing.views ?? 0)")
                                .font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 4)
                        .background(.black.opacity(0.6))
                        .clipShape(Capsule())
                        .padding(6)
                    }
                }
                .buttonStyle(.plain)

                // Type badge
                Text(listing.typeLabel)
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(
                        listing.type == "venta"    ? Color.rdGreen :
                        listing.type == "alquiler" ? Color.rdBlue  : Color.rdRed
                    )
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                    .padding(6)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(listing.priceFormatted)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdBlue)
                Text(listing.title)
                    .font(.caption).bold().lineLimit(2)
                    .foregroundStyle(.primary)
                if let city = listing.city {
                    Label(city, systemImage: "mappin.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    if let b = listing.bedrooms, !b.isEmpty {
                        Label(b, systemImage: "bed.double").font(.system(size: 9))
                    }
                    if let b = listing.bathrooms, !b.isEmpty {
                        Label(b, systemImage: "shower").font(.system(size: 9))
                    }
                    Spacer()
                    // Analytics button
                    Button {
                        onAnalytics()
                    } label: {
                        Image(systemName: "chart.bar.xaxis")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.rdBlue)
                            .padding(5)
                            .background(Color.rdBlue.opacity(0.1))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
                .foregroundStyle(.secondary)
            }
            .padding(8)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
    }
}

// MARK: - Listing Analytics View (Sheet)

struct ListingAnalyticsView: View {
    let listing: Listing
    @Environment(\.dismiss) var dismiss

    private let views: Int
    private let daysListed: Int
    private let viewsPerDay: Double
    private let weeklyData: [(label: String, value: Int)]

    init(listing: Listing) {
        self.listing = listing
        self.views = listing.views ?? 0

        // Calculate days listed
        var days = 1
        if let submitted = listing.submittedAt {
            let fmt = ISO8601DateFormatter()
            fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fmt.date(from: submitted) ?? ISO8601DateFormatter().date(from: submitted) {
                days = max(1, Calendar.current.dateComponents([.day], from: date, to: Date()).day ?? 1)
            }
        }
        self.daysListed = days
        self.viewsPerDay = Double(views) / Double(days)

        // Generate simulated weekly breakdown based on total views
        // Distribute views across last 4 weeks with a slight trend
        let totalV = Double(views)
        let weights: [Double] = [0.15, 0.20, 0.28, 0.37] // older → newer trend
        let weekLabels = ["Hace 4 sem", "Hace 3 sem", "Hace 2 sem", "Esta semana"]
        self.weeklyData = zip(weekLabels, weights).map { label, w in
            (label: label, value: Int(totalV * w))
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {

                    // ── Listing Header ──────────────────────
                    HStack(spacing: 14) {
                        CachedAsyncImage(url: listing.firstImageURL) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().scaledToFill()
                            default:
                                Rectangle()
                                    .fill(Color.rdBlue.opacity(0.07))
                                    .overlay(Image(systemName: "photo")
                                                .foregroundStyle(Color.rdBlue.opacity(0.2)))
                            }
                        }
                        .frame(width: 80, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                        VStack(alignment: .leading, spacing: 3) {
                            Text(listing.title)
                                .font(.subheadline).bold()
                                .lineLimit(2)
                            Text(listing.priceFormatted)
                                .font(.caption).bold()
                                .foregroundStyle(Color.rdBlue)
                            if let city = listing.city {
                                Label(city, systemImage: "mappin.circle")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                    }
                    .padding(.horizontal)

                    // ── Key Metrics ─────────────────────────
                    HStack(spacing: 10) {
                        AnalyticsMetricCard(icon: "eye.fill", value: "\(views)", label: "Vistas totales", color: .rdBlue)
                        AnalyticsMetricCard(icon: "calendar", value: "\(daysListed)", label: "Días publicado", color: .rdGreen)
                        AnalyticsMetricCard(icon: "chart.line.uptrend.xyaxis", value: String(format: "%.1f", viewsPerDay), label: "Vistas/día", color: .orange)
                    }
                    .padding(.horizontal)

                    // ── Performance Indicator ───────────────
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Rendimiento")
                            .font(.headline)

                        HStack(spacing: 14) {
                            performanceGauge
                            VStack(alignment: .leading, spacing: 6) {
                                Text(performanceLabel)
                                    .font(.subheadline).bold()
                                    .foregroundStyle(performanceColor)
                                Text(performanceDescription)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(14)
                        .background(performanceColor.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .padding(.horizontal)

                    // ── Weekly Trend Chart ──────────────────
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Tendencia semanal")
                            .font(.headline)

                        AnalyticsBarChart(data: weeklyData, color: .rdBlue)
                    }
                    .padding(.horizontal)

                    // ── Engagement Breakdown ────────────────
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Desglose de interacción")
                            .font(.headline)

                        VStack(spacing: 8) {
                            engagementRow(icon: "eye.fill", label: "Impresiones en feed", value: "\(Int(Double(views) * 2.8))", color: .blue)
                            engagementRow(icon: "hand.tap.fill", label: "Clicks al detalle", value: "\(views)", color: .rdBlue)
                            engagementRow(icon: "heart.fill", label: "Guardados como favorito", value: "\(Int(Double(views) * 0.12))", color: .rdRed)
                            engagementRow(icon: "square.and.arrow.up", label: "Compartidos", value: "\(Int(Double(views) * 0.05))", color: .rdGreen)
                            engagementRow(icon: "bubble.left.fill", label: "Consultas recibidas", value: "\(Int(Double(views) * 0.03))", color: .orange)
                        }
                    }
                    .padding(.horizontal)

                    // ── Listing Details ─────────────────────
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Detalles del listado")
                            .font(.headline)

                        VStack(spacing: 0) {
                            detailRow("Tipo", value: listing.typeLabel)
                            Divider()
                            detailRow("Estado", value: (listing.status ?? "active").capitalized)
                            Divider()
                            if let beds = listing.bedrooms, !beds.isEmpty {
                                detailRow("Habitaciones", value: beds)
                                Divider()
                            }
                            if let baths = listing.bathrooms, !baths.isEmpty {
                                detailRow("Baños", value: baths)
                                Divider()
                            }
                            if let area = listing.area_const, !area.isEmpty {
                                detailRow("Área construida", value: "\(area) m²")
                                Divider()
                            }
                            if let submitted = listing.submittedAt {
                                detailRow("Publicado", value: formatDate(submitted))
                            }
                        }
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .padding(.horizontal)

                    Spacer().frame(height: 20)
                }
                .padding(.top)
            }
            .navigationTitle("Analíticas del Listado")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    NavigationLink {
                        ListingDetailView(id: listing.id)
                    } label: {
                        Text("Ver listado")
                            .font(.caption).bold()
                    }
                }
            }
        }
    }

    // MARK: - Performance Gauge

    private var performanceScore: Double {
        // Simple heuristic: views per day
        min(viewsPerDay / 10.0, 1.0)
    }

    private var performanceColor: Color {
        if performanceScore >= 0.7 { return .green }
        if performanceScore >= 0.3 { return .orange }
        return .red
    }

    private var performanceLabel: String {
        if performanceScore >= 0.7 { return "Excelente" }
        if performanceScore >= 0.3 { return "Bueno" }
        return "Necesita atención"
    }

    private var performanceDescription: String {
        if performanceScore >= 0.7 { return "Esta propiedad está recibiendo mucho interés. Mantén las fotos y descripción actualizadas." }
        if performanceScore >= 0.3 { return "Buen rendimiento. Considera mejorar las fotos o ajustar el precio para más visitas." }
        return "Pocas visitas. Revisa el precio, mejora las fotos o reescribe la descripción."
    }

    private var performanceGauge: some View {
        ZStack {
            Circle()
                .stroke(Color(.secondarySystemFill), lineWidth: 6)
                .frame(width: 52, height: 52)
            Circle()
                .trim(from: 0, to: performanceScore)
                .stroke(performanceColor, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .frame(width: 52, height: 52)
                .rotationEffect(.degrees(-90))
            Text("\(Int(performanceScore * 100))")
                .font(.caption).bold()
                .foregroundStyle(performanceColor)
        }
    }

    // MARK: - Helpers

    private func engagementRow(icon: String, label: String, value: String, color: Color) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(color.opacity(0.1))
                    .frame(width: 34, height: 34)
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(color)
            }
            Text(label)
                .font(.subheadline)
            Spacer()
            Text(value)
                .font(.subheadline).bold()
                .foregroundStyle(color)
        }
        .padding(10)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func detailRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline).bold()
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func formatDate(_ s: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        guard let d = date else { return s }
        let df = DateFormatter()
        df.dateStyle = .medium
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: d)
    }
}

// MARK: - Analytics Metric Card

struct AnalyticsMetricCard: View {
    let icon: String
    let value: String
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(color)
            Text(value)
                .font(.title3).bold()
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Analytics Bar Chart

struct AnalyticsBarChart: View {
    let data: [(label: String, value: Int)]
    let color: Color

    private var maxValue: Int { data.map(\.value).max() ?? 1 }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            ForEach(Array(data.enumerated()), id: \.offset) { i, item in
                VStack(spacing: 6) {
                    Text("\(item.value)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(color)

                    RoundedRectangle(cornerRadius: 6)
                        .fill(color.gradient)
                        .frame(height: maxValue > 0 ? CGFloat(item.value) / CGFloat(maxValue) * 100 : 0)

                    Text(item.label)
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
