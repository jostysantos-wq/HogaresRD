import SwiftUI
import MapKit

struct ListingDetailView: View {
    let id: String
    @EnvironmentObject var saved: SavedStore
    @State private var listing:        Listing?
    @State private var loading         = true
    @State private var imageIndex      = 0
    @State private var blueprintIndex  = 0
    @State private var showContact     = false

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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if let l = listing { saved.toggle(l.id) }
                } label: {
                    Image(systemName: listing.map { saved.isSaved($0.id) ? "heart.fill" : "heart" } ?? "heart")
                        .foregroundStyle(listing.map { saved.isSaved($0.id) ? Color.rdRed : Color.primary } ?? Color.primary)
                }
            }
        }
        .sheet(isPresented: $showContact) {
            if let l = listing { ContactSheet(listing: l) }
        }
        .task { await load() }
    }

    // MARK: - Detail Body

    @ViewBuilder
    private func detailBody(_ l: Listing) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {

                // ── Image Carousel ─────────────────────────────────
                imageCarousel(l)

                VStack(alignment: .leading, spacing: 24) {

                    // ── Badges & Title ─────────────────────────────
                    headerSection(l)

                    Divider()

                    // ── Specs Grid ─────────────────────────────────
                    specsSection(l)

                    // ── Project Meta (proyecto only) ───────────────
                    if l.type == "proyecto" { projectMetaSection(l) }

                    // ── Description ────────────────────────────────
                    if let desc = l.description, !desc.isEmpty {
                        sectionBlock("Descripción") {
                            Text(desc)
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    // ── Tags ───────────────────────────────────────
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

                    // ── Amenities ──────────────────────────────────
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

                    // ── Unit Types ─────────────────────────────────
                    if let units = l.unit_types, !units.isEmpty {
                        unitTypesSection(units)
                    }

                    // ── Blueprints ─────────────────────────────────
                    if let bps = l.blueprints, !bps.isEmpty {
                        blueprintsSection(bps, l: l)
                    }

                    // ── Construction Company ───────────────────────
                    if let builder = l.construction_company {
                        builderSection(builder)
                    }

                    // ── Map ────────────────────────────────────────
                    if let lat = l.lat, let lng = l.lng {
                        mapSection(lat: lat, lng: lng, title: l.title, address: l.address)
                    }

                    // ── Agency Contact ─────────────────────────────
                    if let agencies = l.agencies, !agencies.isEmpty {
                        agencySection(agencies, listing: l)
                    }

                    // ── Contact CTA ────────────────────────────────
                    Button { showContact = true } label: {
                        Label("Contactar al Agente", systemImage: "message.fill")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.rdRed)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
                .padding()
            }
        }
    }

    // MARK: - Image Carousel

    @ViewBuilder
    private func imageCarousel(_ l: Listing) -> some View {
        if !l.images.isEmpty {
            TabView(selection: $imageIndex) {
                ForEach(Array(l.images.enumerated()), id: \.offset) { i, img in
                    let url: URL? = img.hasPrefix("http") ? URL(string: img) : URL(string: APIService.baseURL + img)
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image): image.resizable().scaledToFill()
                        default: Rectangle().fill(Color.rdBlue.opacity(0.12))
                            .overlay(Image(systemName: "photo").font(.largeTitle).foregroundStyle(Color.rdBlue.opacity(0.3)))
                        }
                    }
                    .frame(height: 280).clipped().tag(i)
                }
            }
            .tabViewStyle(.page)
            .frame(height: 280)

            HStack(spacing: 5) {
                ForEach(0..<l.images.count, id: \.self) { i in
                    Circle()
                        .fill(i == imageIndex ? Color.rdBlue : Color(.systemGray4))
                        .frame(width: i == imageIndex ? 8 : 5, height: i == imageIndex ? 8 : 5)
                }
            }
            .padding(.vertical, 8).frame(maxWidth: .infinity)
        } else {
            Rectangle().fill(Color.rdBlue.opacity(0.12)).frame(height: 220)
                .overlay(Image(systemName: "house.fill").font(.system(size: 50)).foregroundStyle(Color.rdBlue.opacity(0.3)))
        }
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
    @State private var email   = ""
    @State private var phone   = ""
    @State private var message = ""
    @State private var sending = false
    @State private var sent    = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Tu información") {
                    TextField("Nombre completo", text: $name)
                    TextField("Correo electrónico", text: $email).keyboardType(.emailAddress)
                    TextField("Teléfono", text: $phone).keyboardType(.phonePad)
                }
                Section("Mensaje") {
                    TextField("¿En qué puedo ayudarte?", text: $message, axis: .vertical)
                        .lineLimit(4...)
                }
                if let err = errorMsg {
                    Section { Text(err).foregroundStyle(Color.rdRed).font(.caption) }
                }
                Section {
                    if sent {
                        HStack {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.rdGreen)
                            Text("Mensaje enviado correctamente").foregroundStyle(Color.rdGreen)
                        }
                    } else {
                        Button {
                            Task { await send() }
                        } label: {
                            if sending { ProgressView() }
                            else { Text("Enviar mensaje").bold().frame(maxWidth: .infinity) }
                        }
                        .disabled(sending || name.isEmpty || email.isEmpty)
                    }
                }
            }
            .navigationTitle("Contactar Agente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } }
            }
            .onAppear {
                if let user = api.currentUser { name = user.name; email = user.email }
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
