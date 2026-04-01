import SwiftUI
import MapKit

struct ListingDetailView: View {
    let id: String
    @EnvironmentObject var saved: SavedStore
    @Environment(\.dismiss) var dismiss
    @State private var listing:        Listing?
    @State private var loading         = true
    @State private var imageIndex      = 0
    @State private var blueprintIndex  = 0
    @State private var showContact      = false
    @State private var showApply        = false
    @State private var showContactAgent = false
    @State private var showFullGallery  = false

    private let heroHeight: CGFloat = UIScreen.main.bounds.height * 0.55

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
        .sheet(isPresented: $showContact) {
            if let l = listing { ContactSheet(listing: l) }
        }
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
        .task { await load() }
    }

    // MARK: - Detail Body

    @ViewBuilder
    private func detailBody(_ l: Listing) -> some View {
        ZStack(alignment: .top) {
            // Hero image behind everything
            heroImages(l)

            // Scrollable content that overlaps the image
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Transparent spacer so the image is visible (opacity 0.001 to capture touches)
                    Color.white.opacity(0.001).frame(height: heroHeight - 30)

                    // Content card with rounded top corners
                    VStack(alignment: .leading, spacing: 24) {
                        // Drag indicator
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color.secondary.opacity(0.4))
                            .frame(width: 38, height: 5)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 14)

                        // ── Price + Save ──────────────────────────────
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(l.priceFormatted)
                                    .font(.system(size: 28, weight: .bold))
                                    .foregroundStyle(Color.rdBlue)
                                HStack(spacing: 8) {
                                    Text(l.typeLabel)
                                        .font(.caption).bold()
                                        .padding(.horizontal, 10).padding(.vertical, 4)
                                        .background(l.type == "venta" ? Color.rdGreen : l.type == "alquiler" ? Color.rdBlue : Color.rdRed)
                                        .foregroundStyle(.white).clipShape(Capsule())
                                    if let cond = l.condition, !cond.isEmpty {
                                        Text(cond)
                                            .font(.caption).bold()
                                            .padding(.horizontal, 10).padding(.vertical, 4)
                                            .background(Color(.systemGray5))
                                            .foregroundStyle(.secondary).clipShape(Capsule())
                                    }
                                }
                            }
                            Spacer()
                            Button {
                                saved.toggle(l.id)
                            } label: {
                                Image(systemName: saved.isSaved(l.id) ? "heart.fill" : "heart")
                                    .font(.title2)
                                    .foregroundStyle(saved.isSaved(l.id) ? Color.rdRed : .secondary)
                            }
                        }

                        // ── Title & Location ──────────────────────────
                        VStack(alignment: .leading, spacing: 6) {
                            Text(l.title).font(.title3).bold()
                            let parts = [l.sector, l.city, l.province].compactMap { v in (v?.isEmpty == false) ? v : nil }
                            if !parts.isEmpty {
                                Label(parts.joined(separator: ", "), systemImage: "mappin.circle.fill")
                                    .foregroundStyle(.secondary).font(.subheadline)
                            }
                            if let addr = l.address, !addr.isEmpty {
                                Label(addr, systemImage: "map")
                                    .foregroundStyle(.secondary).font(.caption)
                            }
                        }

                        // ── Quick Stats Bar ───────────────────────────
                        quickStatsBar(l)

                        Divider()

                        // ── Specs Grid ─────────────────────────────
                        specsSection(l)

                        // ── Project Meta (proyecto only) ───────────
                        if l.type == "proyecto" { projectMetaSection(l) }

                        // ── Description ────────────────────────────
                        if let desc = l.description, !desc.isEmpty {
                            sectionBlock("Descripción") {
                                Text(desc)
                                    .font(.body)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        // ── Tags ───────────────────────────────────
                        if let tags = l.tags, !tags.isEmpty {
                            sectionBlock("Características") {
                                FlowLayout(spacing: 8) {
                                    ForEach(tags, id: \.self) { tag in
                                        Text(tag)
                                            .font(.caption).bold()
                                            .padding(.horizontal, 10).padding(.vertical, 5)
                                            .background(Color.rdRed.opacity(0.08))
                                            .foregroundStyle(Color.rdRed)
                                            .clipShape(Capsule())
                                    }
                                }
                            }
                        }

                        // ── Amenities ──────────────────────────────
                        if !l.amenities.isEmpty {
                            sectionBlock("Amenidades") {
                                FlowLayout(spacing: 8) {
                                    ForEach(l.amenities, id: \.self) { a in
                                        Text(a)
                                            .font(.caption).bold()
                                            .padding(.horizontal, 10).padding(.vertical, 5)
                                            .background(Color.rdBlue.opacity(0.08))
                                            .foregroundStyle(Color.rdBlue)
                                            .clipShape(Capsule())
                                    }
                                }
                            }
                        }

                        // ── Unit Types ─────────────────────────────
                        if let units = l.unit_types, !units.isEmpty {
                            unitTypesSection(units)
                        }

                        // ── Blueprints ─────────────────────────────
                        if let bps = l.blueprints, !bps.isEmpty {
                            blueprintsSection(bps, l: l)
                        }

                        // ── Construction Company ───────────────────
                        if let builder = l.construction_company {
                            builderSection(builder)
                        }

                        // ── Map ────────────────────────────────────
                        if let lat = l.lat, let lng = l.lng {
                            mapSection(lat: lat, lng: lng, title: l.title, address: l.address)
                        }

                        // ── Agency Contact ─────────────────────────
                        if let agencies = l.agencies, !agencies.isEmpty {
                            agencySection(agencies, listing: l)
                        }

                        Color.clear.frame(height: 90)
                    }
                    .padding(.horizontal, 16)
                    .background(
                        Color(.systemBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                            .shadow(color: .black.opacity(0.15), radius: 16, y: -6)
                    )
                }
            }

            // Floating top bar (back, share, image counter)
            heroOverlayBar(l)

            // Sticky CTA at the bottom
            if listing != nil {
                VStack(spacing: 0) {
                    Spacer()
                    stickyCTA(l)
                }
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    // MARK: - Hero Images

    @ViewBuilder
    private func heroImages(_ l: Listing) -> some View {
        if !l.images.isEmpty {
            TabView(selection: $imageIndex) {
                ForEach(Array(l.images.enumerated()), id: \.offset) { i, img in
                    let url: URL? = img.hasPrefix("http") ? URL(string: img) : URL(string: APIService.baseURL + img)
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            Rectangle().fill(Color(.systemGray6))
                                .overlay(Image(systemName: "photo").font(.system(size: 40)).foregroundStyle(Color(.systemGray3)))
                        }
                    }
                    .frame(height: heroHeight)
                    .clipped()
                    .tag(i)
                    .onTapGesture { showFullGallery = true }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: heroHeight)
        } else {
            Rectangle().fill(Color(.systemGray6)).frame(height: heroHeight)
                .overlay(Image(systemName: "house.fill").font(.system(size: 50)).foregroundStyle(Color(.systemGray3)))
        }
    }

    // MARK: - Hero Overlay Bar

    @ViewBuilder
    private func heroOverlayBar(_ l: Listing) -> some View {
        HStack {
            // Back button
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(.ultraThinMaterial.opacity(0.7), in: Circle())
                    .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
            }

            Spacer()

            // Image counter
            if l.images.count > 1 {
                Text("\(imageIndex + 1)/\(l.images.count)")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(.ultraThinMaterial.opacity(0.7), in: Capsule())
                    .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
            }

            // Share button
            Button { } label: {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(.ultraThinMaterial.opacity(0.7), in: Circle())
                    .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 54)
    }

    // MARK: - Quick Stats Bar

    @ViewBuilder
    private func quickStatsBar(_ l: Listing) -> some View {
        HStack(spacing: 0) {
            if let b = l.bedrooms, !b.isEmpty {
                statPill(icon: "bed.double.fill", value: b, label: "Hab.")
            }
            if let b = l.bathrooms, !b.isEmpty {
                statPill(icon: "shower.fill", value: b, label: "Baños")
            }
            if let a = l.area_const, !a.isEmpty {
                statPill(icon: "ruler", value: "\(a) m²", label: "Área")
            }
            if let p = l.parking, !p.isEmpty {
                statPill(icon: "car.fill", value: p, label: "Parqueo")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color.rdBlue.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
    }

    private func statPill(icon: String, value: String, label: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(Color.rdBlue)
            Text(value).font(.subheadline.bold())
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Sticky CTA

    @ViewBuilder
    private func stickyCTA(_ l: Listing) -> some View {
        HStack(spacing: 10) {
            Button { showContact = true } label: {
                Label("Consulta", systemImage: "calendar.badge.plus")
                    .font(.subheadline).bold()
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.rdBlue, lineWidth: 1.5))
                    .foregroundStyle(Color.rdBlue)
            }

            Button { showContactAgent = true } label: {
                Label("Contactar", systemImage: "bubble.left.fill")
                    .font(.subheadline).bold()
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }

    // MARK: - Header

    @ViewBuilder
    private func headerSection(_ l: Listing) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Badges row
            HStack(spacing: 8) {
                Text(l.typeLabel)
                    .font(.caption).bold()
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(l.type == "venta" ? Color.rdGreen : l.type == "alquiler" ? Color.rdBlue : Color.rdRed)
                    .foregroundStyle(.white).clipShape(Capsule())

                if let cond = l.condition, !cond.isEmpty {
                    Text(cond)
                        .font(.caption).bold()
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Color(.systemGray5))
                        .foregroundStyle(.secondary).clipShape(Capsule())
                }

                if let stage = l.project_stage, !stage.isEmpty {
                    Text(stage)
                        .font(.caption).bold()
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Color.rdBlue.opacity(0.12))
                        .foregroundStyle(Color.rdBlue).clipShape(Capsule())
                }

                Spacer()
                if let views = l.views {
                    Label("\(views)", systemImage: "eye")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Text(l.title).font(.title2).bold()

            Text(l.priceFormatted).font(.title).bold().foregroundStyle(Color.rdBlue)

            // Full location: sector → city → province + address
            VStack(alignment: .leading, spacing: 4) {
                let parts = [l.sector, l.city, l.province].compactMap { v in (v?.isEmpty == false) ? v : nil }
                if !parts.isEmpty {
                    Label(parts.joined(separator: ", "), systemImage: "mappin.circle.fill")
                        .foregroundStyle(.secondary).font(.subheadline)
                }
                if let addr = l.address, !addr.isEmpty {
                    Label(addr, systemImage: "map")
                        .foregroundStyle(.secondary).font(.caption)
                }
            }
        }
    }

    // MARK: - Specs

    @ViewBuilder
    private func specsSection(_ l: Listing) -> some View {
        let hasSpecs = [l.bedrooms, l.bathrooms, l.parking, l.area_const, l.area_land]
            .contains { $0 != nil && $0 != "" }
            || l.floors != nil || l.delivery_date != nil

        if hasSpecs {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                if let b = l.bedrooms,     b != "" { SpecCard(icon: "bed.double.fill",    label: "Habitaciones", value: b) }
                if let b = l.bathrooms,    b != "" { SpecCard(icon: "shower.fill",         label: "Baños",        value: b) }
                if let p = l.parking,      p != "" { SpecCard(icon: "car.fill",            label: "Parqueo",      value: p) }
                if let a = l.area_const,   a != "" { SpecCard(icon: "square.split.2x2",   label: "Área Const.",  value: "\(a) m²") }
                if let a = l.area_land,    a != "" { SpecCard(icon: "leaf.fill",           label: "Terreno",      value: "\(a) m²") }
                if let f = l.floors               { SpecCard(icon: "building.2.fill",     label: "Pisos",        value: "\(f)") }
                if let d = l.delivery_date, d != "" { SpecCard(icon: "calendar",          label: "Entrega",      value: d) }
            }
        }
    }

    // MARK: - Project Meta

    @ViewBuilder
    private func projectMetaSection(_ l: Listing) -> some View {
        if l.units_available != nil || l.project_stage != nil {
            VStack(alignment: .leading, spacing: 12) {
                Text("Información del Proyecto").font(.headline)

                if let avail = l.units_available, let total = l.units_total, total > 0 {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Unidades disponibles")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(avail) / \(total)")
                                .font(.subheadline).bold()
                                .foregroundStyle(avail > 0 ? Color.rdGreen : Color.rdRed)
                        }
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(.systemGray5)).frame(height: 8)
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color.rdGreen)
                                    .frame(width: geo.size.width * CGFloat(avail) / CGFloat(total), height: 8)
                            }
                        }
                        .frame(height: 8)
                    }
                }
            }
        }
    }

    // MARK: - Unit Types

    @ViewBuilder
    private func unitTypesSection(_ units: [ListingUnit]) -> some View {
        sectionBlock("Tipos de Unidades") {
            VStack(spacing: 12) {
                ForEach(Array(units.enumerated()), id: \.offset) { _, u in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(u.name ?? u.bedroomLabel)
                                .font(.subheadline).bold()
                            Spacer()
                            if let avail = u.available, let total = u.total {
                                Text("\(avail)/\(total) disp.")
                                    .font(.caption).bold()
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(avail > 0 ? Color.rdGreen.opacity(0.12) : Color(.systemGray5))
                                    .foregroundStyle(avail > 0 ? Color.rdGreen : .secondary)
                                    .clipShape(Capsule())
                            }
                        }

                        HStack(spacing: 16) {
                            if let area = u.area, !area.isEmpty {
                                Label("\(area) m²", systemImage: "square.split.2x2")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if u.bedrooms != nil {
                                Label(u.bedroomLabel, systemImage: "bed.double.fill")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let baths = u.bathrooms, !baths.isEmpty {
                                Label(baths, systemImage: "shower.fill")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let park = u.parking, !park.isEmpty {
                                Label(park, systemImage: "car.fill")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }

                        if let price = u.priceFormatted {
                            Text(price)
                                .font(.headline).bold()
                                .foregroundStyle(Color.rdBlue)
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
                        AsyncImage(url: url) { phase in
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

    // MARK: - Map

    @ViewBuilder
    private func mapSection(lat: Double, lng: Double, title: String, address: String?) -> some View {
        sectionBlock("Ubicación") {
            VStack(alignment: .leading, spacing: 8) {
                if let addr = address, !addr.isEmpty {
                    Label(addr, systemImage: "mappin.circle.fill")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Map(initialPosition: .region(MKCoordinateRegion(
                    center: CLLocationCoordinate2D(latitude: lat, longitude: lng),
                    span: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)
                ))) {
                    Marker(title, coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng))
                        .tint(Color.rdRed)
                }
                .frame(height: 200)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .disabled(false)
            }
        }
    }

    // MARK: - Agency Contact

    @ViewBuilder
    private func agencySection(_ agencies: [Agency], listing: Listing) -> some View {
        sectionBlock("Agencia") {
            VStack(spacing: 10) {
                ForEach(Array(agencies.enumerated()), id: \.offset) { _, agency in
                    HStack(spacing: 12) {
                        ZStack {
                            Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 44, height: 44)
                            Image(systemName: "building.2.fill").foregroundStyle(Color.rdBlue)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            if let name = agency.name {
                                Text(name).font(.subheadline).bold()
                            }
                            HStack(spacing: 12) {
                                if let phone = agency.phone, !phone.isEmpty,
                                   let url = URL(string: "tel:\(phone.filter { $0.isNumber })") {
                                    Link(destination: url) {
                                        Label(phone, systemImage: "phone.fill")
                                            .font(.caption).foregroundStyle(Color.rdGreen)
                                    }
                                }
                                if let email = agency.email, !email.isEmpty,
                                   let url = URL(string: "mailto:\(email)") {
                                    Link(destination: url) {
                                        Label(email, systemImage: "envelope.fill")
                                            .font(.caption).foregroundStyle(Color.rdBlue)
                                    }
                                }
                            }
                        }
                        Spacer()
                        if let slug = agency.slug {
                            NavigationLink { AgencyPortfolioView(slug: slug) } label: {
                                Text("Ver todo")
                                    .font(.caption).bold()
                                    .foregroundStyle(Color.rdBlue)
                            }
                        }
                    }
                    .padding(12)
                    .background(Color.rdBlue.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func sectionBlock<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
    }

    private func load() async {
        loading = true
        listing = try? await APIService.shared.getListing(id: id)
        loading = false
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
                    AsyncImage(url: url) { phase in
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
