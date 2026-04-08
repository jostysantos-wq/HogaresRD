import SwiftUI

// MARK: - FeedItem

/// A feed item is either a real listing or a sponsored ad.
enum FeedItem: Identifiable {
    case listing(Listing)
    case ad(Ad, slot: Int) // slot index makes each ad placement unique

    var id: String {
        switch self {
        case .listing(let l):      return "l-\(l.id)"
        case .ad(let a, let slot): return "a-\(a.id)-\(slot)"
        }
    }
}

// MARK: - Feed View

struct FeedView: View {
    @EnvironmentObject var api: APIService

    @State private var allListings:        [Listing] = []
    @State private var feed:               [FeedItem] = []
    @State private var activeAds:          [Ad]       = []
    @State private var currentIndex        = 0
    @State private var page                = 0
    @State private var totalPages          = 1
    @State private var loading             = false
    @State private var initialLoad         = true
    @State private var reshuffles          = 0
    @State private var errorMsg:           String?
    @State private var selectedListingID:  String?
    @State private var selectedAgencySlug: String?

    /// How many listings between each ad slot
    private let adFrequency = 5

    /// Timestamp recorded when each card index appears on screen
    @State private var appearedAt: [Int: Date] = [:]

    /// Weighted interest scores keyed by listing attribute (type, province, city)
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
                                ForEach(Array(feed.enumerated()), id: \.element.id) { index, item in
                                    Group {
                                        switch item {
                                        case .listing(let listing):
                                            ReelCard(
                                                listing:     listing,
                                                onTap:       { selectedListingID = listing.id },
                                                onAgencyTap: { slug in selectedAgencySlug = slug },
                                                onSaveTap:   { applyWeight(listing, weight: 10.0) }
                                            )
                                            .onDisappear {
                                                if let start = appearedAt.removeValue(forKey: index) {
                                                    trackDwell(listing, seconds: Date().timeIntervalSince(start))
                                                }
                                            }
                                        case .ad(let ad, _):
                                            AdCard(
                                                ad: ad,
                                                onImpression: { api.trackAdImpression(ad.id) },
                                                onTap: {
                                                    api.trackAdClick(ad.id)
                                                    if let url = ad.targetURL {
                                                        UIApplication.shared.open(url)
                                                    }
                                                }
                                            )
                                        }
                                    }
                                    .frame(width: proxy.size.width, height: proxy.size.height)
                                    .onAppear {
                                        currentIndex = index
                                        appearedAt[index] = Date()
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
            // Tap-through bonus: opening the detail view is a strong interest signal
            .onChange(of: selectedListingID) { _, newID in
                if let id = newID {
                    for item in feed {
                        if case .listing(let l) = item, l.id == id {
                            applyWeight(l, weight: 8.0)
                            break
                        }
                    }
                }
            }
            .navigationDestination(isPresented: Binding(
                get: { selectedListingID != nil },
                set: { if !$0 { selectedListingID = nil } }
            )) {
                if let id = selectedListingID { ListingDetailView(id: id) }
            }
            .navigationDestination(isPresented: Binding(
                get: { selectedAgencySlug != nil },
                set: { if !$0 { selectedAgencySlug = nil } }
            )) {
                if let slug = selectedAgencySlug { AgencyPortfolioView(slug: slug) }
            }
        }
        .task {
            applySessionDecay() // fade stale history before each session
            await loadMore()
        }
    }

    // MARK: - Load

    private func loadMore() async {
        guard !loading else { return }
        loading = true

        // Fetch ads on the very first load
        if activeAds.isEmpty {
            activeAds = await api.fetchActiveAds()
        }

        if page < totalPages {
            page += 1
            do {
                let response = try await api.getListings(limit: 12, page: page)
                allListings.append(contentsOf: response.listings)
                totalPages = response.pages
                feed.append(contentsOf: interleaved(ranked(response.listings)))
                errorMsg = nil
            } catch {
                errorMsg = "No se pudo cargar el feed. Verifica tu conexión."
            }
        } else {
            reshuffles += 1
            feed.append(contentsOf: interleaved(ranked(allListings)))
        }

        initialLoad = false
        loading = false
    }

    private func refresh() async {
        feed = []; allListings = []; activeAds = []; page = 0
        totalPages = 1; reshuffles = 0; errorMsg = nil; currentIndex = 0
        appearedAt = [:]
        await loadMore()
    }

    /// Inserts an ad slot every `adFrequency` listings, cycling through activeAds.
    private func interleaved(_ listings: [Listing]) -> [FeedItem] {
        guard !activeAds.isEmpty else { return listings.map { .listing($0) } }
        var result: [FeedItem] = []
        var adSlot = feed.filter { if case .ad = $0 { return true }; return false }.count
        var adIndex = adSlot % activeAds.count
        for (i, listing) in listings.enumerated() {
            result.append(.listing(listing))
            if (i + 1) % adFrequency == 0 {
                result.append(.ad(activeAds[adIndex % activeAds.count], slot: adSlot))
                adIndex += 1
                adSlot += 1
            }
        }
        return result
    }

    // MARK: - Dwell Time Tracking
    //
    // Signal weights mirror real recommendation systems:
    //   < 1.5s  → quick skip      (-0.5)  mild negative
    //   1.5–4s  → glance          (+1.0)  weak positive
    //   4–10s   → interest        (+3.0)  moderate signal
    //   10–30s  → strong interest (+5.0)  strong signal
    //   > 30s   → very engaged    (+8.0)  highest passive signal
    //   tap     → opened detail   (+8.0)  strong explicit signal
    //   save    → hearted         (+10.0) strongest signal

    private func trackDwell(_ listing: Listing, seconds: TimeInterval) {
        let weight: Double
        switch seconds {
        case ..<1.5:  weight = -0.5
        case 1.5..<4: weight =  1.0
        case 4..<10:  weight =  3.0
        case 10..<30: weight =  5.0
        default:      weight =  8.0
        }
        applyWeight(listing, weight: weight)
    }

    /// Adds `weight` to each interest dimension of a listing in the prefs store
    private func applyWeight(_ listing: Listing, weight: Double) {
        var prefs = loadPrefs()
        prefs[listing.type, default: 0] += weight
        // Province and city carry half the weight — they're secondary signals
        if let p = listing.province { prefs[p, default: 0] += weight * 0.5 }
        if let c = listing.city     { prefs[c, default: 0] += weight * 0.5 }
        savePrefs(prefs)
    }

    // MARK: - Session Decay
    //
    // Multiplies all scores by 0.9 at the start of every session.
    // This prevents old behaviour from locking in forever:
    //   • after ~7 sessions with no reinforcement, a signal drops below 50% strength
    //   • keeps the feed fresh as the user's real-life needs evolve

    private func applySessionDecay() {
        var prefs = loadPrefs()
        guard !prefs.isEmpty else { return }
        prefs = prefs.mapValues { $0 * 0.9 }
        savePrefs(prefs)
    }

    // MARK: - Ranking

    private func ranked(_ items: [Listing]) -> [Listing] {
        let prefs = loadPrefs()
        // No prefs yet (new user) → random shuffle so everyone gets a fair start
        guard !prefs.isEmpty else { return items.shuffled() }
        return items.sorted { prefScore($0, prefs: prefs) > prefScore($1, prefs: prefs) }
    }

    /// Score = sum of learned weights for this listing's attributes + small random noise.
    /// The noise (0–1.5) prevents identical-score items from always appearing in the
    /// same order while still letting strongly-preferred items float to the top.
    private func prefScore(_ l: Listing, prefs: [String: Double]) -> Double {
        var s  = prefs[l.type] ?? 0
        if let p = l.province { s += prefs[p] ?? 0 }
        if let c = l.city     { s += prefs[c] ?? 0 }
        return s + Double.random(in: 0...1.5)
    }

    // MARK: - Prefs Persistence ([String: Double] stored as JSON in AppStorage)

    private func loadPrefs() -> [String: Double] {
        guard let data = prefJSON.data(using: .utf8),
              let d = try? JSONDecoder().decode([String: Double].self, from: data)
        else { return [:] }
        return d
    }

    private var _prefSaveTask: Task<Void, Never>?
    private func savePrefs(_ p: [String: Double]) {
        // Debounce: batch rapid writes (dwell time, taps) into one disk write
        _prefSaveTask?.cancel()
        _prefSaveTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            if let data = try? JSONEncoder().encode(p),
               let str  = String(data: data, encoding: .utf8) { prefJSON = str }
        }
    }
}

// MARK: - Reel Card

struct ReelCard: View {
    let listing:     Listing
    var onTap:       (() -> Void)       = { }      // navigate to detail
    var onAgencyTap: ((String) -> Void) = { _ in }
    var onSaveTap:   (() -> Void)       = { }      // called alongside heart toggle

    @EnvironmentObject var saved: SavedStore
    @State private var imageIndex = 0
    @State private var heartScale: CGFloat = 1.0
    @State private var doubleTapHeart = false
    @State private var localFavCount: Int = 0

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {

                // ── Image carousel (TabView — locks horizontal swipe to images only) ──
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
                .allowsHitTesting(false)

                // ── Double-tap heart overlay (centered) ──────
                if doubleTapHeart {
                    Image(systemName: "heart.fill")
                        .font(.system(size: 80))
                        .foregroundStyle(Color.rdRed)
                        .shadow(color: .black.opacity(0.3), radius: 10)
                        .transition(.scale.combined(with: .opacity))
                        .frame(width: geo.size.width, height: geo.size.height)
                }

                // ── Top-right controls (like + save + share) ──────────────
                VStack {
                    HStack {
                        Spacer()
                        VStack(spacing: 10) {
                            if listing.images.count > 1 {
                                Text("\(imageIndex + 1) / \(listing.images.count)")
                                    .font(.caption2).bold()
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(.ultraThinMaterial)
                                    .foregroundStyle(.white)
                                    .clipShape(Capsule())
                            }
                            // Like button (heart) + count
                            Button {
                                toggleLike()
                            } label: {
                                VStack(spacing: 3) {
                                    Image(systemName: localFavCount > 0 ? "heart.fill" : "heart")
                                        .font(.system(size: 24, weight: .semibold))
                                        .foregroundStyle(localFavCount > 0 ? Color.rdRed : .white)
                                        .shadow(color: .black.opacity(0.5), radius: 4)
                                        .scaleEffect(heartScale)
                                    Text("\(localFavCount)")
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(.white)
                                        .shadow(color: .black.opacity(0.5), radius: 2)
                                }
                                .frame(width: 48)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .onAppear { localFavCount = listing.favoriteCount ?? 0 }

                            // Save/Guardar button (bookmark)
                            Button {
                                toggleSave()
                            } label: {
                                VStack(spacing: 3) {
                                    Image(systemName: saved.isSaved(listing.id) ? "bookmark.fill" : "bookmark")
                                        .font(.system(size: 22, weight: .semibold))
                                        .foregroundStyle(saved.isSaved(listing.id) ? Color.rdBlue : .white)
                                        .shadow(color: .black.opacity(0.5), radius: 4)
                                    Text("Guardar")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(.white)
                                        .shadow(color: .black.opacity(0.5), radius: 2)
                                }
                                .frame(width: 48)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            // Share button
                            Button {
                                shareListing()
                            } label: {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 20, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .shadow(color: .black.opacity(0.5), radius: 4)
                                    .frame(width: 48, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.top, 48)
                        .padding(.trailing, 4)
                    }
                    Spacer()
                }

                // ── Image dot indicators ─────────────────────────────
                if listing.images.count > 1 {
                    VStack {
                        Spacer()
                        HStack(spacing: 5) {
                            ForEach(0..<min(listing.images.count, 8), id: \.self) { i in
                                Circle()
                                    .fill(i == imageIndex ? .white : .white.opacity(0.4))
                                    .frame(width: i == imageIndex ? 7 : 5, height: i == imageIndex ? 7 : 5)
                                    .animation(.easeInOut(duration: 0.15), value: imageIndex)
                            }
                            if listing.images.count > 8 {
                                Text("+\(listing.images.count - 8)")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white.opacity(0.6))
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(.black.opacity(0.3))
                        .clipShape(Capsule())
                        .padding(.bottom, 96)
                    }
                    .allowsHitTesting(false)
                }

                // ── Text overlay (tappable → detail) ─────────────────
                VStack(alignment: .leading, spacing: 10) {

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

                    Text(listing.priceFormatted)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)

                    Text(listing.title)
                        .font(.headline)
                        .foregroundStyle(.white.opacity(0.95))
                        .lineLimit(2)

                    HStack(spacing: 5) {
                        Image(systemName: "mappin.fill")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                        Text(locationString)
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                    }

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

                    HStack {
                        if let agency = listing.agencies?.first, let name = agency.name {
                            Button {
                                if let slug = agency.slug { onAgencyTap(slug) }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "building.2.fill")
                                        .font(.caption2)
                                        .foregroundStyle(Color.rdBlue)
                                    Text(name)
                                        .font(.caption)
                                        .foregroundStyle(.white.opacity(0.75))
                                        .lineLimit(1)
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 8))
                                        .foregroundStyle(.white.opacity(0.4))
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        Spacer()
                        Button { onTap() } label: {
                            HStack(spacing: 4) {
                                Text("Ver detalles")
                                    .font(.caption).bold()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9, weight: .bold))
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(.ultraThinMaterial)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 90)
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 2) {
                doubleTapLike()
            }
            .onTapGesture(count: 1) {
                onTap()
            }
        }
        .ignoresSafeArea()
    }

    // MARK: - Actions

    /// Like button (heart) — visual engagement counter. Does NOT save
    /// the listing to "Propiedades guardadas". Just bumps the like count.
    private func toggleLike() {
        let impact = UIImpactFeedbackGenerator(style: .medium)
        impact.impactOccurred()
        withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
            heartScale = 1.3
        }
        // TODO: wire to a dedicated /api/listings/:id/like endpoint if
        // server-side like tracking is needed. For now, optimistic local.
        localFavCount += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                heartScale = 1.0
            }
        }
    }

    /// Save/Guardar button (bookmark) — adds to "Propiedades guardadas".
    /// Requires auth; guests see login sheet.
    private func toggleSave() {
        let impact = UIImpactFeedbackGenerator(style: .light)
        impact.impactOccurred()
        let didToggle = saved.toggle(listing.id)
        if didToggle {
            onSaveTap()
        }
    }

    private func doubleTapLike() {
        let impact = UIImpactFeedbackGenerator(style: .heavy)
        impact.impactOccurred()

        // Always show the heart animation
        withAnimation(.spring(response: 0.35, dampingFraction: 0.5)) {
            doubleTapHeart = true
            heartScale = 1.3
        }

        // Bump the like count
        localFavCount += 1

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            withAnimation(.easeOut(duration: 0.3)) {
                doubleTapHeart = false
            }
            withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                heartScale = 1.0
            }
        }
    }

    private func shareListing() {
        let url = "https://hogaresrd.com/listing/\(listing.id)"
        let text = "\(listing.title) – \(listing.priceFormatted)\n\(url)"
        let av = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let root = scene.windows.first?.rootViewController {
            root.present(av, animated: true)
        }
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
