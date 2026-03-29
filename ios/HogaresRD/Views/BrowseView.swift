import SwiftUI

struct BrowseView: View {
    var initialType: String = "venta"

    @State private var selectedType = "venta"
    @State private var listings: [Listing] = []
    @State private var loading = false
    @State private var page = 1
    @State private var totalPages = 1
    @State private var error: String?

    private let types: [(String, String)] = [
        ("venta",    "Comprar"),
        ("alquiler", "Alquilar"),
        ("proyecto", "Proyectos")
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Type selector
                Picker("Tipo", selection: $selectedType) {
                    ForEach(types, id: \.0) { (val, label) in
                        Text(label).tag(val)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 10)
                .background(Color(.systemBackground))

                Divider()

                if loading && listings.isEmpty {
                    Spacer()
                    ProgressView("Cargando propiedades...")
                    Spacer()
                } else if let err = error {
                    Spacer()
                    VStack(spacing: 12) {
                        Image(systemName: "wifi.slash").font(.largeTitle).foregroundStyle(Color.rdRed)
                        Text(err).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        Button("Reintentar") { Task { await load(reset: true) } }
                            .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                    }
                    .padding()
                    Spacer()
                } else {
                    listingsGrid
                }
            }
            .navigationTitle("Explorar")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            selectedType = initialType
        }
        .onChange(of: selectedType) { _ in
            Task { await load(reset: true) }
        }
        .task { await load(reset: true) }
    }

    // MARK: - Grid
    private var listingsGrid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                ForEach(listings) { listing in
                    NavigationLink {
                        ListingDetailView(id: listing.id)
                    } label: {
                        GridCard(listing: listing)
                    }
                    .buttonStyle(.plain)
                    .onAppear {
                        if listing.id == listings.last?.id, page < totalPages {
                            Task { await loadMore() }
                        }
                    }
                }
            }
            .padding()

            if loading && !listings.isEmpty {
                ProgressView().padding()
            }
        }
    }

    // MARK: - Load
    private func load(reset: Bool) async {
        if reset { page = 1; listings = [] }
        loading = true; error = nil
        do {
            let result = try await APIService.shared.getListings(type: selectedType, limit: 12, page: page)
            listings = result.listings
            totalPages = result.pages
        } catch {
            self.error = "No se pudieron cargar las propiedades. Verifica tu conexión."
        }
        loading = false
    }

    private func loadMore() async {
        guard !loading else { return }
        page += 1
        loading = true
        if let result = try? await APIService.shared.getListings(type: selectedType, limit: 12, page: page) {
            listings.append(contentsOf: result.listings)
        }
        loading = false
    }
}

// MARK: - Grid Card
struct GridCard: View {
    let listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                AsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFill()
                    default: Rectangle().fill(Color.rdBlue.opacity(0.1))
                        .overlay(Image(systemName: "house.fill").foregroundStyle(Color.rdBlue.opacity(0.3)))
                    }
                }
                .frame(height: 120)
                .clipped()

                Text(listing.typeLabel)
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(listing.type == "venta" ? Color.rdGreen : listing.type == "alquiler" ? Color.rdBlue : Color.rdRed)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                    .padding(7)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(listing.title)
                    .font(.caption).bold()
                    .lineLimit(2)
                    .foregroundStyle(.primary)

                Text(listing.priceFormatted)
                    .font(.caption).bold()
                    .foregroundStyle(Color.rdBlue)

                HStack(spacing: 6) {
                    if let b = listing.bedrooms, b != "" { Label(b, systemImage: "bed.double").font(.system(size: 9)) }
                    if let b = listing.bathrooms, b != "" { Label(b, systemImage: "shower").font(.system(size: 9)) }
                }
                .foregroundStyle(.secondary)
            }
            .padding(9)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: Color.rdBlue.opacity(0.09), radius: 6, y: 2)
    }
}
