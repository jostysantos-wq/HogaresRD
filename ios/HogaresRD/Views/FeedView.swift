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

    // ── Color palette (aliased to design-system tokens) ───────
    //
    // All chrome routes through `Color.rd*` so dark-mode + accent
    // re-skinning happen globally. Keep these aliases as `static let`
    // so the rest of the file (and `FeaturedListingCard` /
    // `TopPropertyCard`) keeps reading naturally.
    private static let bgTop   = Color.rdSurface
    private static let bgMid   = Color.rdSurfaceMuted
    private static let bgEnd   = Color.rdSurfaceMuted
    private static let ink     = Color.rdInk
    private static let inkSoft = Color.rdInkSoft
    private static let inkMute = Color.rdMuted
    private static let forest  = Color.rdInk        // primary accent — see ContentView's FloatingTabBar
    private static let yellow  = Color.rdOrange     // featured chip / star fill

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
                        .padding(.bottom, 120) // floating tab-bar clearance
                    }
                    .refreshable { await refresh() }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
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
                            .font(.body)
                            .foregroundStyle(.white)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Hola, \(greetingName)")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(Self.ink)

                HStack(spacing: 4) {
                    Text(locationLine)
                        .font(.footnote)
                        .foregroundStyle(Self.inkMute)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Self.inkMute)
                }
            }

            Spacer(minLength: 8)

            Button {
                NotificationCenter.default.post(name: .openNotifications, object: nil)
            } label: {
                ZStack {
                    Circle()
                        .fill(Color.rdSurface)
                        .frame(width: 44, height: 44)
                    Image(systemName: "bell")
                        .font(.body)
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
                    .font(.subheadline)
                    .foregroundStyle(Self.inkMute)
                TextField("Buscar destino", text: $searchQuery)
                    .font(.subheadline)
                    .foregroundStyle(Self.ink)
                    .submitLabel(.search)
                    .onSubmit { /* no-op for now */ }
            }
            .padding(.horizontal, 20)
            .frame(height: 50)
            .background(Color.rdSurface, in: Capsule())

            Button {
                /* filter sheet placeholder */
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.body)
                    .foregroundStyle(Self.ink)
                    .frame(width: 50, height: 50)
                    .background(Color.rdSurface, in: Circle())
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
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(active ? Color.rdSurface : Self.ink)
                            .padding(.horizontal, 22)
                            .padding(.vertical, 10)
                            .background(
                                active ? Self.forest : Color.rdSurface,
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
                .font(.title3.weight(.bold))
                .foregroundStyle(Self.ink)
            Spacer()
            Button(action) { /* placeholder */ }
                .font(.footnote.weight(.medium))
                .foregroundStyle(Self.inkSoft)
        }
    }

    private func emptyState(_ msg: String) -> some View {
        EmptyStateView.calm(
            systemImage: "tray",
            title: msg,
            description: ""
        )
        .frame(maxWidth: .infinity, minHeight: 120)
        .background(Color.rdSurface.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }

    private func errorState(_ err: String) -> some View {
        EmptyStateView.calm(
            systemImage: "wifi.slash",
            title: "Sin conexión",
            description: err,
            actionTitle: "Reintentar",
            action: { Task { await refresh() } }
        )
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
        case "alquiler": return .rdGreen
        case "venta":    return .rdOrange
        case "proyecto": return .rdBlue
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
                .clipShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))

                HStack {
                    FeedStatusPill(label: statusLabel, dot: statusDotColor)
                    Spacer()
                    DSRatingPill(value: 4.5, tint: yellow)
                }
                .padding(14)
            }

            // ── Title + price ──
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(listing.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(Color.rdInk)
                        .lineLimit(2)
                    Text(locationLine)
                        .font(.footnote)
                        .foregroundStyle(Color.rdMuted)
                }
                Spacer(minLength: 12)
                Text(listing.shortPrice)
                    .font(.title2.weight(.heavy))
                    .foregroundStyle(forest)
                    .lineLimit(1)
            }

            // ── Stats row ──
            HStack(spacing: 10) {
                FeedStatChip(icon: "bed.double.fill",
                             label: "\(listing.bedrooms ?? "—") Hab.")
                FeedStatChip(icon: "drop.fill",
                             label: "\(listing.bathrooms ?? "—") Baños")
                FeedStatChip(icon: "square.dashed",
                             label: "\(listing.area_const ?? listing.area_land ?? "—") m²")
            }
        }
        .padding(Spacing.s16)
        .background(Color.rdSurface, in: RoundedRectangle(cornerRadius: Radius.xlarge, style: .continuous))
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
        case "alquiler": return .rdGreen
        case "venta":    return .rdOrange
        case "proyecto": return .rdBlue
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
                .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))

                HStack {
                    FeedStatusPill(label: statusLabel, dot: statusDotColor, compact: true)
                    Spacer()
                    DSRatingPill(value: 4.5, tint: yellow)
                }
                .padding(Spacing.s8)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(listing.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.rdInk)
                    .lineLimit(1)
                Text(listing.shortPrice)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(forest)
            }
        }
        .frame(width: 200)
    }
}

// MARK: - Reusable chips
//
// Photo-overlay variants: these sit on top of cropped property
// imagery and need a translucent dark backing for legibility — the
// design-system DSPill (cream tint) wouldn't read on a photo.
// The standalone status / rating call sites elsewhere should use
// `DSStatusBadge` / `DSRatingPill` directly.

private struct FeedStatusPill: View {
    let label: String
    let dot: Color
    var compact: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(dot)
                .frame(width: compact ? 6 : 7, height: compact ? 6 : 7)
            Text(label)
                .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, compact ? 10 : 12)
        .padding(.vertical, compact ? 5 : 6)
        .background(.ultraThinMaterial.opacity(0.85), in: Capsule())
        .background(Color.black.opacity(0.45), in: Capsule())
    }
}

private struct FeedStatChip: View {
    let icon: String
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
            Text(label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(Color.rdInk)
        .padding(.horizontal, Spacing.s12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(Color.rdSurfaceMuted, in: Capsule())
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
