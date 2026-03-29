import SwiftUI

struct City: Identifiable {
    let id = UUID()
    let name: String
    let slug: String
    let province: String
    let tagline: String
    let category: String
    let color: Color
}

let dominicanCities: [City] = [
    City(name: "Santo Domingo", slug: "santo-domingo", province: "Distrito Nacional", tagline: "Capital y corazón de la RD", category: "Capital", color: Color.rdBlue),
    City(name: "Punta Cana",   slug: "punta-cana",   province: "La Altagracia",     tagline: "El paraíso del Caribe",    category: "Turístico", color: Color.rdRed),
    City(name: "Santiago",     slug: "santiago",     province: "Santiago",           tagline: "La ciudad del Cibao",      category: "Ciudad",    color: Color.rdGreen),
    City(name: "Puerto Plata", slug: "puerto-plata", province: "Puerto Plata",       tagline: "Costa norte de ensueño",   category: "Turístico", color: Color.rdBlue),
    City(name: "Las Terrenas", slug: "las-terrenas", province: "Samaná",             tagline: "Joya de la Bahía de Samaná", category: "Turístico", color: Color.rdGreen),
    City(name: "La Romana",    slug: "la-romana",    province: "La Romana",          tagline: "Entre el mar y la caña",   category: "Ciudad",    color: Color.rdRed),
    City(name: "Las Galeras",  slug: "las-galeras",  province: "Samaná",             tagline: "Tranquilidad y naturaleza", category: "Naturaleza", color: Color.rdGreen),
    City(name: "Bávaro",       slug: "bavaro",       province: "La Altagracia",      tagline: "Playas de fama mundial",   category: "Turístico", color: Color.rdBlue),
]

struct CitiesView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    // Hero strip
                    ZStack {
                        LinearGradient(colors: [
                            Color(red: 0, green: 0.07, blue: 0.19), Color.rdBlue
                        ], startPoint: .topLeading, endPoint: .bottomTrailing)
                        .frame(height: 130)

                        VStack(spacing: 4) {
                            Text("Explora por Ciudad")
                                .font(.title2).bold().foregroundStyle(.white)
                            Text("Encuentra tu propiedad ideal en cualquier rincón de la República Dominicana")
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.75))
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 32)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .padding(.horizontal)

                    // Cities grid
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                        ForEach(dominicanCities) { city in
                            NavigationLink {
                                CityListingsView(city: city)
                            } label: {
                                CityCard(city: city)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 20)
                }
            }
            .navigationTitle("Ciudades")
            .navigationBarTitleDisplayMode(.large)
        }
    }
}

// MARK: - City Card
struct CityCard: View {
    let city: City

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Color block with initial
            ZStack {
                LinearGradient(
                    colors: [city.color, city.color.opacity(0.7)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
                VStack {
                    Text(String(city.name.prefix(1)))
                        .font(.system(size: 36, weight: .black))
                        .foregroundStyle(.white.opacity(0.3))
                    Spacer()
                }
                .padding(12)

                VStack {
                    Spacer()
                    HStack {
                        Text(city.category)
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(.white.opacity(0.25))
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        Spacer()
                    }
                    .padding(10)
                }
            }
            .frame(height: 90)

            VStack(alignment: .leading, spacing: 3) {
                Text(city.name)
                    .font(.subheadline).bold()
                    .foregroundStyle(.primary)
                Text(city.province)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(city.tagline)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(10)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: city.color.opacity(0.12), radius: 8, y: 3)
    }
}

// MARK: - City Listings
struct CityListingsView: View {
    let city: City
    @State private var listings: [Listing] = []
    @State private var loading = true

    var body: some View {
        ScrollView {
            if loading {
                ProgressView().padding(.top, 60)
            } else if listings.isEmpty {
                ContentUnavailableView(
                    "Sin propiedades aún",
                    systemImage: "house.slash",
                    description: Text("No hay listados aprobados en \(city.name) todavía.")
                )
                .padding(.top, 60)
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                    ForEach(listings) { listing in
                        NavigationLink { ListingDetailView(id: listing.id) } label: {
                            GridCard(listing: listing)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
        }
        .navigationTitle(city.name)
        .navigationBarTitleDisplayMode(.large)
        .task {
            loading = true
            if let r = try? await APIService.shared.getListings(city: city.name, limit: 20) {
                listings = r.listings
            }
            loading = false
        }
    }
}
