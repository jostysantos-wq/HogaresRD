import SwiftUI

// MARK: - Feed View

struct FeedView: View {
    @EnvironmentObject var api: APIService

    @State private var allListings:      [Listing] = []
    @State private var feed:             [Listing] = []
    @State private var currentIndex      = 0
    @State private var page              = 0
    @State private var totalPages        = 1
    @State private var loading           = false
    @State private var initialLoad       = true
    @State private var reshuffles        = 0
    @State private var errorMsg:         String?
    @State private var selectedListingID: String?

    @AppStorage("feed_prefs") private var prefJSON: String = "{}"

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                if initialLoad && loading {
                    VStack(spacing: 14) {
                        ProgressView().tint(.white)
                        Text("Cargando propiedades…")
                            .font(.subheadline).foregroundStyle(.white.opacity(0.7))
                    }
                } else if let err = errorMsg, feed.isEmpty {
                    VStack(spacing: 20) {
                        Image(systemName: "wifi.slash")
                            .font(.system(size: 44)).foregroundStyle(.white.opacity(0.5))
                        Text(err)
                            .font(.subheadline).foregroundStyle(.white.opacity(0.7))
                            .multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await refresh() } }
                            .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                    }
                    .padding(32)
                } else if !feed.isEmpty {
                    GeometryReader { proxy in
                        ScrollView(.vertical, showsIndicators: false) {
                            LazyVStack(spacing: 0) {
                                ForEach(Array(feed.enumerated()), id: \.offset) { index, listing in
                                    ReelCard(listing: listing)
                                        .frame(width: proxy.size.width,
                                               height: proxy.size.height)
                                        .contentShape(Rectangle())
                                        .onTapGesture {
                                            selectedListingID = listing.id
                                        }
                                        .onAppear {
                                            currentIndex = index
                                            trackView(listing)
                                            if index >= feed.count - 3 {
                                                Task { await loadMore() }
                                            }
                                        }
                                }
                            }
                            .scrollTargetLayout()
                        }
                        .scrollTargetBehavior(.paging)
                        .scrollIndicators(.hidden)
                        .ignoresSafeArea()
                    }
                    .ignoresSafeArea()

                    if loading {
                        VStack {
                            Spacer()
                            ProgressView().tint(.white).padding(.bottom, 100)
                        }
                    }
                }
            }
            .navigationDestination(isPresented: Binding(
                get: { selectedListingID != nil },
                set: { if !$0 { selectedListingID = nil } }
            )) {
                if let id = selectedListingID {
                    ListingDetailView(id: id)
                }
            }
        }
        .task { await loadMore() }
    }

    // MARK: - Load

    private func loadMore() async {
        guard !loading else { return }
        loading = true

        if page < totalPages {
            page += 1
            do {
                let response = try await api.getListings(limit: 12, page: page)
                allListings.append(contentsOf: response.listings)
                totalPages = response.pages
                feed.append(contentsOf: ranked(response.listings))
                errorMsg = nil
            } catch {
                errorMsg = "No se pudo cargar el feed. Verifica tu conexión."
            }
        } else {
            reshuffles += 1
            feed.append(contentsOf: ranked(allListings))
        }

        initialLoad = false
        loading = false
    }

    private func refresh() async {
        feed = []; allListings = []; page = 0
        totalPages = 1; reshuffles = 0; errorMsg = nil; currentIndex = 0
        await loadMore()
    }

    // MARK: - Ranking

    private func ranked(_ items: [Listing]) -> [Listing] {
        let prefs = loadPrefs()
        guard !prefs.isEmpty else { return items.shuffled() }
        return items.sorted { prefScore($0, prefs: prefs) > prefScore($1, prefs: prefs) }
    }

    private func prefScore(_ l: Listing, prefs: [String: Int]) -> Double {
        var s = prefs[l.type] ?? 0
        if let p = l.province { s += prefs[p] ?? 0 }
        if let c = l.city     { s += prefs[c] ?? 0 }
        return Double(s) + Double.random(in: 0...1.5)
    }

    private func trackView(_ listing: Listing) {
        var prefs = loadPrefs()
        prefs[listing.type, default: 0] += 2
        if let p = listing.province { prefs[p, default: 0] += 1 }
        if let c = listing.city     { prefs[c, default: 0] += 1 }
        savePrefs(prefs)
    }

    private func loadPrefs() -> [String: Int] {
        guard let data = prefJSON.data(using: .utf8),
              let d = try? JSONDecoder().decode([String: Int].self, from: data) else { return [:] }
        return d
    }

    private func savePrefs(_ p: [String: Int]) {
        if let data = try? JSONEncoder().encode(p),
           let str = String(data: data, encoding: .utf8) { prefJSON = str }
    }
}

// MARK: - Reel Card (pure visual — no gesture interceptors)

struct ReelCard: View {
    let listing: Listing
    @State private var imageIndex = 0

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {

                // ── Horizontal image carousel ──────────────────
                let urls = listing.allImageURLs
                if urls.isEmpty {
                    ZStack {
                        Color(red: 0.1, green: 0.1, blue: 0.15)
                        Image(systemName: "house.fill")
                            .font(.system(size: 56))
                            .foregroundStyle(.white.opacity(0.2))
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                } else {
                    TabView(selection: $imageIndex) {
                        ForEach(Array(urls.enumerated()), id: \.offset) { i, url in
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let img):
                                    img.resizable().aspectRatio(contentMode: .fill)
                                default:
                                    ZStack {
                                        Color(red: 0.1, green: 0.1, blue: 0.15)
                                        VStack(spacing: 10) {
                                            Image(systemName: "house.fill")
                                                .font(.system(size: 56))
                                                .foregroundStyle(.white.opacity(0.2))
                                            if case .empty = phase {
                                                ProgressView().tint(.white.opacity(0.4))
                                            }
                                        }
                                    }
                                }
                            }
                            .frame(width: geo.size.width, height: geo.size.height)
                            .clipped()
                            .tag(i)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .frame(width: geo.size.width, height: geo.size.height)
                }

                // ── Image counter badge ────────────────────────
                if listing.images.count > 1 {
                    VStack {
                        HStack {
                            Spacer()
                            Text("\(imageIndex + 1) / \(listing.images.count)")
                                .font(.caption2).bold()
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(.ultraThinMaterial)
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                                .padding(.top, 60)
                                .padding(.trailing, 16)
                        }
                        Spacer()
                    }
                }

                // ── Gradient scrim ────────────────────────────
                LinearGradient(
                    colors: [
                        .black.opacity(0.85),
                        .black.opacity(0.5),
                        .black.opacity(0.1),
                        .clear
                    ],
                    startPoint: .bottom,
                    endPoint: .init(x: 0.5, y: 0.45)
                )

                // ── Text overlay ──────────────────────────────
                VStack(alignment: .leading, spacing: 10) {

                    // Type + condition badges
                    HStack(spacing: 8) {
                        typeBadge
                        if let cond = listing.condition, !cond.isEmpty {
                            Text(cond)
                                .font(.caption2).bold()
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(.ultraThinMaterial)
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                        }
                    }

                    // Price
                    Text(listing.priceFormatted)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)

                    // Title
                    Text(listing.title)
                        .font(.headline)
                        .foregroundStyle(.white.opacity(0.95))
                        .lineLimit(2)

                    // Location
                    HStack(spacing: 5) {
                        Image(systemName: "mappin.fill")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                        Text(locationString)
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                    }

                    // Stats chips
                    if hasStats {
                        HStack(spacing: 12) {
                            if let beds = listing.bedrooms, beds != "0" {
                                reelStat(icon: "bed.double.fill", value: beds + " Hab.")
                            }
                            if let baths = listing.bathrooms {
                                reelStat(icon: "shower.fill", value: baths + " Baños")
                            }
                            if let area = listing.area_const, !area.isEmpty {
                                reelStat(icon: "ruler.fill", value: area + " m²")
                            }
                        }
                    }

                    // Agency + tap hint
                    HStack {
                        if let name = listing.agencies?.first?.name {
                            HStack(spacing: 5) {
                                Image(systemName: "building.2.fill")
                                    .font(.caption2)
                                    .foregroundStyle(Color.rdBlue)
                                Text(name)
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.75))
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        HStack(spacing: 4) {
                            Text("Ver detalles")
                                .font(.caption).bold()
                                .foregroundStyle(.white.opacity(0.8))
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.6))
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 90) // clear tab bar
            }
        }
        .ignoresSafeArea()
    }

    // MARK: - Helpers

    private var typeBadge: some View {
        Text(listing.typeLabel)
            .font(.caption2).bold()
            .padding(.horizontal, 10).padding(.vertical, 5)
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
            .compactMap { v in (v?.isEmpty == false) ? v : nil }
            .joined(separator: ", ")
    }

    private var hasStats: Bool {
        listing.bedrooms != nil || listing.bathrooms != nil ||
        (listing.area_const.map { !$0.isEmpty } ?? false)
    }

    private func reelStat(icon: String, value: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.7))
            Text(value)
                .font(.caption).bold()
                .foregroundStyle(.white.opacity(0.9))
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
    }
}
