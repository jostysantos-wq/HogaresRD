import SwiftUI

// MARK: - Feed View

struct FeedView: View {
    @EnvironmentObject var api: APIService

    @State private var allListings: [Listing] = []
    @State private var feed:        [Listing] = []
    @State private var page        = 0
    @State private var totalPages  = 1
    @State private var loading     = false
    @State private var initialLoad = true
    @State private var reshuffles  = 0
    @State private var errorMsg:    String?

    // Preference tracking: JSON dict of type/province -> view count
    @AppStorage("feed_prefs") private var prefJSON: String = "{}"

    var body: some View {
        NavigationStack {
            Group {
                if initialLoad && loading {
                    VStack(spacing: 16) {
                        Spacer()
                        ProgressView()
                        Text("Cargando propiedades…")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                    }
                } else if let err = errorMsg, feed.isEmpty {
                    VStack(spacing: 16) {
                        Spacer()
                        Image(systemName: "wifi.slash").font(.system(size: 40)).foregroundStyle(.secondary)
                        Text(err).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await refresh() } }
                            .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                        Spacer()
                    }
                    .padding()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(Array(feed.enumerated()), id: \.offset) { index, listing in
                                NavigationLink {
                                    ListingDetailView(id: listing.id)
                                        .onAppear { trackView(listing) }
                                } label: {
                                    FeedCard(listing: listing)
                                }
                                .buttonStyle(.plain)
                                .onAppear {
                                    if index >= feed.count - 4 {
                                        Task { await loadMore() }
                                    }
                                }
                            }

                            if loading {
                                ProgressView().padding(.vertical, 24)
                            }

                            if !feed.isEmpty && !loading && reshuffles > 0 {
                                Text("Recomendaciones personalizadas · Vuelta \(reshuffles + 1)")
                                    .font(.caption).foregroundStyle(.secondary).padding(.vertical, 8)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .padding(.bottom, 32)
                    }
                    .refreshable { await refresh() }
                }
            }
            .navigationTitle("Feed")
            .navigationBarTitleDisplayMode(.large)
        }
        .task { await loadMore() }
    }

    private func refresh() async {
        feed = []
        allListings = []
        page = 0
        totalPages = 1
        reshuffles = 0
        errorMsg = nil
        await loadMore()
    }

    // MARK: - Load

    private func loadMore() async {
        guard !loading else { return }
        loading = true

        if page < totalPages {
            page += 1
            do {
                let response = try await api.getListings(limit: 12, page: page)
                let newBatch = response.listings
                allListings.append(contentsOf: newBatch)
                totalPages = response.pages
                feed.append(contentsOf: ranked(newBatch))
                errorMsg = nil
            } catch {
                errorMsg = "No se pudo cargar el feed. Verifica tu conexión."
            }
        } else {
            // All API pages consumed — reshuffle entire pool and loop
            reshuffles += 1
            feed.append(contentsOf: ranked(allListings))
        }

        initialLoad = false
        loading = false
    }

    // MARK: - Ranking

    /// Sort a batch by user preference score with a small random noise so
    /// the feed stays fresh even after reshuffles.
    private func ranked(_ items: [Listing]) -> [Listing] {
        let prefs = loadPrefs()
        guard !prefs.isEmpty else { return items.shuffled() }
        return items.sorted { a, b in
            prefScore(a, prefs: prefs) > prefScore(b, prefs: prefs)
        }
    }

    private func prefScore(_ listing: Listing, prefs: [String: Int]) -> Double {
        var score = 0
        score += prefs[listing.type] ?? 0
        if let prov = listing.province { score += prefs[prov] ?? 0 }
        if let city = listing.city     { score += prefs[city] ?? 0 }
        // Add noise so same-score items shuffle naturally
        return Double(score) + Double.random(in: 0...1.5)
    }

    // MARK: - Preference tracking

    private func trackView(_ listing: Listing) {
        var prefs = loadPrefs()
        prefs[listing.type, default: 0] += 2
        if let prov = listing.province { prefs[prov, default: 0] += 1 }
        if let city = listing.city     { prefs[city, default: 0] += 1 }
        savePrefs(prefs)
    }

    private func loadPrefs() -> [String: Int] {
        guard let data = prefJSON.data(using: .utf8),
              let dict = try? JSONDecoder().decode([String: Int].self, from: data) else { return [:] }
        return dict
    }

    private func savePrefs(_ prefs: [String: Int]) {
        guard let data = try? JSONEncoder().encode(prefs),
              let str  = String(data: data, encoding: .utf8) else { return }
        prefJSON = str
    }
}

// MARK: - Feed Card

struct FeedCard: View {
    let listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {

            // ── Image ──────────────────────────────────────────
            ZStack(alignment: .bottomLeading) {
                AsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().aspectRatio(contentMode: .fill)
                    case .failure:
                        imagePlaceholder
                    default:
                        imagePlaceholder.overlay(ProgressView())
                    }
                }
                .frame(height: 220)
                .clipped()

                // Gradient scrim for badges
                LinearGradient(
                    colors: [.black.opacity(0.45), .clear],
                    startPoint: .bottom, endPoint: .center
                )

                // Bottom-left: type + condition badges
                HStack(spacing: 6) {
                    typeBadge
                    if let cond = listing.condition, !cond.isEmpty {
                        Text(cond)
                            .font(.caption2).bold()
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(.ultraThinMaterial)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }
                }
                .padding(12)
            }

            // ── Body ───────────────────────────────────────────
            VStack(alignment: .leading, spacing: 10) {

                // Price
                Text(listing.priceFormatted)
                    .font(.title3).bold()
                    .foregroundStyle(Color.rdBlue)

                // Title
                Text(listing.title)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                // Location
                HStack(spacing: 4) {
                    Image(systemName: "mappin.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.rdRed)
                    Text(locationString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                // Stats row
                if hasStats {
                    HStack(spacing: 14) {
                        if let beds = listing.bedrooms, beds != "0" {
                            statChip(icon: "bed.double.fill", value: beds + " Hab.")
                        }
                        if let baths = listing.bathrooms {
                            statChip(icon: "shower.fill", value: baths + " Baños")
                        }
                        if let area = listing.area_const, !area.isEmpty {
                            statChip(icon: "ruler.fill", value: area + " m²")
                        }
                    }
                }

                // Agency
                if let agency = listing.agencies?.first, let name = agency.name {
                    Divider()
                    HStack(spacing: 6) {
                        Image(systemName: "building.2.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.rdBlue)
                        Text(name)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .padding(14)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Color.rdBlue.opacity(0.09), radius: 10, y: 4)
    }

    // MARK: - Helpers

    private var imagePlaceholder: some View {
        Rectangle()
            .fill(Color(.systemGray5))
            .overlay(
                Image(systemName: "house.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(Color(.systemGray3))
            )
    }

    private var typeBadge: some View {
        Text(listing.typeLabel)
            .font(.caption2).bold()
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(typeColor)
            .foregroundStyle(.white)
            .clipShape(Capsule())
    }

    private var typeColor: Color {
        switch listing.type {
        case "venta":    return Color.rdBlue
        case "alquiler": return Color.rdGreen
        case "proyecto": return Color.rdRed
        default:         return Color.rdBlue
        }
    }

    private var locationString: String {
        [listing.sector, listing.city, listing.province]
            .compactMap { val in
                guard let v = val, !v.isEmpty else { return nil }
                return v
            }
            .joined(separator: ", ")
    }

    private var hasStats: Bool {
        listing.bedrooms != nil || listing.bathrooms != nil ||
        (listing.area_const != nil && !(listing.area_const!.isEmpty))
    }

    private func statChip(icon: String, value: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(Color.rdBlue.opacity(0.7))
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
