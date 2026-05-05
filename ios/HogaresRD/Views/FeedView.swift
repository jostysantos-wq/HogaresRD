import SwiftUI

// MARK: - FeedView (home screen)
//
// Replaces the previous TikTok-style reel feed with a curated home
// landing — header greeting, search pill, category chips, a hero
// "Featured Listings" card, and a horizontal "Top Property" rail.
// Layout follows the cream/forest-green editorial design (see the
// design screenshot in chat). Listing data still comes from
// /api/listings; we just present it differently.

struct FeedView: View {
    @EnvironmentObject var api: APIService

    @State private var listings: [Listing]    = []
    @State private var loading                = false
    @State private var errorMsg: String?
    @State private var selectedListingID: String?
    @State private var searchQuery            = ""
    @State private var selectedCategory: HomeCategory = .all

    enum HomeCategory: String, CaseIterable, Identifiable {
        case all      = "All"
        case rent     = "Rent"
        case buy      = "Buy"
        case house    = "House"
        case project  = "Project"
        var id: String { rawValue }

        /// Filter predicate for a listing.
        func matches(_ l: Listing) -> Bool {
            switch self {
            case .all:     return true
            case .rent:    return l.type == "alquiler"
            case .buy:     return l.type == "venta"
            case .house:   return (l.tags ?? []).contains(where: { $0.lowercased().contains("casa") })
                                   || (l.title.lowercased().contains("casa"))
            case .project: return l.type == "proyecto"
            }
        }
    }

    // ── Color palette (locked to the editorial mock) ─────────
    private static let bgTop   = Color(red: 245/255, green: 237/255, blue: 224/255) // warm cream
    private static let bgMid   = Color(red: 239/255, green: 229/255, blue: 210/255)
    private static let bgEnd   = Color(red: 232/255, green: 218/255, blue: 193/255) // peach
    private static let ink     = Color(red:  19/255, green:  19/255, blue:  24/255)
    private static let inkSoft = Color(red:  60/255, green:  60/255, blue:  68/255)
    private static let inkMute = Color(red: 138/255, green: 143/255, blue: 152/255)
    private static let forest  = Color(red:  31/255, green:  61/255, blue:  51/255) // dark forest green
    private static let yellow  = Color(red: 247/255, green: 197/255, blue:  78/255)

    private var greetingName: String {
        // First name from currentUser.name, falling back gracefully.
        let full = api.currentUser?.name ?? "amigo"
        let first = full.split(separator: " ").first.map(String.init) ?? full
        return first
    }

    private var locationLine: String {
        // We don't carry a city field on User yet — default to a
        // generic Dominican location. The dropdown chevron is a hint
        // that this will become editable in a future round.
        "Santo Domingo, RD"
    }

    private var filteredListings: [Listing] {
        listings.filter { selectedCategory.matches($0) }
    }

    private var featuredListing: Listing? { filteredListings.first }
    private var topProperties: [Listing]   { Array(filteredListings.dropFirst().prefix(8)) }

    // MARK: Body

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(
                    colors: [Self.bgTop, Self.bgMid, Self.bgEnd],
                    startPoint: .top, endPoint: .bottom
                )
                .ignoresSafeArea()

                if loading && listings.isEmpty {
                    ProgressView().tint(Self.forest)
                } else if let err = errorMsg, listings.isEmpty {
                    errorState(err)
                } else {
                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 24) {
                            headerCard
                            searchRow
                            categoryRow
                            featuredSection
                            topPropertySection
                        }
                        .padding(.horizontal, 22)
                        .padding(.top, 12)
                        // System TabView reserves its own safe-area
                        // inset; just give a small visual gap.
                        .padding(.bottom, 16)
                    }
                    .refreshable { await refresh() }
                }
            }
            .navigationBarHidden(true)
            .task {
                if listings.isEmpty { await refresh() }
            }
            .fullScreenCover(item: Binding(
                get: { selectedListingID.map(WrappedID.init) },
                set: { selectedListingID = $0?.id }
            )) { wrap in
                NavigationStack {
                    ListingDetailView(id: wrap.id)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Cerrar") { selectedListingID = nil }
                            }
                        }
                }
                .environmentObject(api)
            }
        }
    }

    // MARK: Header

    private var headerCard: some View {
        HStack(spacing: 12) {
            // Avatar — show photo if logged-in, otherwise a neutral
            // initials circle so the layout looks the same shape.
            Group {
                if let user = api.currentUser {
                    AvatarView(user: user, size: 44, color: Self.forest)
                } else {
                    ZStack {
                        Circle()
                            .fill(Self.forest)
                            .frame(width: 44, height: 44)
                        Image(systemName: "person.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(.white)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Hola, \(greetingName)")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Self.ink)

                HStack(spacing: 4) {
                    Text(locationLine)
                        .font(.system(size: 13))
                        .foregroundStyle(Self.inkMute)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Self.inkMute)
                }
            }

            Spacer(minLength: 8)

            Button {
                NotificationCenter.default.post(name: .openNotifications, object: nil)
            } label: {
                ZStack {
                    Circle()
                        .fill(Color.white)
                        .frame(width: 44, height: 44)
                    Image(systemName: "bell")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(Self.ink)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Notificaciones")
        }
    }

    // MARK: Search row

    private var searchRow: some View {
        HStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15))
                    .foregroundStyle(Self.inkMute)
                TextField("Buscar destino", text: $searchQuery)
                    .font(.system(size: 14))
                    .foregroundStyle(Self.ink)
                    .submitLabel(.search)
                    .onSubmit { /* no-op for now */ }
            }
            .padding(.horizontal, 20)
            .frame(height: 50)
            .background(Color.white, in: Capsule())

            Button {
                /* filter sheet placeholder */
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Self.ink)
                    .frame(width: 50, height: 50)
                    .background(Color.white, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Filtros")
        }
    }

    // MARK: Category chips

    private var categoryRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(HomeCategory.allCases) { cat in
                    let active = (cat == selectedCategory)
                    Button {
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                            selectedCategory = cat
                        }
                    } label: {
                        Text(cat.rawValue)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(active ? .white : Self.ink)
                            .padding(.horizontal, 22)
                            .padding(.vertical, 10)
                            .background(
                                active ? Self.forest : Color.white,
                                in: Capsule()
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2) // small breathing room for shadows
        }
    }

    // MARK: Featured section

    private var featuredSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Destacadas", action: "Ver todas")
            if let listing = featuredListing {
                FeaturedListingCard(listing: listing,
                                    forest: Self.forest,
                                    yellow: Self.yellow)
                    .onTapGesture { selectedListingID = listing.id }
            } else {
                emptyState("No hay propiedades destacadas")
            }
        }
    }

    // MARK: Top Property section

    private var topPropertySection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Propiedades destacadas", action: "Ver todas")
            if topProperties.isEmpty {
                emptyState("No hay más propiedades")
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(topProperties) { listing in
                            TopPropertyCard(listing: listing,
                                            forest: Self.forest,
                                            yellow: Self.yellow)
                                .onTapGesture { selectedListingID = listing.id }
                        }
                    }
                }
            }
        }
    }

    // MARK: Helpers

    private func sectionHeader(title: String, action: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Self.ink)
            Spacer()
            Button(action) { /* placeholder */ }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Self.inkSoft)
        }
    }

    private func emptyState(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 14))
            .foregroundStyle(Self.inkMute)
            .frame(maxWidth: .infinity, minHeight: 100)
            .background(Color.white.opacity(0.4), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func errorState(_ err: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 32))
                .foregroundStyle(Self.inkMute)
            Text(err)
                .font(.subheadline)
                .foregroundStyle(Self.inkSoft)
                .multilineTextAlignment(.center)
            Button("Reintentar") { Task { await refresh() } }
                .buttonStyle(.borderedProminent)
                .tint(Self.forest)
        }
        .padding(40)
    }

    // MARK: Data

    @MainActor
    private func refresh() async {
        loading = true
        errorMsg = nil
        do {
            let resp = try await api.getListings(limit: 30, page: 1)
            listings = resp.listings
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    // Wrap a String in an Identifiable so .fullScreenCover can use it.
    private struct WrappedID: Identifiable {
        let id: String
    }
}

// MARK: - Featured listing card
//
// The big hero card with image, type/rating chips, and a stats row
// (beds / baths / sqft).

struct FeaturedListingCard: View {
    let listing: Listing
    let forest: Color
    let yellow: Color

    private var statusLabel: String {
        switch listing.type {
        case "alquiler": return "Alquiler"
        case "venta":    return "Venta"
        case "proyecto": return "Proyecto"
        default:         return listing.typeLabel
        }
    }

    private var statusDotColor: Color {
        switch listing.type {
        case "alquiler": return Color(red: 0.18, green: 0.78, blue: 0.55)
        case "venta":    return Color(red: 0.95, green: 0.62, blue: 0.18)
        case "proyecto": return Color(red: 0.36, green: 0.54, blue: 0.95)
        default:         return .white
        }
    }

    private var locationLine: String {
        [listing.sector, listing.city]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: ", ")
            .ifEmpty(listing.province ?? "República Dominicana")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // ── Photo with floating chips ──
            ZStack(alignment: .top) {
                CachedAsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        LinearGradient(
                            colors: [Color(white: 0.85), Color(white: 0.7)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    }
                }
                .frame(height: 220)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

                HStack {
                    StatusPill(label: statusLabel, dot: statusDotColor)
                    Spacer()
                    if let v = listing.views, v > 0 {
                        RatingPill(rating: 4.5, yellow: yellow) // placeholder rating
                    } else {
                        RatingPill(rating: 4.5, yellow: yellow)
                    }
                }
                .padding(14)
            }

            // ── Title + price ──
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(listing.title)
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(Color(red: 0.07, green: 0.07, blue: 0.10))
                        .lineLimit(2)
                    Text(locationLine)
                        .font(.system(size: 13))
                        .foregroundStyle(Color(red: 0.54, green: 0.56, blue: 0.60))
                }
                Spacer(minLength: 12)
                Text(listing.shortPrice)
                    .font(.system(size: 22, weight: .heavy))
                    .foregroundStyle(forest)
                    .lineLimit(1)
            }

            // ── Stats row ──
            HStack(spacing: 10) {
                StatChip(icon: "bed.double.fill",
                         label: "\(listing.bedrooms ?? "—") Hab.")
                StatChip(icon: "drop.fill",
                         label: "\(listing.bathrooms ?? "—") Baños")
                StatChip(icon: "square.dashed",
                         label: "\(listing.area_const ?? listing.area_land ?? "—") m²")
            }
        }
        .padding(16)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .shadow(color: .black.opacity(0.06), radius: 12, x: 0, y: 6)
    }
}

// MARK: - Top property card

struct TopPropertyCard: View {
    let listing: Listing
    let forest: Color
    let yellow: Color

    private var statusLabel: String {
        switch listing.type {
        case "alquiler": return "Alquiler"
        case "venta":    return "Venta"
        case "proyecto": return "Proyecto"
        default:         return listing.typeLabel
        }
    }

    private var statusDotColor: Color {
        switch listing.type {
        case "alquiler": return Color(red: 0.18, green: 0.78, blue: 0.55)
        case "venta":    return Color(red: 0.95, green: 0.62, blue: 0.18)
        case "proyecto": return Color(red: 0.36, green: 0.54, blue: 0.95)
        default:         return .white
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .top) {
                CachedAsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        LinearGradient(colors: [Color(white: 0.85), Color(white: 0.7)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
                }
                .frame(width: 200, height: 130)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                HStack {
                    StatusPill(label: statusLabel, dot: statusDotColor, compact: true)
                    Spacer()
                    RatingPill(rating: 4.5, yellow: yellow, compact: true)
                }
                .padding(8)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(listing.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(red: 0.07, green: 0.07, blue: 0.10))
                    .lineLimit(1)
                Text(listing.shortPrice)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(forest)
            }
        }
        .frame(width: 200)
    }
}

// MARK: - Reusable chips

private struct StatusPill: View {
    let label: String
    let dot: Color
    var compact: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(dot)
                .frame(width: compact ? 6 : 7, height: compact ? 6 : 7)
            Text(label)
                .font(.system(size: compact ? 11 : 12, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, compact ? 10 : 12)
        .padding(.vertical, compact ? 5 : 6)
        .background(.ultraThinMaterial.opacity(0.85), in: Capsule())
        .background(Color.black.opacity(0.45), in: Capsule())
    }
}

private struct RatingPill: View {
    let rating: Double
    let yellow: Color
    var compact: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "star.fill")
                .font(.system(size: compact ? 9 : 10))
                .foregroundStyle(yellow)
            Text(String(format: "%.1f", rating))
                .font(.system(size: compact ? 11 : 12, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, compact ? 9 : 10)
        .padding(.vertical, compact ? 5 : 6)
        .background(.ultraThinMaterial.opacity(0.85), in: Capsule())
        .background(Color.black.opacity(0.45), in: Capsule())
    }
}

private struct StatChip: View {
    let icon: String
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(Color(red: 0.20, green: 0.21, blue: 0.24))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(Color(red: 0.96, green: 0.96, blue: 0.97), in: Capsule())
    }
}

// MARK: - Tiny helpers

private extension String {
    func ifEmpty(_ fallback: String) -> String {
        isEmpty ? fallback : self
    }
}

extension Notification.Name {
    static let openNotifications = Notification.Name("openNotifications")
}
