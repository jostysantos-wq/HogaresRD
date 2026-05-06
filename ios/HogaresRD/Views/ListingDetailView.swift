import SwiftUI
import MapKit

/// PreferenceKey used by ListingDetailView to observe vertical scroll offset,
/// so the floating hero overlay bar can fade out as the user scrolls past.
private struct ScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// MARK: - Design Tokens (light + dark)

/// Listing-detail palette. Mirrors the editorial dark prototype but adapts
/// to light mode via UITraitCollection-aware UIColor closures.
private enum LD {
    static let bg = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x0E/255, green: 0x12/255, blue: 0x19/255, alpha: 1)
            : UIColor.systemBackground
    })
    static let surface = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x16/255, green: 0x1B/255, blue: 0x25/255, alpha: 1)
            : UIColor.secondarySystemBackground
    })
    static let surfaceDeep = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x1E/255, green: 0x25/255, blue: 0x31/255, alpha: 1)
            : UIColor.tertiarySystemBackground
    })
    static let line = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.14)
            : UIColor(white: 0, alpha: 0.10)
    })
    static let lineSoft = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.08)
            : UIColor(white: 0, alpha: 0.06)
    })
    static let trayBg = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.04)
            : UIColor(white: 0, alpha: 0.025)
    })
    static let chipBg = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.06)
            : UIColor(white: 0, alpha: 0.04)
    })
    static let textSoft = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0xC2/255, green: 0xC8/255, blue: 0xD2/255, alpha: 1)
            : UIColor.label.withAlphaComponent(0.75)
    })
    static let textMute = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x97/255, green: 0xA0/255, blue: 0xAF/255, alpha: 1)
            : UIColor.secondaryLabel
    })
    /// Vivid accent used by the design (matches #006AFF). Keeps the same
    /// rendered weight against both light and dark surfaces.
    static let brand = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x4D/255, green: 0x9E/255, blue: 0xFF/255, alpha: 1)
            : UIColor(red: 0x00/255, green: 0x6A/255, blue: 0xFF/255, alpha: 1)
    })
    static let brandSoft = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x00/255, green: 0x6A/255, blue: 0xFF/255, alpha: 0.16)
            : UIColor(red: 0x00/255, green: 0x6A/255, blue: 0xFF/255, alpha: 0.10)
    })
    static let green = Color(red: 0x2B/255, green: 0xD2/255, blue: 0x7A/255)
    static let red   = Color(red: 0xF2/255, green: 0x51/255, blue: 0x51/255)
    static let amber = Color(red: 0xF5/255, green: 0xB5/255, blue: 0x47/255)
    /// Card sits inverted vs page bg — white in dark, black in light.
    static let primaryCTABg = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark ? .white : UIColor(white: 0.06, alpha: 1)
    })
    static let primaryCTAFg = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark ? UIColor(red: 0x0E/255, green: 0x12/255, blue: 0x19/255, alpha: 1) : .white
    })
}

struct ListingDetailView: View {
    let id: String
    @EnvironmentObject var saved: SavedStore
    @Environment(\.dismiss) var dismiss
    @State private var listing:        Listing?
    @State private var loading         = true
    @State private var imageIndex      = 0
    @State private var blueprintIndex  = 0
    @State private var showApply        = false
    @State private var showContactAgent = false
    @State private var showFullGallery  = false
    @State private var showTourBooking  = false
    @State private var showReport       = false
    @State private var showAffiliationRequest = false
    @State private var showCompareSheet  = false   // Phase F — ComparisonView
    @StateObject private var compareManager = CompareManager.shared
    // Phase G — property-level reviews aggregated from tour feedback
    @State private var reviews: [ListingReview] = []
    @State private var reviewsAverage: Double? = nil
    @State private var reviewsCount: Int = 0
    @State private var affiliationMessage = ""
    @State private var affiliationSubmitting = false
    @State private var affiliationResult: String?

    // Mortgage calculator state
    @State private var mcDownPercent: Double = 30
    @State private var mcRate:        Double = 12
    @State private var mcTermYears:   Int    = 20

    // Collapsible description
    @State private var descriptionExpanded = false

    // Scroll offset for fading the hero overlay bar as user scrolls past
    @State private var scrollOffset: CGFloat = 0

    /// Opacity of the floating overlay bar. Full alpha while the hero image
    /// is visible, fades to 0 as the user scrolls past it so the overlay
    /// doesn't hang over the body content.
    private var heroOverlayOpacity: Double {
        // scrollOffset is 0 at rest, becomes more negative as user scrolls down.
        let scrolled = max(0, -scrollOffset)
        let fadeStart: CGFloat = heroHeight * 0.35   // start fading a bit before end of hero
        let fadeEnd:   CGFloat = heroHeight * 0.65   // fully hidden once past the hero
        if scrolled <= fadeStart { return 1 }
        if scrolled >= fadeEnd   { return 0 }
        let t = (scrolled - fadeStart) / (fadeEnd - fadeStart)
        return Double(1 - t)
    }

    private let heroHeight: CGFloat = UIScreen.main.bounds.height * 0.55

    /// Check if the current logged-in user owns this listing
    private func isMyListing(_ l: Listing) -> Bool {
        guard let me = APIService.shared.currentUser else { return false }
        let myEmail = me.email.lowercased()
        // Check if any agency on the listing has my email
        if let agencies = l.agencies {
            for a in agencies {
                if let email = a.email?.lowercased(), email == myEmail { return true }
                if let uid = a.userId, uid == me.id { return true }
            }
        }
        return false
    }

    var body: some View {
        Group {
            if loading {
                ProgressView("Cargando...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let l = listing {
                detailBody(l)
            } else {
                ContentUnavailableView("No encontrado", systemImage: "house.slash")
            }
        }
        .navigationBarHidden(true)
        .sheet(isPresented: $showApply) {
            if let l = listing { LeadApplicationView(listing: l) }
        }
        .sheet(isPresented: $showContactAgent) {
            if let l = listing {
                ContactAgentSheet(listing: l).environmentObject(APIService.shared)
            }
        }
        .fullScreenCover(isPresented: $showFullGallery) {
            if let l = listing { FullGalleryView(images: l.allImageURLs, startIndex: imageIndex) }
        }
        .sheet(isPresented: $showTourBooking) {
            if let l = listing, let brokerId = l.agencies?.first(where: { $0.userId != nil })?.userId {
                TourBookingSheet(listing: l, brokerId: brokerId)
                    .environmentObject(APIService.shared)
            }
        }
        .sheet(isPresented: $showReport) {
            if let l = listing {
                ReportView(reportType: .listing, targetId: l.id, targetName: l.title)
                    .environmentObject(APIService.shared)
            }
        }
        .sheet(isPresented: $showCompareSheet) {
            // Phase F — opens the side-by-side comparison from the
            // listing detail's kebab when 2+ listings are queued.
            ComparisonView(selectedIds: $compareManager.selectedIds)
        }
        .sheet(isPresented: $showAffiliationRequest) {
            NavigationStack {
                Form {
                    Section {
                        Text(listing?.title ?? "")
                            .font(.subheadline.bold())
                        Text("La inmobiliaria/dueño revisará tu solicitud y, si la aprueba, te incluirá como agente de esta propiedad. Eso te permite credit las consultas con tu enlace de referido.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Section("Mensaje (opcional)") {
                        TextField("Cuéntales por qué quieres afiliarte…", text: $affiliationMessage, axis: .vertical)
                            .lineLimit(3...8)
                    }
                    if let result = affiliationResult {
                        Section {
                            Label(result, systemImage: result.contains("enviada") ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(result.contains("enviada") ? .green : .red)
                                .font(.callout)
                        }
                    }
                }
                .navigationTitle("Solicitar afiliación")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancelar") { showAffiliationRequest = false; affiliationResult = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Enviar") { Task { await submitAffiliationRequest() } }
                            .disabled(affiliationSubmitting || listing == nil)
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            await load()
            // Defer tracking to background — don't compete with data loading.
            // The track methods touch APIService.shared (main-actor isolated),
            // so the calls must hop back to the main actor — hence `await`.
            Task.detached(priority: .utility) { [id] in
                await APIService.shared.trackListingView(id)
                await APIService.shared.trackRecentlyViewed(id)
            }
        }
    }

    // MARK: - Detail Body

    @ViewBuilder
    private func detailBody(_ l: Listing) -> some View {
        ZStack(alignment: .top) {
            // Page background — adapts to dark/light. The hero image still
            // covers the top portion; this bg only shows once you scroll past.
            LD.bg.ignoresSafeArea()

            // Main scroll with images INSIDE (not behind)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Scroll-offset probe so the floating overlay bar can fade.
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: ScrollOffsetKey.self,
                            value: geo.frame(in: .named("listingScroll")).minY
                        )
                    }
                    .frame(height: 0)

                    // Hero gallery — horizontal swipes via TabView page style
                    heroImages(l)

                    // Body card lifts up over the hero with rounded top
                    // corners (22pt), then fills with editorial dark/light surface
                    VStack(alignment: .leading, spacing: 22) {

                        // Thumbnail strip (skipped if no extra images)
                        thumbsStrip(l)

                        // Status pill row (En venta / type)
                        statusRow(l)

                        // Big price headline + Est. /mes
                        priceHeadline(l)

                        // Address row with pin icon
                        addressRow(l)

                        // Quick stats pill row
                        quickStatsBar(l)

                        // 2x2 meta cards (Tipo / Año / Parqueos / Solar)
                        metaGrid(l)

                        // Description with inline "Leer más"
                        if let desc = l.description, !desc.isEmpty {
                            descriptionSection(desc)
                        }

                        // Amenities — soft tray with chip grid
                        if !l.amenities.isEmpty {
                            amenitiesSection(l.amenities)
                        }

                        // ── Specs grid (extras only — terreno, pisos, entrega) ──
                        specsSection(l)

                        // ── Project Meta (proyecto only) ───────────
                        if l.type == "proyecto" { projectMetaSection(l) }

                        // ── Unit Types ─────────────────────────────
                        if let units = l.unit_types, !units.isEmpty {
                            unitTypesSection(units)
                        }

                        // ── Live Inventory ─────────────────────────
                        if let inv = l.unitInventory, !inv.isEmpty {
                            liveInventorySection(inv)
                        }

                        // ── Blueprints ─────────────────────────────
                        if let bps = l.blueprints, !bps.isEmpty {
                            blueprintsSection(bps, l: l)
                        }

                        // ── Mortgage Calculator ────────────────────
                        if let priceNum = Double(l.price), priceNum > 0 {
                            mortgageCalculatorSection(price: priceNum)
                        }

                        // ── Construction Company ───────────────────
                        if let builder = l.construction_company {
                            builderSection(builder)
                        }

                        // ── Reseñas (Phase G) ──────────────────────
                        // Aggregated tour-feedback ratings + comments.
                        // Hidden until at least one tour has feedback;
                        // empty state would just be visual noise.
                        if reviewsCount > 0 {
                            reviewsSection
                        }

                        // ── Map ────────────────────────────────────
                        if let lat = l.lat, let lng = l.lng {
                            mapSection(lat: lat, lng: lng, title: l.title, address: l.address)
                        }

                        // ── Agents (last block, per design) ────────
                        if let agencies = l.agencies, !agencies.isEmpty {
                            agencySection(agencies, listing: l)
                        }

                        // Bottom clearance for the sticky CTA. The gradient
                        // is 130pt tall and now extends through the home
                        // indicator (~34pt safe area) for a real visual
                        // height of ~164pt. Add ~40pt of breath so even
                        // the page's last content row sits clear of the
                        // 22pt soft-fade at the top of the CTA backdrop.
                        Color.clear.frame(height: 210)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, 24)
                    .background(
                        UnevenRoundedRectangle(
                            cornerRadii: .init(topLeading: 22, bottomLeading: 0, bottomTrailing: 0, topTrailing: 22),
                            style: .continuous
                        )
                        .fill(LD.bg)
                    )
                    .offset(y: -22) // lift the body over the hero
                }
            }
            .coordinateSpace(name: "listingScroll")
            .onPreferenceChange(ScrollOffsetKey.self) { value in
                scrollOffset = value
            }

            // Floating top bar (back, heart, share, more)
            heroOverlayBar(l)
                .opacity(heroOverlayOpacity)
                .allowsHitTesting(heroOverlayOpacity > 0.2)

            // Sticky CTA at the bottom. The wrapping VStack must
            // ignore the bottom safe area so the gradient inside
            // stickyCTA can truly extend through the home-indicator
            // zone — otherwise scroll content scrolling into the
            // home-indicator area peeks out below the buttons.
            if listing != nil {
                VStack(spacing: 0) {
                    Spacer()
                    stickyCTA(l)
                }
                .ignoresSafeArea(edges: .bottom)
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    // MARK: - Hero Images

    /// Horizontal swipeable image gallery — tap to open full-screen.
    /// Uses TabView with page style for smooth horizontal swiping
    /// without conflicting with the main vertical ScrollView.
    @ViewBuilder
    private func heroImages(_ l: Listing) -> some View {
        ZStack(alignment: .bottom) {
            Group {
                if !l.images.isEmpty {
                    TabView(selection: $imageIndex) {
                        ForEach(Array(l.images.enumerated()), id: \.offset) { i, img in
                            let url: URL? = img.hasPrefix("http") ? URL(string: img) : URL(string: APIService.baseURL + img)
                            ZStack {
                                Color(red: 0x2a/255, green: 0x2f/255, blue: 0x3a/255)
                                CachedAsyncImage(url: url) { phase in
                                    switch phase {
                                    case .success(let image):
                                        image
                                            .resizable()
                                            .scaledToFill()
                                    default:
                                        Image(systemName: "photo")
                                            .font(.system(size: 36))
                                            .foregroundStyle(.white.opacity(0.4))
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .clipped()
                            .contentShape(Rectangle())
                            .onTapGesture {
                                imageIndex = i
                                showFullGallery = true
                            }
                            .tag(i)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                } else {
                    Rectangle()
                        .fill(Color(red: 0x2a/255, green: 0x2f/255, blue: 0x3a/255))
                        .overlay(
                            Image(systemName: "house.fill")
                                .font(.system(size: 50))
                                .foregroundStyle(.white.opacity(0.35))
                        )
                }
            }

            // Top → bottom gradient that fades into the body bg color
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.45), location: 0.00),
                    .init(color: .black.opacity(0.00), location: 0.28),
                    .init(color: .black.opacity(0.15), location: 0.60),
                    .init(color: LD.bg.opacity(0.85),  location: 0.88),
                    .init(color: LD.bg,                location: 1.00),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .allowsHitTesting(false)

            // Hero bottom: 3D-tour play button (left) + photo counter (right)
            heroBottomBar(l)
        }
        .frame(height: heroHeight)
        .clipped()
    }

    // MARK: - Hero Bottom Bar

    @ViewBuilder
    private func heroBottomBar(_ l: Listing) -> some View {
        HStack {
            // Future: 3D tour entrypoint — for now opens full gallery as a placeholder
            Button {
                showFullGallery = true
            } label: {
                Image(systemName: "play.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(.ultraThinMaterial.opacity(0.6), in: Circle())
                    .overlay(
                        Circle().strokeBorder(.white.opacity(0.22), lineWidth: 0.5)
                    )
                    .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
            }

            Spacer()

            // Photo counter
            if !l.images.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.system(size: 11, weight: .semibold))
                    Text("\(imageIndex + 1) / \(l.images.count)")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .frame(height: 36)
                .background(.ultraThinMaterial.opacity(0.65), in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
                .lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 18)
    }

    // MARK: - Hero Overlay Bar (top floating: back + heart + share + more)

    @ViewBuilder
    private func heroOverlayBar(_ l: Listing) -> some View {
        HStack {
            glassButton(systemImage: "chevron.left") { dismiss() }

            Spacer()

            HStack(spacing: 8) {
                // Save / heart — flips to a solid white pill with red heart when saved
                Button { saved.toggle(l.id) } label: {
                    Image(systemName: saved.isSaved(l.id) ? "heart.fill" : "heart")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(saved.isSaved(l.id) ? LD.red : .white)
                        .frame(width: 42, height: 42)
                        .background(
                            saved.isSaved(l.id)
                                ? AnyShapeStyle(.white.opacity(0.92))
                                : AnyShapeStyle(.ultraThinMaterial.opacity(0.55))
                        )
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                }

                glassButton(systemImage: "square.and.arrow.up") { shareListing(l) }

                // Top-right menu — Comparar (Phase F) + Reportar always;
                // "Solicitar afiliación" when the current user is a pro
                // who is NOT already on the listing's agencies[] (server
                // enforces the same predicate).
                Menu {
                    Button {
                        _ = compareManager.toggle(l.id)
                    } label: {
                        Label(
                            compareManager.isSelected(l.id)
                                ? "Quitar de comparación"
                                : "Añadir a comparación",
                            systemImage: compareManager.isSelected(l.id)
                                ? "checkmark.square.fill"
                                : "square.split.2x1"
                        )
                    }
                    // Surface a "Ver comparación (N)" entry whenever
                    // 2+ listings are queued — saves the user a hop to
                    // the Explorar tab to launch the comparison.
                    if compareManager.selectedIds.count >= 2 {
                        Button {
                            showCompareSheet = true
                        } label: {
                            Label("Ver comparación (\(compareManager.selectedIds.count))",
                                  systemImage: "square.split.2x1.fill")
                        }
                    }
                    if shouldShowAffiliationRequest(l) {
                        Button {
                            affiliationMessage = ""
                            showAffiliationRequest = true
                        } label: {
                            Label("Solicitar afiliación", systemImage: "person.crop.rectangle.stack.fill")
                        }
                    }
                    Button {
                        showReport = true
                    } label: {
                        Label("Reportar", systemImage: "exclamationmark.bubble")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 42, height: 42)
                        .background(.ultraThinMaterial.opacity(0.55), in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 56)
    }

    /// Submits POST /api/listings/:id/request-affiliation. Server
    /// notifies the listing owner; the result is purely cosmetic on
    /// our end (the user has to wait for owner approval).
    private func submitAffiliationRequest() async {
        guard let l = listing else { return }
        affiliationSubmitting = true
        affiliationResult = nil
        defer { affiliationSubmitting = false }
        do {
            let msg = affiliationMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await APIService.shared.requestListingAffiliation(
                id: l.id,
                message: msg.isEmpty ? nil : msg
            )
            await MainActor.run {
                affiliationResult = "Solicitud enviada — esperando aprobación del dueño."
                affiliationMessage = ""
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run {
                showAffiliationRequest = false
                affiliationResult = nil
            }
        } catch {
            affiliationResult = (error as? LocalizedError)?.errorDescription ?? "No se pudo enviar la solicitud."
        }
    }

    /// Show "Solicitar afiliación" only to pros who don't already
    /// appear in the listing's agencies (by user_id or email match).
    /// Owners and clients see only "Reportar".
    private func shouldShowAffiliationRequest(_ l: Listing) -> Bool {
        guard let me = APIService.shared.currentUser else { return false }
        let proRoles: Set<String> = ["broker", "agency", "inmobiliaria", "constructora"]
        guard proRoles.contains(me.role) else { return false }
        if isMyListing(l) { return false }
        // If the user is already on this listing, hide the action.
        let alreadyOn = (l.agencies ?? []).contains { agency in
            if let uid = agency.userId, uid == me.id { return true }
            if !me.email.isEmpty,
               let aem = agency.email,
               aem.lowercased() == me.email.lowercased() { return true }
            return false
        }
        return !alreadyOn
    }

    /// Translucent round button used in the hero overlay.
    @ViewBuilder
    private func glassButton(systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(.ultraThinMaterial.opacity(0.55), in: Circle())
                .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
        }
    }

    // MARK: - Quick Stats — outlined pill row + expand button

    @ViewBuilder
    private func quickStatsBar(_ l: Listing) -> some View {
        HStack(spacing: 8) {
            if let b = l.bedrooms, !b.isEmpty {
                statPill(systemImage: "bed.double", text: "\(b) Hab.")
            }
            if let b = l.bathrooms, !b.isEmpty {
                statPill(systemImage: "shower", text: "\(b) Baños")
            }
            if let a = l.area_const, !a.isEmpty {
                statPill(systemImage: "ruler", text: "\(a) m²")
            }
            // Expand button — opens the full gallery as a fullscreen tour
            Button {
                showFullGallery = true
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 40, height: 40)
                    .overlay(Circle().strokeBorder(LD.line, lineWidth: 1))
            }
        }
    }

    private func statPill(systemImage: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(LD.textSoft)
            Text(text)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity, minHeight: 40)
        .overlay(Capsule().strokeBorder(LD.line, lineWidth: 1))
    }

    // MARK: - Sticky CTA dock

    @ViewBuilder
    private func stickyCTA(_ l: Listing) -> some View {
        let hasBroker = l.agencies?.first(where: { $0.userId != nil }) != nil
        let isOwner = isMyListing(l)

        ZStack(alignment: .bottom) {
            // Backdrop — a tiny top-fade (so the bar doesn't have a
            // hard horizontal line) followed by a solid page-bg slab
            // that extends THROUGH the home-indicator safe area so
            // scroll content can't peek out below the buttons.
            // Earlier versions stopped at the safe-area top, leaving
            // a sliver of meta-grid chips visible underneath.
            VStack(spacing: 0) {
                LinearGradient(
                    colors: [LD.bg.opacity(0.0), LD.bg.opacity(1.0)],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: 22)
                Rectangle().fill(LD.bg)
            }
            .frame(height: 130)
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)

            HStack(spacing: 10) {
                if isOwner {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(LD.green)
                        Text("Tu propiedad")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(LD.green)
                    }
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .background(LD.green.opacity(0.10), in: Capsule())
                    .overlay(Capsule().strokeBorder(LD.green.opacity(0.25), lineWidth: 1))
                } else {
                    Button {
                        showContactAgent = true
                    } label: {
                        Text("Consultar")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, minHeight: 54)
                            .background(LD.chipBg, in: Capsule())
                            .overlay(Capsule().strokeBorder(LD.line, lineWidth: 1))
                    }

                    Button {
                        if hasBroker { showTourBooking = true }
                        else { showApply = true }
                    } label: {
                        Text(hasBroker ? "Agendar visita" : "Aplicar")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(LD.primaryCTAFg)
                            .frame(maxWidth: .infinity, minHeight: 54)
                            .background(LD.primaryCTABg, in: Capsule())
                            .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 26)
        }
    }

    // MARK: - Thumbnail strip (3-up under hero)

    @ViewBuilder
    private func thumbsStrip(_ l: Listing) -> some View {
        let urls = l.allImageURLs
        if urls.count >= 2 {
            // Show next 3 images after the hero (first one is the big hero up top)
            let pool = Array(urls.dropFirst().prefix(3))
            let extra = max(0, urls.count - 4)
            HStack(spacing: 8) {
                ForEach(Array(pool.enumerated()), id: \.offset) { i, url in
                    let isLast = (i == pool.count - 1) && extra > 0
                    Button {
                        imageIndex = i + 1
                        showFullGallery = true
                    } label: {
                        ZStack {
                            CachedAsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let img):
                                    img.resizable().scaledToFill()
                                default:
                                    LD.surfaceDeep
                                }
                            }
                            if isLast {
                                ZStack {
                                    Color.black.opacity(0.55)
                                    Text("+\(extra)")
                                        .font(.system(size: 16, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .aspectRatio(4.0/3.0, contentMode: .fit)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                }
            }
        }
    }

    // MARK: - Status row (En venta + optional condition badge)

    @ViewBuilder
    private func statusRow(_ l: Listing) -> some View {
        let dotColor: Color = {
            switch l.type {
            case "venta":    return LD.green
            case "alquiler": return LD.brand
            case "proyecto": return LD.amber
            default:         return LD.green
            }
        }()
        HStack {
            HStack(spacing: 8) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 7, height: 7)
                    .overlay(Circle().fill(dotColor.opacity(0.18)).frame(width: 13, height: 13))
                Text(l.typeLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 12)
            .frame(height: 30)
            .overlay(Capsule().strokeBorder(LD.line, lineWidth: 1))

            Spacer()

            if let stage = l.project_stage, !stage.isEmpty {
                Text(stage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(LD.brand)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .overlay(Capsule().strokeBorder(LD.brand.opacity(0.4), lineWidth: 1))
            } else if let cond = l.condition, !cond.isEmpty {
                Text(cond)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(LD.textSoft)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .overlay(Capsule().strokeBorder(LD.line, lineWidth: 1))
            }
        }
    }

    // MARK: - Price headline

    @ViewBuilder
    private func priceHeadline(_ l: Listing) -> some View {
        // Inline mortgage estimate using current calculator defaults — keeps
        // the headline in sync with the calc widget below if user adjusts.
        let monthlyEst: Double? = {
            guard let p = Double(l.price), p > 0 else { return nil }
            let down = p * mcDownPercent / 100
            let loan = p - down
            let r = mcRate / 100 / 12
            let n = Double(mcTermYears * 12)
            guard r > 0, n > 0, loan > 0 else { return nil }
            let factor = pow(1 + r, n)
            guard factor > 1 else { return nil }
            return loan * (r * factor) / (factor - 1)
        }()

        // Decompose priceFormatted into currency prefix + number for the
        // small/large split styling shown in the design (US$ small + amount big).
        let formatted = l.priceFormatted // e.g. "$475,000"
        let amount = formatted.drop(while: { !$0.isNumber }).prefix(while: { $0.isNumber || $0 == "," || $0 == "." })

        HStack(alignment: .lastTextBaseline, spacing: 12) {
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text("US$")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(LD.textMute)
                    .baselineOffset(2)
                Text(amount.isEmpty ? formatted : String(amount))
                    .font(.system(size: 36, weight: .bold))
                    .kerning(-0.5)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }

            if let m = monthlyEst {
                (Text("Est. ")
                    .foregroundStyle(LD.textMute)
                 + Text(formatCurrency(m))
                    .foregroundStyle(LD.textSoft).fontWeight(.semibold)
                 + Text("/mes")
                    .foregroundStyle(LD.textMute))
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }

            Spacer(minLength: 0)
        }
    }

    // MARK: - Address row

    @ViewBuilder
    private func addressRow(_ l: Listing) -> some View {
        // Compose the address from the most specific identifier we have,
        // then append parts that AREN'T already present in it. The DB
        // sometimes stores the full chain in `address` (e.g. "mega
        // centro, Santo Domingo Este, Santo Domingo") AND in the
        // sector/city/province columns — so naïvely concatenating
        // produces "mega centro, Santo Domingo Este, Santo Domingo,
        // mega centro, Santo Domingo Este, Santo Domingo".
        let parts = [l.sector, l.city, l.province]
            .compactMap { ($0?.isEmpty == false) ? $0 : nil }

        let line: String? = {
            if let addr = l.address, !addr.isEmpty {
                let lc = addr.lowercased()
                let extras = parts.filter { !lc.contains($0.lowercased()) }
                return extras.isEmpty ? addr : (addr + ", " + extras.joined(separator: ", "))
            }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }()

        if let line {
            HStack(spacing: 8) {
                Image(systemName: "mappin.and.ellipse")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(LD.textMute)
                Text(line)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(LD.textSoft)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: - Meta grid (Tipo / Año / Parqueos / Solar)

    private struct MetaItem {
        let icon: String
        let label: String
        let value: String
    }

    /// Collect the available meta values for the 2-col grid, trimmed to an
    /// even count so the layout stays balanced.
    private func metaItems(_ l: Listing) -> [MetaItem] {
        var items: [MetaItem] = []
        items.append(.init(icon: "house", label: "Tipo", value: l.typeLabel))
        if let f = l.floors {
            items.append(.init(icon: "building.2", label: "Pisos", value: "\(f)"))
        }
        if let p = l.parking, !p.isEmpty {
            items.append(.init(icon: "car", label: "Parqueos", value: p))
        }
        if let a = l.area_land, !a.isEmpty {
            items.append(.init(icon: "leaf", label: "Solar", value: "\(a) m²"))
        }
        if let d = l.delivery_date, !d.isEmpty {
            items.append(.init(icon: "calendar", label: "Entrega", value: d))
        }
        return items.count > 1
            ? Array(items.prefix((items.count / 2) * 2))
            : items
    }

    @ViewBuilder
    private func metaGrid(_ l: Listing) -> some View {
        let items = metaItems(l)
        if !items.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, m in
                    metaCard(icon: m.icon, label: m.label, value: m.value)
                }
            }
        }
    }

    @ViewBuilder
    private func metaCard(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(LD.textSoft)
                .frame(width: 36, height: 36)
                .overlay(Circle().strokeBorder(LD.line, lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(LD.textMute)
                Text(value)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .frame(height: 78)
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(LD.line, lineWidth: 1))
    }

    // MARK: - Description section

    @ViewBuilder
    private func descriptionSection(_ desc: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Descripción")
            VStack(alignment: .leading, spacing: 8) {
                Text(desc)
                    .font(.system(size: 14.5))
                    .foregroundStyle(LD.textSoft)
                    .lineSpacing(2.5)
                    .lineLimit(descriptionExpanded ? nil : 4)
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) { descriptionExpanded.toggle() }
                } label: {
                    Text(descriptionExpanded ? "Leer menos" : "Leer más")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(LD.brand)
                }
            }
        }
    }

    // MARK: - Amenities (soft tray with chip grid)

    @ViewBuilder
    private func amenitiesSection(_ amenities: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Amenidades", trailing: amenities.count > 6 ? "Ver todas" : nil)
            let visible = Array(amenities.prefix(6))
            VStack {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(visible, id: \.self) { a in
                        Text(a)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, minHeight: 42)
                            .background(LD.chipBg, in: Capsule())
                            .overlay(Capsule().strokeBorder(LD.line, lineWidth: 1))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    }
                }
            }
            .padding(14)
            .background(LD.trayBg, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(LD.lineSoft, lineWidth: 1))
        }
    }

    // MARK: - Live inventory section (extracted for the new layout)

    @ViewBuilder
    private func liveInventorySection(_ inv: [UnitInventoryItem]) -> some View {
        let availableUnits = Array(inv.filter { $0.status == "available" }.prefix(6))
        let totalAvailable = inv.filter { $0.status == "available" }.count

        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Disponibilidad en Tiempo Real")
            InventoryBadgeView(units: inv)
            VStack(spacing: 6) {
                ForEach(availableUnits) { unit in
                    HStack(spacing: 8) {
                        Circle().fill(LD.green).frame(width: 8, height: 8)
                        Text(unit.label).font(.caption).bold()
                        if let type = unit.type, !type.isEmpty {
                            Text(type)
                                .font(.caption2)
                                .foregroundStyle(LD.textMute)
                        }
                        Spacer()
                        Text("Disponible")
                            .font(.caption2)
                            .foregroundStyle(LD.green)
                    }
                }
                if totalAvailable > 6 {
                    Text("+ \(totalAvailable - 6) unidades más disponibles")
                        .font(.caption2)
                        .foregroundStyle(LD.textMute)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 4)
                }
            }
            .padding(12)
            .background(LD.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(LD.lineSoft, lineWidth: 1))
        }
    }

    // MARK: - Section header (h3 + optional trailing accessory)

    @ViewBuilder
    private func sectionHeader(_ title: String, trailing: String? = nil) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .kerning(-0.2)
                .foregroundStyle(.primary)
            Spacer()
            if let t = trailing {
                Text(t)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(LD.brand)
            }
        }
    }

    // MARK: - Specs

    @ViewBuilder
    private func specsSection(_ l: Listing) -> some View {
        // NOTE: Habitaciones, Baños, Parqueo and Área Const. are shown in
        // the quickStatsBar above — don't duplicate them here. Only render
        // the extra specs that aren't in the quick stats row.
        let hasExtraSpecs =
            (l.area_land?.isEmpty == false) ||
            l.floors != nil ||
            (l.delivery_date?.isEmpty == false)

        if hasExtraSpecs {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                if let a = l.area_land,    a != "" { SpecCard(icon: "leaf.fill",       label: "Terreno", value: "\(a) m²") }
                if let f = l.floors               { SpecCard(icon: "building.2.fill", label: "Pisos",   value: "\(f)") }
                if let d = l.delivery_date, d != "" { SpecCard(icon: "calendar",      label: "Entrega", value: d) }
            }
        }
    }

    // MARK: - Project Meta

    @ViewBuilder
    private func projectMetaSection(_ l: Listing) -> some View {
        if l.units_available != nil || l.project_stage != nil {
            VStack(alignment: .leading, spacing: 14) {
                Text("Información del Proyecto").font(.headline)

                // Units availability card
                if let avail = l.units_available, let total = l.units_total, total > 0 {
                    VStack(spacing: 12) {
                        HStack(spacing: 16) {
                            // Available count
                            VStack(spacing: 4) {
                                Text("\(avail)")
                                    .font(.system(size: 28, weight: .bold))
                                    .foregroundStyle(Color.rdGreen)
                                Text("Disponibles")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)

                            // Divider
                            Rectangle()
                                .fill(Color(.systemGray4))
                                .frame(width: 1, height: 40)

                            // Total count
                            VStack(spacing: 4) {
                                Text("\(total)")
                                    .font(.system(size: 28, weight: .bold))
                                    .foregroundStyle(.primary)
                                Text("Total")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)

                            // Divider
                            Rectangle()
                                .fill(Color(.systemGray4))
                                .frame(width: 1, height: 40)

                            // Sold/reserved
                            VStack(spacing: 4) {
                                Text("\(total - avail)")
                                    .font(.system(size: 28, weight: .bold))
                                    .foregroundStyle(Color.rdRed)
                                Text("Vendidas")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                        }

                        // Progress bar
                        VStack(spacing: 4) {
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 5)
                                        .fill(Color(.systemGray5))
                                        .frame(height: 10)
                                    RoundedRectangle(cornerRadius: 5)
                                        .fill(
                                            LinearGradient(
                                                colors: [Color.rdGreen, Color.rdGreen.opacity(0.7)],
                                                startPoint: .leading, endPoint: .trailing
                                            )
                                        )
                                        .frame(
                                            width: geo.size.width * CGFloat(avail) / CGFloat(total),
                                            height: 10
                                        )
                                }
                            }
                            .frame(height: 10)

                            HStack {
                                Text("\(Int(Double(avail) / Double(total) * 100))% disponible")
                                    .font(.caption2).foregroundStyle(.secondary)
                                Spacer()
                                if avail <= 5 && avail > 0 {
                                    Text("Pocas unidades restantes")
                                        .font(.caption2).bold()
                                        .foregroundStyle(Color.rdRed)
                                }
                            }
                        }
                    }
                    .padding(14)
                    .background(Color.rdGreen.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.rdGreen.opacity(0.15), lineWidth: 1))
                }

                // Stage + delivery
                if l.project_stage != nil || l.delivery_date != nil {
                    HStack(spacing: 12) {
                        if let stage = l.project_stage, !stage.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "hammer.fill")
                                    .font(.caption).foregroundStyle(Color.rdBlue)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text("Etapa").font(.system(size: 10)).foregroundStyle(.secondary)
                                    Text(stage).font(.caption).bold()
                                }
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Color.rdBlue.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        if let date = l.delivery_date, !date.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "calendar")
                                    .font(.caption).foregroundStyle(Color.rdBlue)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text("Entrega").font(.system(size: 10)).foregroundStyle(.secondary)
                                    Text(date).font(.caption).bold()
                                }
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Color.rdBlue.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        Spacer()
                    }
                }
            }
        }
    }

    // MARK: - Mortgage Calculator

    @ViewBuilder
    private func mortgageCalculatorSection(price: Double) -> some View {
        let downAmount = price * mcDownPercent / 100
        let loanAmount = price - downAmount
        let monthlyRate = mcRate / 100 / 12
        let totalPayments = Double(mcTermYears * 12)
        let monthly: Double = {
            guard monthlyRate > 0, totalPayments > 0, loanAmount > 0 else { return 0 }
            let factor = pow(1 + monthlyRate, totalPayments)
            guard factor > 1 else { return loanAmount / totalPayments } // avoid division by zero
            return loanAmount * (monthlyRate * factor) / (factor - 1)
        }()

        sectionBlock("Calculadora Hipotecaria") {
            VStack(spacing: 16) {
                // Result card
                VStack(spacing: 6) {
                    Text("Pago mensual estimado")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(formatCurrency(monthly) + "/mes")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundStyle(Color.rdBlue)
                    HStack(spacing: 24) {
                        VStack(spacing: 2) {
                            Text("Inicial")
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(formatCurrency(downAmount))
                                .font(.caption).bold()
                        }
                        VStack(spacing: 2) {
                            Text("Financiado")
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(formatCurrency(loanAmount))
                                .font(.caption).bold()
                        }
                    }
                    .padding(.top, 4)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color.rdBlue.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 14))

                // Input controls
                VStack(spacing: 14) {
                    // Down payment slider
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Inicial")
                                .font(.caption).bold().foregroundStyle(.secondary)
                            Spacer()
                            Text("\(Int(mcDownPercent))%")
                                .font(.caption).bold()
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(Color.rdBlue.opacity(0.1))
                                .clipShape(Capsule())
                        }
                        Slider(value: $mcDownPercent, in: 0...80, step: 5)
                            .tint(Color.rdBlue)
                    }

                    // Interest rate slider
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Tasa de interés")
                                .font(.caption).bold().foregroundStyle(.secondary)
                            Spacer()
                            Text(String(format: "%.1f%%", mcRate))
                                .font(.caption).bold()
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(Color.rdBlue.opacity(0.1))
                                .clipShape(Capsule())
                        }
                        Slider(value: $mcRate, in: 3...20, step: 0.5)
                            .tint(Color.rdBlue)
                    }

                    // Term picker
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Plazo")
                            .font(.caption).bold().foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            ForEach([10, 15, 20, 25, 30], id: \.self) { years in
                                Button {
                                    mcTermYears = years
                                } label: {
                                    Text("\(years)a")
                                        .font(.caption).bold()
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .frame(maxWidth: .infinity)
                                        .background(mcTermYears == years ? Color.rdBlue : Color(.systemGray6))
                                        .foregroundStyle(mcTermYears == years ? .white : .primary)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                }

                Text("* Cálculo estimado. Tasas típicas en RD: 10-14% (RD$) o 7-9% (USD). Consulte su banco para tasas actuales.")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "$\(Int(value))"
    }

    // MARK: - Unit Types

    @ViewBuilder
    private func unitTypesSection(_ units: [ListingUnit]) -> some View {
        sectionBlock("Tipos de Unidades") {
            VStack(spacing: 14) {
                ForEach(Array(units.enumerated()), id: \.offset) { _, u in
                    VStack(alignment: .leading, spacing: 12) {
                        // Header: name + availability badge
                        HStack {
                            Text(u.name ?? u.bedroomLabel)
                                .font(.subheadline).bold()
                            Spacer()
                            if let avail = u.available, let total = u.total {
                                Text("\(avail) de \(total) disponibles")
                                    .font(.caption2).bold()
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(avail > 0 ? Color.rdGreen.opacity(0.12) : Color.rdRed.opacity(0.12))
                                    .foregroundStyle(avail > 0 ? Color.rdGreen : Color.rdRed)
                                    .clipShape(Capsule())
                            }
                        }

                        // Specs row
                        HStack(spacing: 14) {
                            if let area = u.area, !area.isEmpty {
                                Label("\(area) m²", systemImage: "square.split.2x2")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if u.bedrooms != nil {
                                Label(u.bedroomLabel, systemImage: "bed.double.fill")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let baths = u.bathrooms, !baths.isEmpty {
                                Label("\(baths) baños", systemImage: "shower.fill")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let park = u.parking, !park.isEmpty {
                                Label("\(park) parq.", systemImage: "car.fill")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }

                        // Price
                        if let price = u.priceFormatted {
                            Text(price)
                                .font(.headline).bold()
                                .foregroundStyle(Color.rdBlue)
                        }

                        // Availability progress bar
                        if let avail = u.available, let total = u.total, total > 0 {
                            VStack(spacing: 4) {
                                GeometryReader { geo in
                                    ZStack(alignment: .leading) {
                                        RoundedRectangle(cornerRadius: 4)
                                            .fill(Color(.systemGray5))
                                            .frame(height: 6)
                                        RoundedRectangle(cornerRadius: 4)
                                            .fill(avail > 0 ? Color.rdGreen : Color.rdRed)
                                            .frame(
                                                width: geo.size.width * CGFloat(avail) / CGFloat(total),
                                                height: 6
                                            )
                                    }
                                }
                                .frame(height: 6)
                                HStack {
                                    Text("\(Int(Double(avail) / Double(total) * 100))% disponible")
                                        .font(.system(size: 10)).foregroundStyle(.secondary)
                                    Spacer()
                                }
                            }
                        }
                    }
                    .padding(14)
                    .background(Color.rdBlue.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.rdBlue.opacity(0.1), lineWidth: 1))
                }
            }
        }
    }

    // MARK: - Blueprints

    @ViewBuilder
    private func blueprintsSection(_ bps: [String], l: Listing) -> some View {
        sectionBlock("Planos de la Propiedad") {
            VStack(spacing: 8) {
                TabView(selection: $blueprintIndex) {
                    ForEach(Array(bps.enumerated()), id: \.offset) { i, bp in
                        let url: URL? = bp.hasPrefix("http") ? URL(string: bp) : URL(string: APIService.baseURL + bp)
                        CachedAsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().scaledToFit()
                            default:
                                Rectangle().fill(Color(.systemGray6))
                                    .overlay(Image(systemName: "doc.viewfinder").font(.largeTitle).foregroundStyle(.secondary))
                            }
                        }
                        .frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 10)).tag(i)
                    }
                }
                .tabViewStyle(.page)
                .frame(height: 220)

                if bps.count > 1 {
                    HStack(spacing: 5) {
                        ForEach(0..<bps.count, id: \.self) { i in
                            Circle()
                                .fill(i == blueprintIndex ? Color.rdBlue : Color(.systemGray4))
                                .frame(width: i == blueprintIndex ? 7 : 4, height: i == blueprintIndex ? 7 : 4)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Construction Company

    @ViewBuilder
    private func builderSection(_ b: ConstructionCompany) -> some View {
        sectionBlock("Empresa Constructora") {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 48, height: 48)
                        Image(systemName: "hammer.fill").foregroundStyle(Color.rdBlue)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.name ?? "").font(.subheadline).bold()
                        if let desc = b.description, !desc.isEmpty {
                            Text(desc).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }

                HStack(spacing: 0) {
                    if let y = b.years_experience {
                        builderStat(value: "\(y)+", label: "Años exp.")
                        Divider().frame(height: 36)
                    }
                    if let p = b.projects_completed {
                        builderStat(value: "\(p)", label: "Proyectos")
                        Divider().frame(height: 36)
                    }
                    if let u = b.units_delivered {
                        builderStat(value: "\(u)", label: "Unidades")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(12)
                .background(Color.rdBlue.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private func builderStat(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3).bold().foregroundStyle(Color.rdBlue)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Map preview (with floating area tag)

    @ViewBuilder
    private func mapSection(lat: Double, lng: Double, title: String, address: String?) -> some View {
        let parts = [listing?.sector, listing?.city, listing?.province]
            .compactMap { ($0?.isEmpty == false) ? $0 : nil }
        let areaLabel = parts.prefix(2).joined(separator: ", ")

        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Ubicación", trailing: "Abrir mapa")

            ZStack(alignment: .bottomLeading) {
                Map(initialPosition: .region(MKCoordinateRegion(
                    center: CLLocationCoordinate2D(latitude: lat, longitude: lng),
                    span: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)
                ))) {
                    Marker(title, coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng))
                        .tint(LD.brand)
                }
                .frame(height: 180)
                .disabled(false)

                if !areaLabel.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin.and.ellipse")
                            .font(.system(size: 11, weight: .semibold))
                        Text(areaLabel)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.ultraThinMaterial.opacity(0.7), in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
                    .padding(12)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(LD.line, lineWidth: 1))
        }
    }

    // MARK: - Agents (multi-agent cards)

    @ViewBuilder
    private func agencySection(_ agencies: [Agency], listing: Listing) -> some View {
        // We never expose raw phone/email. Users press "Consultar" and the
        // inquiry routes through the inquiry system so leads are tracked.
        let trailing = agencies.count > 1 ? "\(agencies.count) asignados" : nil

        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Agentes")
                    .font(.system(size: 17, weight: .bold))
                    .kerning(-0.2)
                Spacer()
                if let t = trailing {
                    Text(t)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(LD.textMute)
                }
            }
            VStack(spacing: 8) {
                ForEach(Array(agencies.enumerated()), id: \.offset) { idx, agency in
                    agentRow(agency, accentIndex: idx)
                }
            }
        }
    }

    @ViewBuilder
    private func agentRow(_ agency: Agency, accentIndex: Int) -> some View {
        let palette: [(Color, Color)] = [
            (Color(red: 0xB8/255, green: 0xA0/255, blue: 0x7E/255),
             Color(red: 0x6E/255, green: 0x58/255, blue: 0x47/255)),
            (Color(red: 0x4D/255, green: 0x9E/255, blue: 0xFF/255),
             Color(red: 0x1E/255, green: 0x3A/255, blue: 0x66/255)),
            (Color(red: 0x2B/255, green: 0xD2/255, blue: 0x7A/255),
             Color(red: 0x0F/255, green: 0x6B/255, blue: 0x43/255)),
        ]
        let pair = palette[accentIndex % palette.count]
        let initials: String = {
            guard let n = agency.name, !n.isEmpty else { return "AG" }
            let parts = n.split(separator: " ").prefix(2)
            return parts.map { String($0.prefix(1)) }.joined().uppercased()
        }()

        let row = HStack(spacing: 12) {
            // Gradient avatar
            Group {
                if let url = agency.avatarImageURL {
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFill()
                        default:
                            LinearGradient(colors: [pair.0, pair.1], startPoint: .topLeading, endPoint: .bottomTrailing)
                                .overlay(
                                    Text(initials)
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(.white)
                                )
                        }
                    }
                } else {
                    LinearGradient(colors: [pair.0, pair.1], startPoint: .topLeading, endPoint: .bottomTrailing)
                        .overlay(
                            Text(initials)
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(.white)
                        )
                }
            }
            .frame(width: 48, height: 48)
            .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(agency.name ?? "Agente")
                        .font(.system(size: 14.5, weight: .bold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    // Verified badge — every agency on the platform is verified
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(LD.brand)
                }
                Text("Agente verificado")
                    .font(.system(size: 12))
                    .foregroundStyle(LD.textMute)
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(LD.textMute)
        }
        .padding(14)
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(LD.line, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 16))

        if let slug = agency.slug {
            NavigationLink { AgencyPortfolioView(slug: slug) } label: { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func sectionBlock<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(title)
            content()
        }
    }

    private func load() async {
        loading = true
        listing = try? await APIService.shared.getListing(id: id)
        loading = false
        // Phase G — best-effort review fetch. Public endpoint, so it
        // works for guests too. Silent on failure (no reviews block
        // renders; the listing detail still works).
        if let response = try? await APIService.shared.getListingReviews(id: id) {
            await MainActor.run {
                reviews = response.reviews
                reviewsAverage = response.average
                reviewsCount = response.count
            }
        }
    }

    // MARK: - Reseñas section

    @ViewBuilder
    private var reviewsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Reseñas")
                    .font(.system(size: 17, weight: .bold))
                    .kerning(-0.2)
                Spacer()
                if let avg = reviewsAverage {
                    HStack(spacing: 4) {
                        Image(systemName: "star.fill")
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdGold)
                        Text(String(format: "%.1f", avg))
                            .font(.subheadline.weight(.semibold))
                        Text("· \(reviewsCount)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            VStack(spacing: 0) {
                ForEach(Array(reviews.prefix(5).enumerated()), id: \.element.id) { idx, r in
                    reviewRow(r)
                    if idx < min(reviews.count, 5) - 1 {
                        Divider().padding(.leading, 14)
                    }
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))

            if reviews.count > 5 {
                NavigationLink {
                    AllReviewsView(reviews: reviews,
                                   average: reviewsAverage,
                                   count: reviewsCount)
                } label: {
                    HStack {
                        Text("Ver todas (\(reviewsCount))")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.bold())
                            .foregroundStyle(.tertiary)
                    }
                    .foregroundStyle(Color.rdBlue)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color(.secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func reviewRow(_ r: ListingReview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                HStack(spacing: 1) {
                    ForEach(0..<5, id: \.self) { i in
                        Image(systemName: i < r.rating ? "star.fill" : "star")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.rdGold)
                    }
                }
                Text(r.reviewer_name ?? "Visitante")
                    .font(.caption.bold())
                Spacer()
                if let when = r.feedback_at, let pretty = formatRelativeDate(when) {
                    Text(pretty)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if !r.comment.isEmpty {
                Text(r.comment)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func formatRelativeDate(_ iso: String) -> String? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let date = d else { return nil }
        let days = Int(Date().timeIntervalSince(date) / 86400)
        if days <= 0 { return "Hoy" }
        if days == 1 { return "Ayer" }
        if days < 30 { return "Hace \(days) días" }
        let months = days / 30
        return "Hace \(months) \(months == 1 ? "mes" : "meses")"
    }

    private func shareListing(_ l: Listing) {
        var url = "https://hogaresrd.com/listing/\(l.id)"
        // Append affiliate refToken for any agent sharing a listing
        if let ref = APIService.shared.currentUser?.refToken,
           let userRole = APIService.shared.currentUser?.role,
           ["agency", "broker", "inmobiliaria", "constructora"].contains(userRole) {
            url += "?ref=\(ref)"
        }
        let text = "\(l.title) – \(l.priceFormatted)\n\(url)"
        let av = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let root = scene.windows.first?.rootViewController {
            root.present(av, animated: true)
        }
    }
}

// MARK: - Spec Card

struct SpecCard: View {
    let icon: String
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(Color.rdBlue)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(value).font(.subheadline).bold()
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.rdBlue.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Flow Layout

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        var x: CGFloat = 0; var y: CGFloat = 0; var rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > width, x > 0 { y += rowH + spacing; x = 0; rowH = 0 }
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
        return CGSize(width: width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX; var y = bounds.minY; var rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX { y += rowH + spacing; x = bounds.minX; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
    }
}

// MARK: - Contact Sheet

struct ContactSheet: View {
    let listing: Listing
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var api: APIService

    @State private var name    = ""
    @State private var phone   = ""
    @State private var email   = ""
    @State private var message = ""
    @State private var sending = false
    @State private var sent    = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            if sent {
                // ── Success state ────────────────────────────────
                VStack(spacing: 24) {
                    Spacer()
                    ZStack {
                        Circle()
                            .fill(Color.rdGreen.opacity(0.1))
                            .frame(width: 88, height: 88)
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(Color.rdGreen)
                    }
                    VStack(spacing: 8) {
                        Text("¡Consulta enviada!")
                            .font(.title2).bold()
                        Text("Tu información fue enviada a las inmobiliarias afiliadas. Un agente se pondrá en contacto contigo pronto.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    Spacer()
                    Button("Cerrar") { dismiss() }
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.rdBlue)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .padding(.horizontal, 24)
                        .padding(.bottom, 32)
                }
                .navigationTitle("Agendar Consulta")
                .navigationBarTitleDisplayMode(.inline)
            } else {
                Form {
                    Section("Tu información") {
                        TextField("Nombre completo", text: $name)
                        TextField("Teléfono", text: $phone).keyboardType(.phonePad)
                        TextField("Correo electrónico", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    }
                    Section {
                        TextField("¿Qué tipo de unidad te interesa? ¿Tienes alguna pregunta?", text: $message, axis: .vertical)
                            .lineLimit(4...)
                    } header: {
                        Text("Mensaje (opcional)")
                    }

                    Section {
                        Text("Tu consulta será enviada a todas las inmobiliarias afiliadas a este proyecto. El agente que responda primero te contactará.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if let err = errorMsg {
                        Section { Text(err).foregroundStyle(Color.rdRed).font(.caption) }
                    }

                    Section {
                        Button {
                            Task { await send() }
                        } label: {
                            if sending { ProgressView().frame(maxWidth: .infinity) }
                            else {
                                Text("Enviar Consulta")
                                    .bold()
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .disabled(sending || name.isEmpty || phone.isEmpty)
                    }
                }
                .navigationTitle("Agendar Consulta")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } }
                }
                .onAppear {
                    if let user = api.currentUser {
                        name  = user.name
                        email = user.email
                    }
                }
            }
        }
    }

    private func send() async {
        guard !name.isEmpty, !email.isEmpty else { return }
        sending = true; errorMsg = nil
        let msg = message.isEmpty ? "Estoy interesado en esta propiedad." : message
        do {
            try await APIService.shared.sendInquiry(listingId: listing.id, name: name, email: email, phone: phone, message: msg)
            sent = true
        } catch {
            errorMsg = "No se pudo enviar. Intenta de nuevo."
        }
        sending = false
    }
}

// MARK: - Contact Agent Sheet

struct ContactAgentSheet: View {
    let listing: Listing
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var message    = ""
    @State private var sending    = false
    @State private var errorMsg:  String?
    @State private var createdConv: Conversation?

    var body: some View {
        NavigationStack {
            if let conv = createdConv {
                // ── Navigate straight into the thread after creation ──
                ConversationThreadView(conversation: conv)
                    .environmentObject(api)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Listo") { dismiss() }
                                .fontWeight(.semibold)
                        }
                    }
            } else {
                // ── Compose initial message ───────────────────────────
                composeView
            }
        }
    }

    @ViewBuilder
    private var composeView: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(listing.title)
                        .font(.subheadline).bold()
                    Text(listing.priceFormatted)
                        .font(.caption).foregroundStyle(Color.rdBlue)
                }
                .padding(.vertical, 2)
            } header: { Text("Propiedad") }

            Section {
                TextField("Hola, estoy interesado en esta propiedad…", text: $message, axis: .vertical)
                    .lineLimit(4...8)
            } header: { Text("Tu mensaje") }

            if let err = errorMsg {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                }
            }

            Section {
                Button {
                    Task { await start() }
                } label: {
                    if sending {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Iniciar conversación")
                            .bold()
                            .frame(maxWidth: .infinity)
                    }
                }
                .disabled(sending || message.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .navigationTitle("Contactar Agente")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
        }
        .onAppear {
            // Pre-fill a starter message
            if message.isEmpty {
                message = "Hola, estoy interesado en \"\(listing.title)\". ¿Podría darme más información?"
            }
        }
    }

    private func start() async {
        let text = message.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        guard api.currentUser != nil else {
            errorMsg = "Debes iniciar sesión para contactar a un agente."
            return
        }
        sending = true; errorMsg = nil
        do {
            let conv = try await api.startConversation(
                propertyId:    listing.id,
                propertyTitle: listing.title,
                message:       text
            )
            createdConv = conv
        } catch {
            errorMsg = error.localizedDescription
        }
        sending = false
    }
}

// MARK: - Full Screen Gallery

struct FullGalleryView: View {
    let images: [URL]
    let startIndex: Int
    @Environment(\.dismiss) var dismiss
    @State private var current: Int = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $current) {
                ForEach(Array(images.enumerated()), id: \.offset) { i, url in
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFit()
                        default:
                            ProgressView().tint(.white)
                        }
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .automatic))

            VStack {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 38, height: 38)
                            .background(.ultraThinMaterial.opacity(0.5), in: Circle())
                    }
                    Spacer()
                    Text("\(current + 1) / \(images.count)")
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 16)
                .padding(.top, 54)
                Spacer()
            }
        }
        .onAppear { current = startIndex }
    }
}

// MARK: - All Reviews (full list)

struct AllReviewsView: View {
    let reviews: [ListingReview]
    let average: Double?
    let count: Int

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let avg = average {
                    HStack(spacing: 8) {
                        Image(systemName: "star.fill")
                            .foregroundStyle(Color.rdGold)
                        Text(String(format: "%.1f", avg))
                            .font(.title3.bold())
                        Text("· \(count) reseña\(count == 1 ? "" : "s")")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                }

                VStack(spacing: 0) {
                    ForEach(Array(reviews.enumerated()), id: \.element.id) { idx, r in
                        AllReviewRow(review: r)
                        if idx < reviews.count - 1 {
                            Divider().padding(.leading, 14)
                        }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 16)
            }
            .padding(.vertical, 12)
        }
        .navigationTitle("Reseñas")
        .navigationBarTitleDisplayMode(.inline)
    }

    static func formatRelative(_ iso: String) -> String? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let d = date else { return nil }
        let r = RelativeDateTimeFormatter()
        r.locale = Locale(identifier: "es_DO")
        return r.localizedString(for: d, relativeTo: Date())
    }
}

private struct AllReviewRow: View {
    let review: ListingReview

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                HStack(spacing: 1) {
                    ForEach(0..<5, id: \.self) { i in
                        Image(systemName: i < review.rating ? "star.fill" : "star")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.rdGold)
                    }
                }
                Text(review.reviewer_name ?? "Visitante")
                    .font(.caption.bold())
                Spacer()
                if let when = review.feedback_at, let pretty = AllReviewsView.formatRelative(when) {
                    Text(pretty)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if !review.comment.isEmpty {
                Text(review.comment)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
    }
}
