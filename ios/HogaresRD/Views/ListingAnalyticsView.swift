import SwiftUI
import Charts

// MARK: - Listing Analytics Tab

struct DashboardListingAnalyticsTab: View {
    @EnvironmentObject var api: APIService
    @State private var summary: ListingAnalyticsSummary?
    @State private var listings: [ListingAnalyticsItem] = []
    @State private var loading = true
    @State private var range = "all"
    @State private var sort = "views"
    @State private var selectedListing: ListingAnalyticsItem?

    private let ranges = [("all", "Todo"), ("7d", "7d"), ("30d", "30d"), ("90d", "90d")]
    private let sorts  = [("views", "Vistas"), ("tours", "Tours"), ("favorites", "Favoritos"),
                          ("conversion", "Conversión"), ("days", "Días"), ("price", "Precio")]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Range picker
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(ranges, id: \.0) { key, label in
                            Button {
                                range = key
                                Task { await loadData() }
                            } label: {
                                Text(label)
                                    .font(.caption).bold()
                                    .padding(.horizontal, 14).padding(.vertical, 7)
                                    .background(range == key ? Color.rdBlue : Color(.secondarySystemFill))
                                    .foregroundStyle(range == key ? .white : .primary)
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }

                if loading {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 200)
                } else {
                    // Summary cards
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        DashStatCard(icon: "house.fill", label: "Propiedades", value: "\(summary?.totalListings ?? 0)", color: .rdBlue)
                        DashStatCard(icon: "eye.fill", label: "Vistas Totales", value: "\(summary?.totalViews ?? 0)", color: .rdBlue)
                        DashStatCard(icon: "calendar.badge.clock", label: "Tours", value: "\(summary?.totalTours ?? 0)", color: .green)
                        DashStatCard(icon: "heart.fill", label: "Favoritos", value: "\(summary?.totalFavorites ?? 0)", color: .red)
                    }
                    .padding(.horizontal)

                    // Views trend chart
                    if let trend = summary?.viewsTrend, !trend.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Vistas (últimos 30 días)")
                                .font(.caption).bold()
                                .foregroundStyle(.secondary)
                            Chart(trend, id: \.date) { day in
                                AreaMark(
                                    x: .value("Fecha", String(day.date.suffix(5))),
                                    y: .value("Vistas", day.views)
                                )
                                .foregroundStyle(Color.rdBlue.opacity(0.15))
                                LineMark(
                                    x: .value("Fecha", String(day.date.suffix(5))),
                                    y: .value("Vistas", day.views)
                                )
                                .foregroundStyle(Color.rdBlue)
                                .lineStyle(StrokeStyle(lineWidth: 2))
                            }
                            .chartXAxis {
                                AxisMarks(values: .stride(by: 7)) { _ in
                                    AxisValueLabel()
                                        .font(.system(size: 8))
                                }
                            }
                            .chartYAxis {
                                AxisMarks { _ in
                                    AxisGridLine()
                                    AxisValueLabel().font(.system(size: 9))
                                }
                            }
                            .frame(height: 160)
                        }
                        .padding()
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .padding(.horizontal)
                    }

                    // Top performing bar chart
                    if let top = summary?.topPerforming, !top.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Top Propiedades")
                                .font(.caption).bold()
                                .foregroundStyle(.secondary)
                            Chart(top.prefix(5)) { item in
                                BarMark(
                                    x: .value("Vistas", item.views),
                                    y: .value("Propiedad", String(item.title.prefix(22)))
                                )
                                .foregroundStyle(Color.rdBlue)
                            }
                            .chartXAxisLabel("Vistas")
                            .frame(height: CGFloat(min(top.count, 5)) * 36)
                        }
                        .padding()
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .padding(.horizontal)
                    }

                    // Sort picker
                    HStack {
                        Text("Ordenar por:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Picker("", selection: $sort) {
                            ForEach(sorts, id: \.0) { key, label in
                                Text(label).tag(key)
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: sort) { _ in
                            Task { await loadData() }
                        }
                        Spacer()
                    }
                    .padding(.horizontal)

                    // Listing cards
                    LazyVStack(spacing: 12) {
                        ForEach(listings) { listing in
                            ListingAnalyticsCard(listing: listing)
                                .onTapGesture { selectedListing = listing }
                        }
                    }
                    .padding(.horizontal)

                    if listings.isEmpty {
                        Text("No tienes propiedades publicadas.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.top, 40)
                    }
                }
            }
            .padding(.vertical)
        }
        .background(Color(.systemGroupedBackground))
        .task { await loadData() }
        .sheet(item: $selectedListing) { listing in
            ListingAnalyticsDetailView(listingId: listing.id)
                .environmentObject(api)
        }
    }

    private func loadData() async {
        loading = true
        do {
            async let s = api.getListingAnalyticsSummary(range: range)
            async let l = api.getListingAnalyticsList(sort: sort, range: range)
            summary = try await s
            listings = try await l
        } catch {
            print("Listing analytics error: \(error)")
        }
        loading = false
    }
}

// MARK: - Listing Card

struct ListingAnalyticsCard: View {
    let listing: ListingAnalyticsItem

    var body: some View {
        VStack(spacing: 0) {
            // Image
            if let img = listing.image, let url = URL(string: img) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        Rectangle().fill(Color(.tertiarySystemFill))
                    }
                }
                .frame(height: 120)
                .clipped()
            }

            VStack(spacing: 10) {
                // Title & location
                VStack(alignment: .leading, spacing: 2) {
                    Text(listing.title)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                    Text("\(listing.city), \(listing.province)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                // Stats row
                HStack(spacing: 0) {
                    StatPill(value: "\(listing.views)", label: "Vistas", color: .rdBlue)
                    StatPill(value: "\(listing.tours)", label: "Tours", color: .green)
                    StatPill(value: "\(listing.favorites)", label: "Favs", color: .red)
                    StatPill(value: "\(listing.conversion)%", label: "Conv.", color: .purple)
                }

                // Footer
                HStack {
                    Text(listing.priceFormatted)
                        .font(.subheadline).bold()
                        .foregroundStyle(.green)
                    Spacer()
                    Text("\(listing.daysOnMarket)d en mercado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct StatPill: View {
    let value: String
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Listing Detail Sheet

struct ListingAnalyticsDetailView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    let listingId: String

    @State private var detail: ListingAnalyticsDetail?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ScrollView {
                if loading {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 300)
                } else if let d = detail {
                    VStack(spacing: 16) {
                        // Header
                        HStack(spacing: 12) {
                            if let img = d.image, let url = URL(string: img) {
                                AsyncImage(url: url) { phase in
                                    switch phase {
                                    case .success(let image):
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    default:
                                        Rectangle().fill(Color(.tertiarySystemFill))
                                    }
                                }
                                .frame(width: 90, height: 65)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(d.title)
                                    .font(.subheadline).bold()
                                    .lineLimit(2)
                                Text("\(d.city), \(d.province)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                HStack(spacing: 4) {
                                    Text("$\(Int(Double(d.price) ?? 0).formatted())")
                                        .font(.caption).bold()
                                        .foregroundStyle(.green)
                                    Text("·")
                                    Text("\(d.daysOnMarket)d en mercado")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)

                        // Stats
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            DetailStatBox(value: "\(d.views)", label: "Vistas", color: .rdBlue)
                            DetailStatBox(value: "\(d.toursCount)", label: "Tours", color: .green)
                            DetailStatBox(value: "\(d.favorites)", label: "Favoritos", color: .red)
                            DetailStatBox(value: "\(d.conversion)%", label: "Conversión", color: .purple)
                        }
                        .padding(.horizontal)

                        // Views chart
                        if !d.viewsTrend.isEmpty {
                            DetailViewsChart(trend: d.viewsTrend)
                                .padding(.horizontal)
                        }

                        // Tour status breakdown
                        let ts = d.tourStatus
                        let totalTours = ts.pending + ts.confirmed + ts.completed + ts.cancelled
                        if totalTours > 0 {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Estado de Tours")
                                    .font(.caption).bold()
                                    .foregroundStyle(.secondary)
                                let items: [(String, Int, Color)] = [
                                    ("Pendientes", ts.pending, .orange),
                                    ("Confirmados", ts.confirmed, .green),
                                    ("Completados", ts.completed, .rdBlue),
                                    ("Cancelados", ts.cancelled, .red),
                                ]
                                ForEach(items, id: \.0) { label, count, color in
                                    HStack {
                                        Circle().fill(color).frame(width: 10, height: 10)
                                        Text(label).font(.caption)
                                        Spacer()
                                        Text("\(count)")
                                            .font(.caption).bold()
                                            .foregroundStyle(color)
                                    }
                                }
                            }
                            .padding()
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .padding(.horizontal)
                        } else {
                            VStack(spacing: 8) {
                                Image(systemName: "calendar.badge.exclamationmark")
                                    .font(.title2)
                                    .foregroundStyle(.secondary)
                                Text("Sin tours registrados")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .padding(.horizontal)
                        }
                    }
                    .padding(.vertical)
                } else {
                    Text("No se encontró la propiedad")
                        .foregroundStyle(.secondary)
                        .padding(.top, 60)
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Detalle de Propiedad")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task {
                do {
                    detail = try await api.getListingAnalyticsDetail(id: listingId)
                } catch {
                    print("Detail error: \(error)")
                }
                loading = false
            }
        }
    }
}

struct DetailViewsChart: View {
    let trend: [ViewDay]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Vistas por Día")
                .font(.caption).bold()
                .foregroundStyle(.secondary)
            Chart(trend, id: \.date) { day in
                let label = String(day.date.suffix(5))
                AreaMark(x: .value("Fecha", label), y: .value("Vistas", day.views))
                    .foregroundStyle(Color.rdBlue.opacity(0.12))
                LineMark(x: .value("Fecha", label), y: .value("Vistas", day.views))
                    .foregroundStyle(Color.rdBlue)
                    .lineStyle(StrokeStyle(lineWidth: 2))
            }
            .frame(height: 160)
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct DetailStatBox: View {
    let value: String
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title3).bold()
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color(.tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
