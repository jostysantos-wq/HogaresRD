import SwiftUI

struct HomeView: View {
    @EnvironmentObject var api: APIService
    @State private var featured: [Listing] = []
    @State private var recent: [Listing] = []
    @State private var agencies: [Inmobiliaria] = []
    @State private var loading = true
    @State private var selectedType = "venta"
    @State private var searchText = ""
    @State private var showSubmit = false

    private let types = [("venta", "Comprar"), ("alquiler", "Alquilar"), ("proyecto", "Proyectos")]
    private let agencyColors: [Color] = [Color.rdBlue, Color.rdRed, Color.rdGreen,
                                          Color(red: 0.55, green: 0.27, blue: 0.07),
                                          Color(red: 0.4, green: 0.1, blue: 0.6)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    // ── Hero ──────────────────────────────────────────
                    heroSection

                    // ── Search Bar ────────────────────────────────────
                    searchSection
                        .padding(.horizontal)
                        .padding(.top, -20)

                    // ── Stats Strip ───────────────────────────────────
                    statsStrip
                        .padding(.top, 28)

                    // ── Featured (carousel) ───────────────────────────
                    carouselSection(
                        label: "✦ Personalizadas",
                        title: "Propiedades Destacadas",
                        listings: featured,
                        loading: loading
                    )
                    .padding(.top, 32)

                    // ── Más Recientes (carousel) ──────────────────────
                    carouselSection(
                        label: "Nuevas",
                        title: "Más Recientes",
                        listings: recent,
                        loading: loading
                    )
                    .padding(.top, 8)

                    // ── How it Works ──────────────────────────────────
                    howItWorksSection
                        .padding(.top, 8)

                    // ── Inmobiliarias Afiliadas ───────────────────────
                    if !agencies.isEmpty {
                        agenciasSection
                            .padding(.top, 8)
                    }

                    Spacer().frame(height: 40)
                }
            }
            .ignoresSafeArea(edges: .top)
            .navigationBarHidden(true)
            .overlay(alignment: .topTrailing) {
                Button {
                    showSubmit = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .bold))
                        Text("Publicar")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.rdRed)
                    .clipShape(Capsule())
                    .shadow(color: Color.rdRed.opacity(0.4), radius: 6, y: 3)
                }
                .padding(.top, 56)
                .padding(.trailing, 16)
            }
            .sheet(isPresented: $showSubmit) {
                SubmitListingView().environmentObject(api)
            }
        }
        .task { await loadAll() }
    }

    // MARK: - Carousel section builder

    @ViewBuilder
    private func carouselSection(label: String, title: String, listings: [Listing], loading: Bool) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label.uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.rdRed)
                        .kerning(1.5)
                    Text(title)
                        .font(.title3).bold()
                }
                Spacer()
                NavigationLink("Ver todas →") { BrowseView() }
                    .font(.subheadline)
                    .foregroundStyle(Color.rdBlue)
            }
            .padding(.horizontal)

            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 200)
            } else if listings.isEmpty {
                Text("No hay propiedades disponibles")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(listings) { listing in
                            NavigationLink {
                                ListingDetailView(id: listing.id)
                            } label: {
                                ListingCard(listing: listing)
                            }
                            .buttonStyle(.plain)
                            .scrollTransition(.animated) { content, phase in
                                content
                                    .opacity(phase.isIdentity ? 1 : 0.72)
                                    .scaleEffect(phase.isIdentity ? 1 : 0.94)
                            }
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal)
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollClipDisabled()
            }
        }
    }

    // MARK: - Hero

    private var heroSection: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [Color(red: 0, green: 0.07, blue: 0.19),
                         Color.rdBlue,
                         Color(red: 0, green: 0.33, blue: 0.82)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )

            // Decorative circles
            Circle().fill(.white.opacity(0.06)).frame(width: 300, height: 300)
                .offset(x: 120, y: -60)
            Circle().fill(.white.opacity(0.05)).frame(width: 180, height: 180)
                .offset(x: -40, y: 60)

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "mappin.fill")
                        .font(.caption2)
                    Text("REPÚBLICA DOMINICANA")
                        .font(.caption2).bold()
                        .kerning(1.2)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(Color.rdRed)
                .clipShape(Capsule())

                Text("Tu Hogar Ideal\nte está esperando")
                    .font(.largeTitle).bold()
                    .foregroundStyle(.white)
                    .lineSpacing(2)

                Text("Miles de propiedades en venta y alquiler\nen toda la República Dominicana.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.75))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
        .frame(maxWidth: .infinity)
        .containerRelativeFrame(.vertical)
    }

    // MARK: - Search Card

    private var searchSection: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(types, id: \.0) { (type, label) in
                    Button(label) { selectedType = type }
                        .font(.subheadline).fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .foregroundStyle(selectedType == type ? Color.rdBlue : Color(.secondaryLabel))
                        .overlay(alignment: .bottom) {
                            if selectedType == type {
                                Rectangle().fill(Color.rdBlue).frame(height: 2)
                            }
                        }
                }
            }
            .background(Color(.systemBackground))

            Divider()

            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Color(.tertiaryLabel))
                TextField("Ciudad, provincia o sector...", text: $searchText)
                    .font(.subheadline)
                NavigationLink {
                    BrowseView(initialType: selectedType)
                } label: {
                    Text("Buscar")
                        .font(.subheadline).bold()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Color.rdRed)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(.systemBackground))
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: Color.rdBlue.opacity(0.15), radius: 16, y: 6)
    }

    // MARK: - Stats

    private var statsStrip: some View {
        HStack {
            ForEach([
                ("12,400+", "Propiedades", "house.fill"),
                ("32", "Ciudades", "mappin.fill"),
                ("8,200+", "Usuarios", "person.2.fill")
            ], id: \.0) { (value, label, icon) in
                VStack(spacing: 4) {
                    Image(systemName: icon).foregroundStyle(Color.rdBlue)
                    Text(value).font(.title3).bold()
                    Text(label).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                if value != "8,200+" { Divider().frame(height: 40) }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: Color.rdBlue.opacity(0.08), radius: 8)
        .padding(.horizontal)
    }

    // MARK: - How It Works

    private var howItWorksSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("PROCESO")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.rdRed)
                    .kerning(1.5)
                Text("¿Cómo Funciona?")
                    .font(.title3).bold()
            }
            .padding(.horizontal)

            VStack(spacing: 12) {
                HowStepCard(
                    number: "1",
                    icon: "magnifyingglass",
                    iconColor: Color.rdBlue,
                    title: "Busca tu Propiedad",
                    description: "Usa nuestros filtros avanzados para encontrar la propiedad perfecta según tu presupuesto, ubicación y necesidades."
                )
                HowStepCard(
                    number: "2",
                    icon: "envelope.fill",
                    iconColor: Color.rdRed,
                    title: "Contacta al Vendedor",
                    description: "Comunícate directamente con el propietario o agente. Sin intermediarios innecesarios, sin complicaciones."
                )
                HowStepCard(
                    number: "3",
                    icon: "checkmark.seal.fill",
                    iconColor: Color.rdGreen,
                    title: "Cierra el Trato",
                    description: "Visita la propiedad, negocia y haz tu sueño realidad. Estamos contigo en cada paso del proceso."
                )
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 28)
        .background(Color(.secondarySystemBackground))
    }

    // MARK: - Inmobiliarias Afiliadas

    private var agenciasSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("DIRECTORIO")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.rdRed)
                    .kerning(1.5)
                Text("Inmobiliarias Afiliadas")
                    .font(.title3).bold()
            }
            .padding(.horizontal)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(Array(agencies.enumerated()), id: \.element.id) { idx, agency in
                        InmobiliariaCard(agency: agency, color: agencyColors[idx % agencyColors.count])
                    }
                }
                .padding(.horizontal)
            }
        }
        .padding(.vertical, 28)
    }

    // MARK: - Load

    private func loadAll() async {
        loading = true
        async let f = APIService.shared.getListings(limit: 8)
        async let r = APIService.shared.getListings(limit: 8, page: 2)
        async let a = APIService.shared.getAgencies()
        if let result = try? await f { featured = result.listings }
        if let result = try? await r { recent = result.listings }
        if let result = try? await a { agencies = result }
        loading = false
    }
}

// MARK: - Listing Card (carousel style)

struct ListingCard: View {
    let listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                AsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFill()
                    default:
                        Rectangle().fill(Color.rdBlue.opacity(0.12))
                            .overlay(Image(systemName: "photo").foregroundStyle(Color.rdBlue.opacity(0.4)).font(.title))
                    }
                }
                .frame(height: 180)
                .clipShape(RoundedRectangle(cornerRadius: 0))
                .clipped()

                Text(listing.typeLabel)
                    .font(.caption2).bold()
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(listing.type == "venta" ? Color.rdGreen : listing.type == "alquiler" ? Color.rdBlue : Color.rdRed)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                    .padding(10)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(listing.title)
                    .font(.subheadline).bold()
                    .lineLimit(2)
                    .foregroundStyle(.primary)

                Text(listing.priceFormatted)
                    .font(.headline).bold()
                    .foregroundStyle(Color.rdBlue)

                HStack(spacing: 10) {
                    if let beds = listing.bedrooms, beds != "" {
                        Label(beds, systemImage: "bed.double")
                    }
                    if let baths = listing.bathrooms, baths != "" {
                        Label(baths, systemImage: "shower")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if let city = listing.city {
                    Label(city, systemImage: "mappin")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)
        }
        .frame(width: 240)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: Color.rdBlue.opacity(0.10), radius: 8, y: 3)
    }
}

// MARK: - How Step Card

struct HowStepCard: View {
    let number: String
    let icon: String
    let iconColor: Color
    let title: String
    let description: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            ZStack {
                Circle()
                    .fill(iconColor.opacity(0.12))
                    .frame(width: 52, height: 52)
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(iconColor)
                Text(number)
                    .font(.system(size: 9, weight: .black))
                    .foregroundStyle(.white)
                    .padding(4)
                    .background(iconColor)
                    .clipShape(Circle())
                    .offset(x: 16, y: -16)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline).bold()
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: Color.rdBlue.opacity(0.06), radius: 6, y: 2)
    }
}

// MARK: - Inmobiliaria Card

struct InmobiliariaCard: View {
    let agency: Inmobiliaria
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(color)
                        .frame(width: 48, height: 48)
                    Text(agency.initials)
                        .font(.system(size: 14, weight: .black))
                        .foregroundStyle(.white)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(agency.name)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                    Text("\(agency.count) propiedad\(agency.count != 1 ? "es" : "")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Ver portafolio →")
                .font(.caption).bold()
                .foregroundStyle(color)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(color, lineWidth: 1.5))
        }
        .padding()
        .frame(width: 200)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: Color.rdBlue.opacity(0.08), radius: 6, y: 2)
    }
}
