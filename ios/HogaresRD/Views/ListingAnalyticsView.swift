import SwiftUI
import Charts
import SafariServices

// MARK: - Listing Analytics Tab

struct DashboardListingAnalyticsTab: View {
    @EnvironmentObject var api: APIService
    @State private var summary: ListingAnalyticsSummary?
    @State private var listings: [ListingAnalyticsItem] = []
    @State private var listingToDelete: ListingAnalyticsItem?
    @State private var deleting: Bool = false
    @State private var deleteError: String?
    @State private var pendingListings: [Listing] = []
    @State private var loading = true
    @State private var range = "all"
    @State private var sort = "views"
    @State private var selectedListing: ListingAnalyticsItem?
    @State private var inventoryListing: ListingAnalyticsItem?
    @State private var promoForListing: ListingAnalyticsItem?
    @State private var webViewURL: IdentifiableURL?

    private let ranges = [("all", "Todo"), ("7d", "7d"), ("30d", "30d"), ("90d", "90d")]
    private let sorts  = [("views", "Vistas"), ("tours", "Tours"), ("favorites", "Favoritos"),
                          ("conversion", "Conversión"), ("days", "Días"), ("price", "Precio")]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Pending / edits_requested / rejected listings (web parity)
                if !pendingListings.isEmpty {
                    PendingListingsSection(
                        listings: pendingListings,
                        onEdit: { l in
                            if let url = URL(string: "\(apiBase)/submit?edit=\(l.id)") {
                                webViewURL = IdentifiableURL(url: url)
                            }
                        },
                        onOpenPublic: { l in
                            if let url = URL(string: "\(apiBase)/listing/\(l.id)") {
                                webViewURL = IdentifiableURL(url: url)
                            }
                        }
                    )
                    .padding(.horizontal)
                }

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
                        .onChange(of: sort) { _, _ in
                            Task { await loadData() }
                        }
                        Spacer()
                    }
                    .padding(.horizontal)

                    // Listing cards
                    LazyVStack(spacing: 12) {
                        ForEach(listings) { listing in
                            VStack(spacing: 0) {
                                ListingAnalyticsCard(listing: listing)
                                    .onTapGesture { selectedListing = listing }

                                // Action row — Promocionar / Inventario / Más
                                HStack(spacing: 0) {
                                    // Promocionar
                                    Button {
                                        promoForListing = listing
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "megaphone.fill")
                                                .font(.system(size: 10))
                                            Text("Promocionar")
                                                .font(.system(size: 11, weight: .bold))
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .foregroundStyle(Color.rdBlue)
                                    }
                                    .buttonStyle(.plain)

                                    Divider().frame(height: 24)

                                    // Inventario
                                    Button {
                                        inventoryListing = listing
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "building.2")
                                                .font(.system(size: 10))
                                            Text("Inventario")
                                                .font(.system(size: 11, weight: .bold))
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .foregroundStyle(Color.rdBlue)
                                    }
                                    .buttonStyle(.plain)

                                    Divider().frame(height: 24)

                                    // More menu — Editar / Ver público / Eliminar
                                    Menu {
                                        Button {
                                            if let url = URL(string: "\(apiBase)/submit?edit=\(listing.id)") {
                                                webViewURL = IdentifiableURL(url: url)
                                            }
                                        } label: {
                                            Label("Editar Propiedad", systemImage: "pencil")
                                        }
                                        Button {
                                            if let url = URL(string: "\(apiBase)/listing/\(listing.id)") {
                                                webViewURL = IdentifiableURL(url: url)
                                            }
                                        } label: {
                                            Label("Ver Público", systemImage: "eye")
                                        }
                                        Divider()
                                        Button(role: .destructive) {
                                            listingToDelete = listing
                                        } label: {
                                            Label("Eliminar Propiedad", systemImage: "trash")
                                        }
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: "ellipsis.circle")
                                                .font(.system(size: 10))
                                            Text("Más")
                                                .font(.system(size: 11, weight: .bold))
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .foregroundStyle(Color.rdBlue)
                                    }
                                }
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(
                                    .rect(bottomLeadingRadius: 14, bottomTrailingRadius: 14)
                                )
                            }
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
        .sheet(item: $inventoryListing) { listing in
            NavigationStack {
                InventoryManagementView(listingId: listing.id, listingTitle: listing.title)
                    .environmentObject(api)
            }
        }
        .sheet(item: $promoForListing) { listing in
            NavigationStack {
                ListingPromoSheet(listingId: listing.id, listingTitle: listing.title)
                    .environmentObject(api)
            }
        }
        .sheet(item: $webViewURL) { wrapper in
            SafariWebView(url: wrapper.url)
                .ignoresSafeArea()
        }
        .alert(
            "¿Eliminar esta propiedad?",
            isPresented: .init(
                get: { listingToDelete != nil },
                set: { if !$0 { listingToDelete = nil } }
            ),
            presenting: listingToDelete
        ) { listing in
            Button("Cancelar", role: .cancel) { listingToDelete = nil }
            Button("Eliminar", role: .destructive) {
                Task { await delete(listing) }
            }
        } message: { listing in
            Text("Esta acción es permanente. \"\(listing.title)\" se quitará del catálogo público y no podrás revertirla.")
        }
        .alert(deleteError ?? "", isPresented: .constant(deleteError != nil)) {
            Button("OK") { deleteError = nil }
        }
    }

    private func delete(_ listing: ListingAnalyticsItem) async {
        deleting = true
        defer { deleting = false }
        do {
            _ = try await api.deleteListing(id: listing.id)
            await MainActor.run {
                listings.removeAll { $0.id == listing.id }
                listingToDelete = nil
            }
        } catch {
            await MainActor.run {
                deleteError = (error as? LocalizedError)?.errorDescription ?? "No se pudo eliminar."
                listingToDelete = nil
            }
        }
    }

    private func loadData() async {
        loading = true
        do {
            async let s = api.getListingAnalyticsSummary(range: range)
            async let l = api.getListingAnalyticsList(sort: sort, range: range)
            async let p = api.getMyListings()
            summary = try await s
            listings = try await l
            // Only show non-approved listings in the pending section — approved
            // listings already show up in the analytics cards below.
            let all = (try? await p) ?? []
            pendingListings = all.filter { l in
                let s = (l.status ?? "").lowercased()
                return s == "pending" || s == "edits_requested" || s == "rejected"
            }
        } catch {
            debugLog("Listing analytics error: \(error)")
        }
        loading = false
    }
}

// MARK: - Pending Listings Section

/// Shows submissions that are NOT yet live (pending admin review, sent back
/// for edits, or outright rejected). Matches the web dashboard's
/// "Propiedades en Revisión" section.
struct PendingListingsSection: View {
    let listings: [Listing]
    let onEdit: (Listing) -> Void
    let onOpenPublic: (Listing) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(.orange)
                Text("Propiedades en Revisión")
                    .font(.subheadline).bold()
                Spacer()
                Text("\(listings.count)")
                    .font(.caption).bold()
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color.orange.opacity(0.15))
                    .foregroundStyle(.orange)
                    .clipShape(Capsule())
            }

            ForEach(listings) { listing in
                PendingListingRow(listing: listing,
                                  onEdit: { onEdit(listing) },
                                  onOpenPublic: { onOpenPublic(listing) })
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct PendingListingRow: View {
    let listing: Listing
    let onEdit: () -> Void
    let onOpenPublic: () -> Void

    private var statusLabel: String {
        switch (listing.status ?? "").lowercased() {
        case "pending":         return "En revisión"
        case "edits_requested": return "Ediciones solicitadas"
        case "rejected":        return "Rechazada"
        default:                return listing.status ?? ""
        }
    }

    private var statusColor: Color {
        switch (listing.status ?? "").lowercased() {
        case "pending":         return .blue
        case "edits_requested": return .orange
        case "rejected":        return .red
        default:                return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                if let first = listing.images.first, let url = URL(string: first) {
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().aspectRatio(contentMode: .fill)
                        default:
                            Rectangle().fill(Color(.tertiarySystemFill))
                        }
                    }
                    .frame(width: 60, height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    Rectangle()
                        .fill(Color(.tertiarySystemFill))
                        .frame(width: 60, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(listing.title)
                        .font(.caption).bold()
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Text(statusLabel)
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(statusColor.opacity(0.15))
                            .foregroundStyle(statusColor)
                            .clipShape(Capsule())
                        if let city = listing.city {
                            Text(city)
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer()
            }

            // Admin feedback banner for edits_requested
            if (listing.status ?? "").lowercased() == "edits_requested" {
                Text("El administrador pidió ajustes. Abre el editor para ver los detalles.")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            HStack(spacing: 8) {
                Button(action: onEdit) {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil")
                        Text("Editar y Reenviar")
                    }
                    .font(.system(size: 10, weight: .bold))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Color.rdBlue)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)

                if (listing.status ?? "").lowercased() != "rejected" {
                    Button(action: onOpenPublic) {
                        HStack(spacing: 4) {
                            Image(systemName: "eye")
                            Text("Vista Previa")
                        }
                        .font(.system(size: 10, weight: .bold))
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Color(.tertiarySystemGroupedBackground))
                        .foregroundStyle(.primary)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Identifiable URL wrapper for sheet(item:)

struct IdentifiableURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

// MARK: - Safari Web View

struct SafariWebView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let cfg = SFSafariViewController.Configuration()
        cfg.barCollapsingEnabled = true
        return SFSafariViewController(url: url, configuration: cfg)
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

// MARK: - Promocionar Sheet

/// Loads promo content for the listing and lets the user copy/share per
/// platform (Facebook, Instagram, WhatsApp, LinkedIn, Google Ads).
struct ListingPromoSheet: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    let listingId: String
    let listingTitle: String

    @State private var content: ListingPromoContent?
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var selectedPlatform = "facebook"
    @State private var showShareSheet = false

    private let platforms: [(key: String, label: String, icon: String, color: Color)] = [
        ("facebook",  "Facebook",  "f.square.fill",         .blue),
        ("instagram", "Instagram", "camera.circle.fill",    .purple),
        ("whatsapp",  "WhatsApp",  "message.fill",          .green),
        ("linkedin",  "LinkedIn",  "briefcase.fill",        Color(red: 0.0, green: 0.47, blue: 0.71)),
        ("google",    "Google",    "globe",                 .orange),
    ]

    private var activeText: String {
        guard let c = content else { return "" }
        switch selectedPlatform {
        case "facebook":  return c.content.facebook
        case "instagram": return c.content.instagram
        case "whatsapp":  return c.content.whatsapp
        case "linkedin":  return c.content.linkedin
        case "google":    return c.content.google_business ?? ""
        default:          return ""
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if loading {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 200)
                } else if let err = errorMsg {
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.orange)
                        Text(err)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else if content != nil {
                    // Platform picker
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(platforms, id: \.key) { p in
                                Button {
                                    selectedPlatform = p.key
                                } label: {
                                    HStack(spacing: 5) {
                                        Image(systemName: p.icon)
                                        Text(p.label)
                                    }
                                    .font(.caption).bold()
                                    .padding(.horizontal, 14).padding(.vertical, 8)
                                    .background(selectedPlatform == p.key ? p.color : Color(.secondarySystemFill))
                                    .foregroundStyle(selectedPlatform == p.key ? .white : .primary)
                                    .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)
                    }

                    // Content preview
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Contenido generado")
                            .font(.caption).bold()
                            .foregroundStyle(.secondary)
                        Text(activeText)
                            .font(.system(size: 13))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .textSelection(.enabled)
                    }
                    .padding(.horizontal)

                    // Action buttons
                    HStack(spacing: 10) {
                        Button {
                            UIPasteboard.general.string = activeText
                        } label: {
                            HStack {
                                Image(systemName: "doc.on.doc.fill")
                                Text("Copiar")
                            }
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(.secondarySystemGroupedBackground))
                            .foregroundStyle(.primary)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)

                        Button {
                            showShareSheet = true
                        } label: {
                            HStack {
                                Image(systemName: "square.and.arrow.up")
                                Text("Compartir")
                            }
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal)

                    // Listing URL row
                    if let url = content?.url {
                        HStack(spacing: 6) {
                            Image(systemName: "link")
                                .foregroundStyle(.secondary)
                            Text(url)
                                .font(.caption)
                                .foregroundStyle(.blue)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Button {
                                UIPasteboard.general.string = url
                            } label: {
                                Image(systemName: "doc.on.doc")
                                    .font(.caption)
                            }
                        }
                        .padding(10)
                        .background(Color(.tertiarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .padding(.horizontal)
                    }
                }
            }
            .padding(.vertical)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Promocionar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Cerrar") { dismiss() }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showShareSheet) {
            ShareActivitySheet(items: [activeText])
        }
    }

    private func load() async {
        loading = true
        errorMsg = nil
        do {
            content = try await api.getListingPromoContent(id: listingId)
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

// MARK: - UIActivityViewController wrapper

struct ShareActivitySheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Listing Card

struct ListingAnalyticsCard: View {
    let listing: ListingAnalyticsItem

    var body: some View {
        VStack(spacing: 0) {
            // Image
            if let img = listing.image, let url = URL(string: img) {
                CachedAsyncImage(url: url) { phase in
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
                                CachedAsyncImage(url: url) { phase in
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
            debugLog("Detail error: \(error)")
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
