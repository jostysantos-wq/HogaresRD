import SwiftUI

struct ListingDetailView: View {
    let id: String
    @State private var listing: Listing?
    @State private var loading = true
    @State private var imageIndex = 0
    @State private var showContact = false

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
                            .frame(height: 280)
                            .clipped()
                            .tag(i)
                        }
                    }
                    .tabViewStyle(.page)
                    .frame(height: 280)

                    // Dot indicator
                    HStack(spacing: 5) {
                        ForEach(0..<l.images.count, id: \.self) { i in
                            Circle()
                                .fill(i == imageIndex ? Color.rdBlue : Color(.systemGray4))
                                .frame(width: i == imageIndex ? 8 : 5, height: i == imageIndex ? 8 : 5)
                        }
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                } else {
                    Rectangle().fill(Color.rdBlue.opacity(0.12))
                        .frame(height: 220)
                        .overlay(Image(systemName: "house.fill").font(.system(size: 50)).foregroundStyle(Color.rdBlue.opacity(0.3)))
                }

                VStack(alignment: .leading, spacing: 20) {
                    // ── Title & Price ──────────────────────────────
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(l.typeLabel)
                                .font(.caption).bold()
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(l.type == "venta" ? Color.rdGreen : l.type == "alquiler" ? Color.rdBlue : Color.rdRed)
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                            Spacer()
                            if let views = l.views {
                                Label("\(views)", systemImage: "eye")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }

                        Text(l.title)
                            .font(.title2).bold()

                        Text(l.priceFormatted)
                            .font(.title).bold()
                            .foregroundStyle(Color.rdBlue)

                        if let city = l.city, let prov = l.province {
                            Label("\(city), \(prov)", systemImage: "mappin.circle.fill")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                        }
                    }

                    Divider()

                    // ── Specs ──────────────────────────────────────
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        if let b = l.bedrooms,  b != "" { SpecCard(icon: "bed.double.fill",    label: "Habitaciones", value: b) }
                        if let b = l.bathrooms, b != "" { SpecCard(icon: "shower.fill",         label: "Baños",       value: b) }
                        if let p = l.parking,  p != "" { SpecCard(icon: "car.fill",             label: "Parqueo",     value: p) }
                        if let a = l.area_const, a != "" { SpecCard(icon: "square.split.2x2", label: "Área Const.",  value: "\(a) m²") }
                        if let a = l.area_land, a != "" { SpecCard(icon: "leaf.fill",          label: "Terreno",     value: "\(a) m²") }
                    }

                    // ── Description ────────────────────────────────
                    if let desc = l.description, !desc.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Descripción")
                                .font(.headline)
                            Text(desc)
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    // ── Amenities ──────────────────────────────────
                    if !l.amenities.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Amenidades")
                                .font(.headline)
                            FlowLayout(spacing: 8) {
                                ForEach(l.amenities, id: \.self) { amenity in
                                    Text(amenity)
                                        .font(.caption).bold()
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(Color.rdBlue.opacity(0.08))
                                        .foregroundStyle(Color.rdBlue)
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }

                    // ── Contact CTA ────────────────────────────────
                    Button {
                        showContact = true
                    } label: {
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

    @State private var name  = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var message = ""
    @State private var sending = false
    @State private var sent = false
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .onAppear {
                if let user = api.currentUser {
                    name = user.name; email = user.email
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
