import SwiftUI
import CoreLocation
import MapKit

// MARK: - BrowseView (Explorar — Zillow-style)
struct BrowseView: View {
    var initialType: String = "venta"

    @State private var selectedType  = "venta"
    @State private var listings:      [Listing] = []
    @State private var loading        = false
    @State private var page           = 1
    @State private var totalPages     = 1
    @State private var error:         String?   = nil

    // Map state
    @State private var selectedListing: Listing? = nil
    @State private var pins:            [Listing] = []

    // Filter sheet
    @State private var showFilters     = false
    @State private var filterProvince: String?   = nil

    // Search
    @State private var searchText:       String = ""
    @State private var showSearchPage:   Bool   = false

    // Client-side filters
    @State private var filterMinPrice:     Double? = nil
    @State private var filterMaxPrice:     Double? = nil
    @State private var filterMinBedrooms:  Int?    = nil
    @State private var filterMinBathrooms: Int?    = nil
    @State private var filterAmenities:    Set<String> = []
    @State private var filterHomeType:     String? = nil

    // Price mode: "range" or "payment"
    @State private var priceMode:        String = "range"

    // Mortgage calculator
    @State private var mortgagePrice:    String = ""
    @State private var mortgageDown:     String = ""
    @State private var mortgageYears:    String = "30"
    @State private var mortgageRate:     String = "9.5"

    // Location
    @StateObject private var locationManager = LocationManager()
    @State private var centerOnUser          = false
    @State private var targetCoordinate: CLLocationCoordinate2D? = nil
    @State private var targetZoom: Double = 35_000
    @State private var searchCenter: CLLocationCoordinate2D? = nil
    @State private var searchRadius: Double = 0 // km

    // Pin overlay
    @StateObject private var mapState = MapStateStore()

    // Zillow-style bottom sheet — uses native presentationDetents
    @State private var showListSheet = true
    @State private var listDetent: PresentationDetent = .height(60)

    // Detail nav
    @State private var detailListingID: String? = nil

    // Compare
    @StateObject private var compareManager = CompareManager.shared
    @State private var showCompare = false

    // Location denial alert
    @State private var showLocationDeniedAlert = false

    // MARK: - Computed: filtered listings
    private var filteredListings: [Listing] {
        listings.filter { listing in
            // Radius filter — only show properties within the search radius
            if let center = searchCenter, searchRadius > 0,
               let lat = listing.lat, let lng = listing.lng {
                let listingLoc = CLLocation(latitude: lat, longitude: lng)
                let centerLoc  = CLLocation(latitude: center.latitude, longitude: center.longitude)
                let distanceKm = listingLoc.distance(from: centerLoc) / 1000.0
                if distanceKm > searchRadius { return false }
            }
            if let min = filterMinPrice, let p = Double(listing.price), p < min { return false }
            if let max = filterMaxPrice, let p = Double(listing.price), p > max { return false }
            if let minB = filterMinBedrooms,
               let b = listing.bedrooms, let bi = Int(b), bi < minB { return false }
            if let minB = filterMinBathrooms,
               let b = listing.bathrooms, let bi = Int(b), bi < minB { return false }
            if let ht = filterHomeType {
                let haystack = (listing.title + " " + (listing.condition ?? "")
                                + " " + (listing.tags?.joined(separator: " ") ?? "")).lowercased()
                if !haystack.contains(ht.lowercased()) { return false }
            }
            if !filterAmenities.isEmpty {
                let has = Set(listing.amenities.map { $0.lowercased() })
                for a in filterAmenities { if !has.contains(a.lowercased()) { return false } }
            }
            return true
        }
    }

    /// Compute search radius (km) based on zoom level of location
    /// Smaller zoom = neighborhood (tighter radius), larger zoom = province (wider)
    private static func radiusForZoom(_ zoom: Double) -> Double {
        switch zoom {
        case ...4_000:   return 3     // tight neighborhood (~3 km)
        case ...8_000:   return 5     // neighborhood / sector (~5 km)
        case ...15_000:  return 10    // city area (~10 km)
        case ...30_000:  return 20    // large city (~20 km)
        case ...50_000:  return 35    // metro area (~35 km)
        default:         return 50    // province-wide (~50 km)
        }
    }

    /// Pins filtered by search radius (same logic as filteredListings but for map)
    private var filteredPins: [Listing] {
        // Cap pins to prevent map rendering slowdown on older devices
        let source: [Listing]
        if let center = searchCenter, searchRadius > 0 {
            let centerLoc = CLLocation(latitude: center.latitude, longitude: center.longitude)
            source = pins.filter { listing in
                guard let lat = listing.lat, let lng = listing.lng else { return false }
                let dist = CLLocation(latitude: lat, longitude: lng).distance(from: centerLoc) / 1000.0
                return dist <= searchRadius
            }
        } else {
            source = pins
        }
        return Array(source.prefix(200))
    }

    private var activeFilterCount: Int {
        var c = 0
        if filterMinPrice != nil  { c += 1 }
        if filterMaxPrice != nil  { c += 1 }
        if filterMinBedrooms != nil { c += 1 }
        if filterMinBathrooms != nil { c += 1 }
        if filterHomeType != nil  { c += 1 }
        if !filterAmenities.isEmpty { c += 1 }
        if selectedType != "venta" { c += 1 }
        return c
    }

    /// Standard amortization: M = P[r(1+r)^n] / [(1+r)^n - 1]
    private var monthlyPayment: Double? {
        let priceVal  = Double(mortgagePrice) ?? 0
        let downVal   = Double(mortgageDown)  ?? 0
        let yearsVal  = Double(mortgageYears) ?? 0
        let rateVal   = Double(mortgageRate)  ?? 0
        let principal = priceVal - downVal
        guard principal > 0, yearsVal > 0, rateVal > 0 else { return nil }
        let r = (rateVal / 100.0) / 12.0
        let n = yearsVal * 12.0
        let factor = pow(1 + r, n)
        return principal * (r * factor) / (factor - 1)
    }

    // MARK: - body
    var body: some View {
        ZStack(alignment: .top) {
            mapContent
                .ignoresSafeArea()

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    searchBarButton
                    filterIconButton
                }
                .padding(.top, 56)
                .padding(.horizontal, 16)

            }
            .zIndex(2)
        }
        .ignoresSafeArea(edges: .top)
        .onAppear     { selectedType = initialType }
        .onChange(of: selectedType) { Task { await load(reset: true) } }
        .task         { await load(reset: true) }
        .sheet(isPresented: $showFilters) { filterSheet }
        .fullScreenCover(isPresented: $showSearchPage) {
            SearchPageView(
                searchText: $searchText,
                filterProvince: $filterProvince,
                searchCenter: $searchCenter,
                searchRadius: $searchRadius,
                targetCoordinate: $targetCoordinate,
                targetZoom: $targetZoom,
                onSelect: {
                    showSearchPage = false
                    Task { await load(reset: true) }
                },
                onClear: {
                    showSearchPage = false
                    Task { await load(reset: true) }
                }
            )
        }
        .sheet(isPresented: Binding(
            get:  { detailListingID != nil },
            set:  { if !$0 { detailListingID = nil } }
        )) {
            if let id = detailListingID {
                NavigationStack { ListingDetailView(id: id) }
            }
        }
        .sheet(isPresented: $showCompare) {
            ComparisonView(selectedIds: $compareManager.selectedIds)
        }
        .overlay(alignment: .bottom) {
            if !compareManager.selectedIds.isEmpty {
                compareFloatingBar
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .animation(.spring(response: 0.35), value: compareManager.selectedIds.count)
            }
        }
        .alert("Ubicacion desactivada", isPresented: $showLocationDeniedAlert) {
            Button("Cancelar", role: .cancel) {}
            Button("Abrir Ajustes") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
        } message: {
            Text("Para mostrarte propiedades cerca de ti, HogaresRD necesita acceso a tu ubicacion. Puedes habilitarla en Ajustes.")
        }
        // ── Zillow-style bottom sheet ─────────────────────────────
        .sheet(isPresented: .constant(true)) {
            listSheetContent
                .presentationDetents(
                    [.height(60), .medium, .large],
                    selection: $listDetent
                )
                .presentationDragIndicator(.visible)
                .presentationBackgroundInteraction(.enabled(upThrough: .large))
                .presentationCornerRadius(16)
                .interactiveDismissDisabled()
        }
    }

    // Tab bar height estimate
    private let tabBarHeight: CGFloat = 83

    // MARK: - Map content
    @ViewBuilder
    private var mapContent: some View {
        ZStack(alignment: .bottom) {
            NativeMapView(
                listings:     filteredPins,
                selected:     $selectedListing,
                centerOnUser: $centerOnUser,
                userLocation: locationManager.location,
                targetCoordinate: $targetCoordinate,
                targetZoom:   targetZoom,
                mapState:     mapState
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea()

            pinOverlay

            // Floating callout card when a pin is selected
            if let sel = selectedListing,
               let pair = mapState.pinScreenPositions.first(where: { $0.0.id == sel.id }) {
                mapCalloutCard(listing: pair.0, pinPoint: pair.1)
            }

            // Location button
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    locationButton
                        .padding(.trailing, 16)
                        .padding(.bottom, 16)
                }
            }
        }
        .onTapGesture {
            if selectedListing != nil {
                withAnimation(.spring(response: 0.25)) { selectedListing = nil }
            }
        }
    }

    // MARK: - Zillow-Style Sheet Content
    @ViewBuilder
    private var listSheetContent: some View {
        VStack(spacing: 0) {
            // Peek header — always visible, shows count
            HStack {
                if loading && listings.isEmpty {
                    Text("Cargando propiedades...")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Text("\(filteredListings.count) propiedades")
                        .font(.subheadline.bold())
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 10)

            Divider()

            // Scrollable list
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        ForEach(filteredListings) { listing in
                            ListingRow(listing: listing,
                                       isSelected: listing.id == selectedListing?.id)
                            .id("row_\(listing.id)")
                            .onTapGesture { detailListingID = listing.id }
                            .onAppear {
                                if listing.id == filteredListings.last?.id, page < totalPages {
                                    Task { await loadMore() }
                                }
                            }
                        }
                        listFooter
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 20)
                }
                .onChange(of: selectedListing) { listing in
                    if let id = listing?.id {
                        withAnimation { proxy.scrollTo("row_\(id)", anchor: .center) }
                    }
                }
            }
        }
    }

    // MARK: - Pin overlay
    @ViewBuilder
    private var pinOverlay: some View {
        GeometryReader { geo in
            ForEach(mapState.pinScreenPositions, id: \.0.id) { listing, point in
                MapPinLabel(
                    listing:    listing,
                    isSelected: listing.id == selectedListing?.id
                )
                .position(x: point.x, y: point.y - 17)
                .onTapGesture {
                    withAnimation(.spring(response: 0.25)) {
                        selectedListing = (selectedListing?.id == listing.id) ? nil : listing
                    }
                }
                .zIndex(listing.id == selectedListing?.id ? 10 : Double(point.y))
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(true)
    }

    // MARK: - Map callout card  (Zillow-style floating card)
    @ViewBuilder
    private func mapCalloutCard(listing: Listing, pinPoint: CGPoint) -> some View {
        GeometryReader { geo in
            let cardW: CGFloat = 300
            let cardH: CGFloat = 200
            // Position card above the pin, clamped to screen edges
            let rawX  = pinPoint.x - cardW / 2
            let clampedX = max(10, min(geo.size.width - cardW - 10, rawX))
            let yPos  = pinPoint.y - cardH - 40  // above pin + triangle

            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    // Image
                    ZStack(alignment: .topLeading) {
                        AsyncImage(url: listing.firstImageURL) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().scaledToFill()
                            default:
                                Rectangle()
                                    .fill(Color.rdBlue.opacity(0.07))
                                    .overlay(Image(systemName: "photo")
                                                .font(.title2)
                                                .foregroundStyle(Color.rdBlue.opacity(0.2)))
                            }
                        }
                        .frame(width: cardW, height: 110)
                        .clipped()

                        // Heart / save button
                        Image(systemName: "heart")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }

                    // Info
                    VStack(alignment: .leading, spacing: 3) {
                        Text(listing.priceFormatted)
                            .font(.headline.bold())
                        HStack(spacing: 10) {
                            if let b = listing.bedrooms, !b.isEmpty {
                                Text("\(b) bds").font(.caption)
                            }
                            if let b = listing.bathrooms, !b.isEmpty {
                                Text("\(b) ba").font(.caption)
                            }
                            if let a = listing.area_const, !a.isEmpty {
                                Text("\(a) m²").font(.caption)
                            }
                        }
                        .foregroundStyle(.secondary)
                        if let city = listing.city, let prov = listing.province {
                            Text("\(city), \(prov)")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                }
                .frame(width: cardW)
                .background(Color(.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .shadow(color: .black.opacity(0.2), radius: 10, y: 4)

                // Triangle pointer
                PinTriangle()
                    .fill(Color(.systemBackground))
                    .frame(width: 14, height: 8)
                    .shadow(color: .black.opacity(0.1), radius: 2, y: 2)
                    // Offset triangle to point at the pin
                    .offset(x: pinPoint.x - clampedX - cardW / 2)
            }
            .position(x: clampedX + cardW / 2, y: max(cardH / 2 + 60, yPos + cardH / 2))
            .onTapGesture { detailListingID = listing.id }
            .transition(.scale(scale: 0.85).combined(with: .opacity))
            .zIndex(100)
        }
        .ignoresSafeArea()
    }

    // Dead code removed — replaced by native presentationDetents sheet

    // MARK: - List footer content (used by listSheetContent)
    @ViewBuilder
    private var expandedListContentLegacy: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                ForEach(filteredListings) { listing in
                    ListingRow(listing: listing, isSelected: listing.id == selectedListing?.id)
                    .id("row_\(listing.id)")
                    .onTapGesture { detailListingID = listing.id }
                }
                listFooter
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 80)
        }
    }

    // MARK: - List footer
    private var listFooter: some View {
        VStack(spacing: 12) {
            Divider().padding(.horizontal, 20)

            VStack(spacing: 8) {
                Image(systemName: "house.fill")
                    .font(.title3)
                    .foregroundStyle(Color.rdBlue.opacity(0.4))

                Text("HogaresRD")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)

                Text("Los listados pueden estar sujetos a cambios de precio y disponibilidad. Verifica la información directamente con el agente antes de tomar decisiones.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)

                HStack(spacing: 16) {
                    Link("Términos", destination: URL(string: "https://hogaresrd.com/terminos")!)
                        .font(.caption2.bold())
                        .foregroundStyle(Color.rdBlue)
                    Text("·").foregroundStyle(.tertiary)
                    Link("Privacidad", destination: URL(string: "https://hogaresrd.com/privacidad")!)
                        .font(.caption2.bold())
                        .foregroundStyle(Color.rdBlue)
                    Text("·").foregroundStyle(.tertiary)
                    Link("Ayuda", destination: URL(string: "https://hogaresrd.com/contacto")!)
                        .font(.caption2.bold())
                        .foregroundStyle(Color.rdBlue)
                }
                .padding(.top, 4)
            }
            .padding(.vertical, 16)
        }
        .padding(.top, 8)
    }

    // MARK: - UI elements
    private var locationButton: some View {
        Button {
            if locationManager.isDeniedOrRestricted {
                showLocationDeniedAlert = true
            } else {
                locationManager.requestLocation()
                centerOnUser = true
            }
        } label: {
            Image(systemName: "location.fill")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.rdBlue)
                .frame(width: 44, height: 44)
                .background(Color(.systemBackground).opacity(0.95), in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        }
    }

    // MARK: - Search bar (tappable — opens search page)
    private var searchBarButton: some View {
        Button {
            showSearchPage = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Color.rdBlue)
                if searchText.isEmpty {
                    Text("Buscar provincia, ciudad...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text(searchText)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                }
                Spacer()
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        filterProvince = nil
                        searchCenter = nil
                        searchRadius = 0
                        Task { await load(reset: true) }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
    }

    private var filterIconButton: some View {
        Button { showFilters = true } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(activeFilterCount > 0 ? .white : Color.rdBlue)
                    .frame(width: 44, height: 44)
                    .background(
                        activeFilterCount > 0
                            ? AnyShapeStyle(Color.rdBlue)
                            : AnyShapeStyle(Color(.systemBackground).opacity(0.95)),
                        in: RoundedRectangle(cornerRadius: 12)
                    )
                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)

                if activeFilterCount > 0 {
                    Text("\(activeFilterCount)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 18, height: 18)
                        .background(Color.rdRed, in: Circle())
                        .offset(x: 4, y: -4)
                }
            }
        }
    }

    // (Lista view removed — listings accessible via swipe-up sheet)

    // MARK: - Filter sheet (comprehensive – no location)
    private var filterSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    // ── Listing type ─────────────────────────────────
                    FilterSection(title: "Tipo de Listado") {
                        HStack(spacing: 10) {
                            ForEach([("venta", "Comprar"), ("alquiler", "Alquilar"), ("proyecto", "Proyectos")],
                                     id: \.0) { val, label in
                                FilterChip(label: label, isActive: selectedType == val) {
                                    selectedType = val
                                }
                            }
                        }
                    }

                    // ── Home type ─────────────────────────────────────
                    FilterSection(title: "Tipo de Inmueble") {
                        let homeTypes: [(String, String)] = [
                            ("Apartamento", "building.2.fill"),
                            ("Casa",        "house.fill"),
                            ("Penthouse",   "building.fill"),
                            ("Villa",       "house.lodge.fill"),
                            ("Solar",       "square.dashed"),
                            ("Local",       "storefront.fill"),
                            ("Oficina",     "briefcase.fill"),
                            ("Finca",       "tree.fill"),
                        ]
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            AmenityChip(name: "Todos", icon: "square.grid.2x2.fill",
                                        isActive: filterHomeType == nil) {
                                filterHomeType = nil
                            }
                            ForEach(homeTypes, id: \.0) { name, icon in
                                AmenityChip(name: name, icon: icon,
                                            isActive: filterHomeType == name) {
                                    filterHomeType = (filterHomeType == name) ? nil : name
                                }
                            }
                        }
                    }

                    // ── Price (toggle: range vs payment) ─────────────
                    FilterSection(title: "Precio") {
                        VStack(spacing: 14) {
                            // Toggle
                            HStack(spacing: 0) {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) { priceMode = "range" }
                                } label: {
                                    Text("Rango de Precio")
                                        .font(.subheadline.weight(priceMode == "range" ? .bold : .regular))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .foregroundStyle(priceMode == "range" ? .white : .primary)
                                        .background(priceMode == "range" ? Color.rdBlue : Color(.secondarySystemFill),
                                                    in: RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)

                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) { priceMode = "payment" }
                                } label: {
                                    Text("Pago Mensual")
                                        .font(.subheadline.weight(priceMode == "payment" ? .bold : .regular))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .foregroundStyle(priceMode == "payment" ? .white : .primary)
                                        .background(priceMode == "payment" ? Color.rdBlue : Color(.secondarySystemFill),
                                                    in: RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)
                            }

                            if priceMode == "range" {
                                HStack(spacing: 12) {
                                    PriceField(label: "Mínimo", value: $filterMinPrice)
                                    PriceField(label: "Máximo", value: $filterMaxPrice)
                                }
                                .transition(.opacity.combined(with: .move(edge: .leading)))
                            } else {
                                VStack(spacing: 12) {
                                    HStack(spacing: 12) {
                                        MortgageField(label: "Precio (USD)", text: $mortgagePrice, icon: "dollarsign")
                                        MortgageField(label: "Inicial (USD)", text: $mortgageDown, icon: "arrow.down.to.line")
                                    }
                                    HStack(spacing: 12) {
                                        MortgageField(label: "Años", text: $mortgageYears, icon: "calendar")
                                        MortgageField(label: "Tasa %", text: $mortgageRate, icon: "percent")
                                    }

                                    if let mp = monthlyPayment {
                                        VStack(spacing: 4) {
                                            Text("Pago Mensual Estimado")
                                                .font(.caption).foregroundStyle(.secondary)
                                            Text(formatCurrency(mp))
                                                .font(.title2.bold())
                                                .foregroundStyle(Color.rdGreen)
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                        .background(Color.rdGreen.opacity(0.08),
                                                    in: RoundedRectangle(cornerRadius: 12))
                                    } else {
                                        Text("Ingresa precio, inicial, años y tasa para calcular")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 12)
                                    }
                                }
                                .transition(.opacity.combined(with: .move(edge: .trailing)))
                            }
                        }
                    }

                    // ── Bedrooms ──────────────────────────────────────
                    FilterSection(title: "Habitaciones") {
                        HStack(spacing: 8) {
                            ForEach([nil, 1, 2, 3, 4, 5] as [Int?], id: \.self) { val in
                                FilterChip(
                                    label: val == nil ? "Todas" : "\(val!)+",
                                    isActive: filterMinBedrooms == val
                                ) { filterMinBedrooms = val }
                            }
                        }
                    }

                    // ── Bathrooms ─────────────────────────────────────
                    FilterSection(title: "Baños") {
                        HStack(spacing: 8) {
                            ForEach([nil, 1, 2, 3, 4] as [Int?], id: \.self) { val in
                                FilterChip(
                                    label: val == nil ? "Todos" : "\(val!)+",
                                    isActive: filterMinBathrooms == val
                                ) { filterMinBathrooms = val }
                            }
                        }
                    }

                    // ── Amenities ─────────────────────────────────────
                    FilterSection(title: "Amenidades") {
                        let allAmenities = [
                            ("Piscina", "figure.pool.swim"),
                            ("Aire Acondicionado", "snowflake"),
                            ("Parqueo", "car.fill"),
                            ("Seguridad", "shield.checkered"),
                            ("Gimnasio", "dumbbell.fill"),
                            ("Terraza", "sun.max.fill"),
                            ("Jardín", "leaf.fill"),
                            ("Elevador", "arrow.up.arrow.down"),
                            ("Área Social", "person.3.fill"),
                            ("Planta Eléctrica", "bolt.fill"),
                            ("Lobby", "building.2.fill"),
                            ("Jacuzzi", "drop.fill"),
                        ]
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            ForEach(allAmenities, id: \.0) { name, icon in
                                AmenityChip(name: name, icon: icon,
                                            isActive: filterAmenities.contains(name)) {
                                    if filterAmenities.contains(name) {
                                        filterAmenities.remove(name)
                                    } else {
                                        filterAmenities.insert(name)
                                    }
                                }
                            }
                        }
                    }

                    Color.clear.frame(height: 80)
                }
                .padding(.horizontal, 16)
            }
            .navigationTitle("Filtros")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { showFilters = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Limpiar") {
                        filterMinPrice = nil; filterMaxPrice = nil
                        filterMinBedrooms = nil; filterMinBathrooms = nil
                        filterAmenities = []; filterHomeType = nil
                        selectedType = "venta"; priceMode = "range"
                        mortgagePrice = ""; mortgageDown = ""
                        mortgageYears = "30"; mortgageRate = "9.5"
                    }
                    .foregroundStyle(Color.rdRed)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    showFilters = false
                    Task { await load(reset: true) }
                } label: {
                    Text("Ver \(filteredListings.count) propiedades")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 14))
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                .background(.regularMaterial)
            }
        }
        .presentationDetents([.large])
    }

    // (Location sheet removed — replaced by inline search suggestions)

    private func formatCurrency(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "$\(Int(value))"
    }

    // MARK: - Data loading
    private func load(reset: Bool) async {
        if reset { page = 1; listings = []; pins = [] }
        loading = true; error = nil
        do {
            let res = try await APIService.shared.getListings(
                type: selectedType, province: filterProvince, limit: 20, page: page
            )
            listings   = res.listings
            totalPages = res.pages
            pins       = res.listings.filter { $0.lat != nil && $0.lng != nil }
        } catch {
            self.error = "No se pudieron cargar las propiedades. Verifica tu conexión."
        }
        loading = false
    }

    private func loadMore() async {
        guard !loading else { return }
        page += 1; loading = true
        if let res = try? await APIService.shared.getListings(
            type: selectedType, province: filterProvince, limit: 20, page: page
        ) {
            listings.append(contentsOf: res.listings)
            pins.append(contentsOf: res.listings.filter { $0.lat != nil && $0.lng != nil })
        }
        loading = false
    }

    // MARK: - Compare floating bar
    private var compareFloatingBar: some View {
        HStack(spacing: 12) {
            Image(systemName: "square.split.2x1.fill")
                .foregroundColor(.white)
            Text("Comparar (\(compareManager.selectedIds.count)/\(compareManager.maxItems))")
                .font(.subheadline.bold())
                .foregroundColor(.white)
            Spacer()
            Button {
                compareManager.clear()
            } label: {
                Text("Limpiar")
                    .font(.caption.bold())
                    .foregroundColor(.white.opacity(0.8))
            }
            Button {
                showCompare = true
            } label: {
                Text("Ver")
                    .font(.caption.bold())
                    .foregroundColor(.rdBlue)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(Color.white)
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color.rdBlue)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
        .padding(.horizontal, 16)
        .padding(.bottom, tabBarHeight + 8)
    }
}

// ────────────────────────────────────────────────────────────────────────────
// MARK: - Single-column Listing Row  (large image, full-width)
// ────────────────────────────────────────────────────────────────────────────
struct ListingRow: View {
    let listing: Listing
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Large image
            ZStack {
                AsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFill()
                    default:
                        Rectangle()
                            .fill(Color.rdBlue.opacity(0.07))
                            .overlay(Image(systemName: "photo")
                                        .font(.largeTitle)
                                        .foregroundStyle(Color.rdBlue.opacity(0.2)))
                    }
                }
                .frame(height: 190)
                .clipped()

                // Badges overlay
                VStack {
                    HStack {
                        // Type badge
                        Text(listing.typeLabel)
                            .font(.system(size: 10, weight: .bold))
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(
                                listing.type == "venta"    ? Color.rdGreen :
                                listing.type == "alquiler" ? Color.rdBlue  : Color.rdRed
                            )
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        Spacer()
                    }
                    Spacer()
                    HStack {
                        // Compare button
                        Button {
                            let _ = CompareManager.shared.toggle(listing.id)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "square.split.2x1")
                                    .font(.system(size: 10))
                                Text(CompareManager.shared.isSelected(listing.id) ? "Comparando" : "Comparar")
                                    .font(.system(size: 10, weight: .semibold))
                            }
                            .foregroundColor(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(
                                CompareManager.shared.isSelected(listing.id)
                                    ? Color.rdBlue
                                    : Color.black.opacity(0.55)
                            )
                            .clipShape(Capsule())
                        }
                        Spacer()
                    }
                }
                .padding(10)
            }

            // Info block
            VStack(alignment: .leading, spacing: 6) {
                Text(listing.priceFormatted)
                    .font(.title3.bold())
                    .foregroundStyle(Color.rdBlue)

                Text(listing.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .foregroundStyle(.primary)

                if let city = listing.city, let prov = listing.province {
                    Label("\(city), \(prov)", systemImage: "mappin.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let city = listing.city {
                    Label(city, systemImage: "mappin.circle.fill")
                        .font(.caption).foregroundStyle(.secondary)
                }

                // Stats row
                HStack(spacing: 14) {
                    if let b = listing.bedrooms, !b.isEmpty {
                        Label(b, systemImage: "bed.double.fill")
                            .font(.caption.bold())
                    }
                    if let b = listing.bathrooms, !b.isEmpty {
                        Label(b, systemImage: "shower.fill")
                            .font(.caption.bold())
                    }
                    if let a = listing.area_const, !a.isEmpty {
                        Label("\(a) m²", systemImage: "ruler")
                            .font(.caption.bold())
                    }
                    if let p = listing.parking, !p.isEmpty {
                        Label(p, systemImage: "car.fill")
                            .font(.caption.bold())
                    }
                }
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isSelected ? Color.rdBlue : Color.clear, lineWidth: 2.5)
        )
        .shadow(color: isSelected ? Color.rdBlue.opacity(0.30) : Color.black.opacity(0.08),
                radius: isSelected ? 14 : 8, y: isSelected ? 6 : 3)
        .scaleEffect(isSelected ? 1.015 : 1.0)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isSelected)
    }
}

// ────────────────────────────────────────────────────────────────────────────
// MARK: - Peek Card (horizontal scroll in collapsed sheet)
// ────────────────────────────────────────────────────────────────────────────
struct PeekCard: View {
    let listing: Listing
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            AsyncImage(url: listing.firstImageURL) { phase in
                switch phase {
                case .success(let img): img.resizable().scaledToFill()
                default:
                    Rectangle()
                        .fill(Color.rdBlue.opacity(0.08))
                        .overlay(Image(systemName: "house.fill")
                                    .foregroundStyle(Color.rdBlue.opacity(0.3)))
                }
            }
            .frame(width: 90, height: 92)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 3) {
                Text(listing.priceFormatted)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdBlue)
                Text(listing.title)
                    .font(.caption).bold().lineLimit(2)
                    .foregroundStyle(.primary)
                if let city = listing.city {
                    Label(city, systemImage: "mappin.circle")
                        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack(spacing: 8) {
                    if let b = listing.bedrooms, !b.isEmpty {
                        Label(b, systemImage: "bed.double").font(.system(size: 9))
                    }
                    if let b = listing.bathrooms, !b.isEmpty {
                        Label(b, systemImage: "shower").font(.system(size: 9))
                    }
                }
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.bold()).foregroundStyle(.tertiary).padding(.trailing, 4)
        }
        .padding(10)
        .frame(width: 300, height: 112)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16)
                    .stroke(isSelected ? Color.rdBlue : .clear, lineWidth: 2))
        .shadow(color: isSelected ? Color.rdBlue.opacity(0.25) : .black.opacity(0.10),
                radius: isSelected ? 12 : 8, y: 3)
        .scaleEffect(isSelected ? 1.03 : 1.0)
        .animation(.spring(response: 0.25, dampingFraction: 0.75), value: isSelected)
    }
}

// ────────────────────────────────────────────────────────────────────────────
// MARK: - MapPinLabel
// ────────────────────────────────────────────────────────────────────────────
struct MapPinLabel: View {
    let listing: Listing; let isSelected: Bool

    var body: some View {
        VStack(spacing: 0) {
            Text(listing.shortPrice)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(isSelected ? Color.rdRed : Color.rdBlue, in: Capsule())
                .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
                .scaleEffect(isSelected ? 1.15 : 1.0)
                .animation(.spring(response: 0.25, dampingFraction: 0.65), value: isSelected)

            PinTriangle()
                .fill(isSelected ? Color.rdRed : Color.rdBlue)
                .frame(width: 10, height: 6)
                .animation(.spring(response: 0.25, dampingFraction: 0.65), value: isSelected)
        }
    }
}

private struct PinTriangle: Shape {
    func path(in rect: CGRect) -> Path {
        Path {
            $0.move(to: CGPoint(x: rect.midX, y: rect.maxY))
            $0.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
            $0.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            $0.closeSubpath()
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// MARK: - Filter UI components
// ────────────────────────────────────────────────────────────────────────────
private struct FilterSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
                .padding(.top, 20)
            content
        }
    }
}

private struct FilterChip: View {
    let label: String
    let isActive: Bool
    var full: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(isActive ? .bold : .regular))
                .lineLimit(1).minimumScaleFactor(0.7)
                .padding(.horizontal, full ? 6 : 14)
                .padding(.vertical, 9)
                .frame(maxWidth: full ? .infinity : nil)
                .foregroundStyle(isActive ? .white : .primary)
                .background(isActive ? Color.rdBlue : Color(.secondarySystemFill),
                            in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

private struct AmenityChip: View {
    let name: String; let icon: String; let isActive: Bool; let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                Text(name)
                    .font(.caption.weight(isActive ? .bold : .regular))
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .frame(maxWidth: .infinity)
            .foregroundStyle(isActive ? .white : .primary)
            .background(isActive ? Color.rdBlue : Color(.secondarySystemFill),
                        in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

private struct MortgageField: View {
    let label: String
    @Binding var text: String
    let icon: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(Color.rdBlue)
                .frame(width: 18)
            TextField(label, text: $text)
                .keyboardType(.decimalPad)
                .font(.subheadline)
        }
        .padding(10)
        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct PriceField: View {
    let label: String
    @Binding var value: Double?

    @State private var text = ""

    var body: some View {
        TextField(label, text: $text)
            .keyboardType(.numberPad)
            .padding(10)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
            .onChange(of: text) { v in
                let clean = v.filter { $0.isNumber }
                value = clean.isEmpty ? nil : Double(clean)
            }
            .onAppear {
                if let v = value { text = String(format: "%.0f", v) }
            }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// MARK: - GridCard  (2-column card — used by CitiesView, AgencyPortfolio, SavedListings)
// ────────────────────────────────────────────────────────────────────────────
struct GridCard: View {
    let listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                AsyncImage(url: listing.firstImageURL) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFill()
                    default:
                        Rectangle()
                            .fill(Color.rdBlue.opacity(0.07))
                            .overlay(Image(systemName: "photo")
                                        .font(.title2)
                                        .foregroundStyle(Color.rdBlue.opacity(0.2)))
                    }
                }
                .frame(height: 130)
                .clipped()

                Text(listing.typeLabel)
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(
                        listing.type == "venta"    ? Color.rdGreen :
                        listing.type == "alquiler" ? Color.rdBlue  : Color.rdRed
                    )
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                    .padding(6)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(listing.priceFormatted)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdBlue)
                Text(listing.title)
                    .font(.caption).bold().lineLimit(2)
                    .foregroundStyle(.primary)
                if let city = listing.city {
                    Label(city, systemImage: "mappin.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    if let b = listing.bedrooms, !b.isEmpty {
                        Label(b, systemImage: "bed.double").font(.system(size: 9))
                    }
                    if let b = listing.bathrooms, !b.isEmpty {
                        Label(b, systemImage: "shower").font(.system(size: 9))
                    }
                }
                .foregroundStyle(.secondary)
            }
            .padding(8)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
    }
}

// MARK: - Province list
// MARK: - Location data model
struct LocationSuggestion: Identifiable {
    let id = UUID()
    let name: String
    let province: String
    let icon: String
    let popular: Bool
    let lat: Double
    let lng: Double
    let zoom: Double  // meters for region span
}

// MARK: - Full-screen Search Page
struct SearchPageView: View {
    @Binding var searchText: String
    @Binding var filterProvince: String?
    @Binding var searchCenter: CLLocationCoordinate2D?
    @Binding var searchRadius: Double
    @Binding var targetCoordinate: CLLocationCoordinate2D?
    @Binding var targetZoom: Double
    var onSelect: () -> Void
    var onClear: () -> Void

    @State private var query: String = ""
    @FocusState private var fieldFocused: Bool
    @Environment(\.dismiss) private var dismiss
    @StateObject private var completer = LocationSearchCompleter()
    @State private var resolvingMapItem = false

    /// Local (static) matches from our curated DR list — fast, instant.
    private var localSuggestions: [LocationSuggestion] {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return [] }
        return drLocationData.filter {
            $0.name.lowercased().contains(q) ||
            $0.province.lowercased().contains(q)
        }.prefix(6).map { $0 }
    }

    private var popularLocations: [LocationSuggestion] {
        drLocationData.filter { $0.popular }
    }

    private var provinces: [LocationSuggestion] {
        drLocationData.filter { $0.icon == "mappin.circle.fill" }
    }

    /// Compute search radius (km) based on zoom level of location
    private static func radiusForZoom(_ zoom: Double) -> Double {
        switch zoom {
        case ...4_000:   return 3
        case ...8_000:   return 5
        case ...15_000:  return 10
        case ...30_000:  return 20
        case ...50_000:  return 35
        default:         return 50
        }
    }

    private func select(_ suggestion: LocationSuggestion) {
        searchText = suggestion.name
        filterProvince = suggestion.province
        targetZoom = suggestion.zoom
        targetCoordinate = CLLocationCoordinate2D(latitude: suggestion.lat, longitude: suggestion.lng)
        searchCenter = CLLocationCoordinate2D(latitude: suggestion.lat, longitude: suggestion.lng)
        searchRadius = Self.radiusForZoom(suggestion.zoom)
        onSelect()
    }

    /// Resolve an Apple-Maps suggestion to coordinates + center the map.
    /// Uses MKLocalSearch, same engine Apple Maps uses.
    private func selectCompletion(_ completion: MKLocalSearchCompletion) {
        resolvingMapItem = true
        Task {
            guard let item = await completer.resolve(completion) else {
                await MainActor.run { resolvingMapItem = false }
                return
            }
            let coord = item.placemark.coordinate
            // Choose a zoom that roughly matches the result granularity:
            // specific pin → tight (2km), town/sector → medium (5km),
            // city/province → wide (15km).
            let zoom: Double
            let subtitle = completion.subtitle.lowercased()
            if completion.title.count < 25 && !subtitle.contains("provincia") {
                zoom = 5_000
            } else if subtitle.isEmpty {
                zoom = 2_500
            } else {
                zoom = 12_000
            }
            await MainActor.run {
                searchText = completion.title
                filterProvince = nil // Apple Maps results may cross provinces
                targetZoom = zoom
                targetCoordinate = coord
                searchCenter = coord
                searchRadius = Self.radiusForZoom(zoom)
                resolvingMapItem = false
                onSelect()
            }
        }
    }

    private func clearSearch() {
        searchText = ""
        filterProvince = nil
        searchCenter = nil
        searchRadius = 0
        onClear()
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Search field
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Color.rdBlue)
                    TextField("Buscar provincia, ciudad, sector...", text: $query)
                        .font(.subheadline)
                        .focused($fieldFocused)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)
                        .onChange(of: query) { _, newVal in
                            completer.updateQuery(newVal)
                        }
                        .onSubmit {
                            if let first = localSuggestions.first {
                                select(first)
                            } else if let first = completer.results.first {
                                selectCompletion(first)
                            }
                        }
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16)
                .padding(.top, 8)

                // Results
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if !query.isEmpty {
                            // 1. Local curated matches (fast, instant)
                            if !localSuggestions.isEmpty {
                                ForEach(localSuggestions) { s in
                                    suggestionRow(s)
                                }
                                Divider().padding(.leading, 68).padding(.top, 4)
                            }
                            // 2. Apple Maps live results (same engine as Apple Maps —
                            //    finds any town/barrio/POI in DR, e.g. "Lucerna")
                            if completer.isSearching && completer.results.isEmpty {
                                HStack(spacing: 8) {
                                    ProgressView().scaleEffect(0.7)
                                    Text("Buscando en Apple Maps…")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 20)
                            } else if completer.results.isEmpty && localSuggestions.isEmpty {
                                VStack(spacing: 12) {
                                    Image(systemName: "magnifyingglass")
                                        .font(.title).foregroundStyle(.tertiary)
                                    Text("No se encontraron resultados")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                }
                                .padding(.top, 60)
                            } else {
                                ForEach(completer.results, id: \.self) { r in
                                    appleSuggestionRow(r)
                                }
                            }
                        } else {
                            // All locations option
                            Button {
                                clearSearch()
                            } label: {
                                HStack(spacing: 12) {
                                    ZStack {
                                        Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 40, height: 40)
                                        Image(systemName: "mappin.and.ellipse")
                                            .foregroundStyle(Color.rdBlue)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Todas las ubicaciones")
                                            .font(.subheadline).bold()
                                            .foregroundStyle(.primary)
                                        Text("República Dominicana")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if filterProvince == nil {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(Color.rdBlue)
                                    }
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                            }

                            Divider().padding(.leading, 68)

                            // Popular locations
                            sectionHeader("Ubicaciones populares", icon: "star.fill")

                            ForEach(popularLocations) { s in
                                suggestionRow(s)
                            }

                            Divider().padding(.leading, 68).padding(.top, 4)

                            // Provinces
                            sectionHeader("Provincias", icon: "map.fill")

                            ForEach(provinces) { s in
                                suggestionRow(s)
                            }
                        }
                    }
                    .padding(.bottom, 40)
                }
                .padding(.top, 8)
            }
            .navigationTitle("Buscar ubicación")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.subheadline.bold())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .onAppear {
            query = ""
            fieldFocused = true
        }
    }

    // MARK: - Rows

    /// Row for an Apple Maps completion result.
    private func appleSuggestionRow(_ r: MKLocalSearchCompletion) -> some View {
        Button {
            selectCompletion(r)
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(Color.rdGreen.opacity(0.1)).frame(width: 40, height: 40)
                    Image(systemName: "mappin.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.rdGreen)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.title)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if !r.subtitle.isEmpty {
                        Text(r.subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if resolvingMapItem {
                    ProgressView().scaleEffect(0.6)
                } else {
                    Image(systemName: "arrow.up.right.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }

    private func suggestionRow(_ suggestion: LocationSuggestion) -> some View {
        Button {
            select(suggestion)
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 40, height: 40)
                    Image(systemName: suggestion.icon)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.rdBlue)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(suggestion.name)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    if suggestion.name != suggestion.province {
                        Text(suggestion.province)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if filterProvince == suggestion.province && searchText == suggestion.name {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.rdBlue)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.rdBlue)
            Text(title)
                .font(.caption).bold()
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 6)
    }
}

private let drLocationData: [LocationSuggestion] = [

    // ════════════════════════════════════════════════════════════════
    // POPULAR SECTORS (shown when search is empty)
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Piantini",             province: "Distrito Nacional",    icon: "building.2.fill", popular: true,  lat: 18.4722, lng: -69.9388, zoom: 3_000),
    LocationSuggestion(name: "Naco",                 province: "Distrito Nacional",    icon: "building.2.fill", popular: true,  lat: 18.4755, lng: -69.9335, zoom: 3_000),
    LocationSuggestion(name: "Bella Vista",          province: "Distrito Nacional",    icon: "building.2.fill", popular: true,  lat: 18.4690, lng: -69.9420, zoom: 3_000),
    LocationSuggestion(name: "Punta Cana",           province: "La Altagracia",       icon: "beach.umbrella",  popular: true,  lat: 18.5820, lng: -68.4055, zoom: 15_000),
    LocationSuggestion(name: "Bávaro",               province: "La Altagracia",       icon: "beach.umbrella",  popular: true,  lat: 18.6870, lng: -68.4540, zoom: 10_000),
    LocationSuggestion(name: "Juan Dolio",           province: "San Pedro de Macorís",icon: "beach.umbrella",  popular: true,  lat: 18.4280, lng: -69.4320, zoom: 8_000),
    LocationSuggestion(name: "Los Cacicazgos",       province: "Distrito Nacional",    icon: "building.2.fill", popular: true,  lat: 18.4650, lng: -69.9450, zoom: 3_000),
    LocationSuggestion(name: "Evaristo Morales",     province: "Distrito Nacional",    icon: "building.2.fill", popular: true,  lat: 18.4780, lng: -69.9310, zoom: 3_000),

    // ════════════════════════════════════════════════════════════════
    // DISTRITO NACIONAL — Sectors
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Gazcue",               province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4630, lng: -69.9230, zoom: 3_000),
    LocationSuggestion(name: "Arroyo Hondo",         province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4950, lng: -69.9500, zoom: 4_000),
    LocationSuggestion(name: "Ensanche Paraíso",     province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4590, lng: -69.9480, zoom: 3_000),
    LocationSuggestion(name: "La Esperilla",         province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4740, lng: -69.9360, zoom: 3_000),
    LocationSuggestion(name: "El Vergel",            province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4700, lng: -69.9290, zoom: 3_000),
    LocationSuggestion(name: "Renacimiento",         province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4830, lng: -69.9450, zoom: 3_000),
    LocationSuggestion(name: "Julieta Morales",      province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4790, lng: -69.9280, zoom: 3_000),
    LocationSuggestion(name: "Los Prados",           province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4830, lng: -69.9310, zoom: 3_000),
    LocationSuggestion(name: "La Julia",             province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4770, lng: -69.9370, zoom: 3_000),
    LocationSuggestion(name: "Zona Colonial",        province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4735, lng: -69.8850, zoom: 2_000),
    LocationSuggestion(name: "El Millón",            province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4880, lng: -69.9360, zoom: 3_000),
    LocationSuggestion(name: "Los Ríos",             province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4770, lng: -69.9530, zoom: 3_000),
    LocationSuggestion(name: "Ensanche Ozama",       province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4850, lng: -69.8720, zoom: 3_000),
    LocationSuggestion(name: "Ensanche Luperón",     province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4900, lng: -69.9430, zoom: 3_000),
    LocationSuggestion(name: "Villa Juana",          province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4740, lng: -69.9120, zoom: 3_000),
    LocationSuggestion(name: "Cristo Rey",           province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4900, lng: -69.9180, zoom: 3_000),
    LocationSuggestion(name: "Viejo Arroyo Hondo",   province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4980, lng: -69.9600, zoom: 4_000),
    LocationSuggestion(name: "Mirador Sur",          province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4550, lng: -69.9580, zoom: 3_000),
    LocationSuggestion(name: "Mirador Norte",        province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4970, lng: -69.9580, zoom: 3_000),
    LocationSuggestion(name: "Ensanche Quisqueya",   province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4820, lng: -69.9220, zoom: 3_000),
    LocationSuggestion(name: "San Gerónimo",         province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4670, lng: -69.9300, zoom: 2_500),
    LocationSuggestion(name: "Miraflores",           province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4850, lng: -69.9450, zoom: 3_000),
    LocationSuggestion(name: "Alma Rosa",            province: "Distrito Nacional",    icon: "building.2.fill", popular: false, lat: 18.4930, lng: -69.8600, zoom: 4_000),

    // ════════════════════════════════════════════════════════════════
    // SANTO DOMINGO (Province) — Municipalities & Sectors
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Santo Domingo Este",   province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.4880, lng: -69.8570, zoom: 12_000),
    LocationSuggestion(name: "Santo Domingo Norte",  province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5400, lng: -69.9100, zoom: 15_000),
    LocationSuggestion(name: "Santo Domingo Oeste",  province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.4900, lng: -69.9800, zoom: 12_000),
    LocationSuggestion(name: "Los Alcarrizos",       province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5130, lng: -70.0100, zoom: 8_000),
    LocationSuggestion(name: "Pedro Brand",          province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5300, lng: -70.0600, zoom: 10_000),
    LocationSuggestion(name: "Boca Chica",           province: "Santo Domingo",        icon: "beach.umbrella",  popular: false, lat: 18.4480, lng: -69.6060, zoom: 6_000),
    LocationSuggestion(name: "Los Jardines",         province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5060, lng: -69.8800, zoom: 4_000),
    LocationSuggestion(name: "Villa Mella",          province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5500, lng: -69.9230, zoom: 6_000),
    LocationSuggestion(name: "Guerra",               province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5380, lng: -69.7200, zoom: 10_000),
    LocationSuggestion(name: "La Victoria",          province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.5720, lng: -69.8400, zoom: 8_000),
    LocationSuggestion(name: "Mendoza",              province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.4950, lng: -69.8600, zoom: 4_000),
    LocationSuggestion(name: "Isabelita",            province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.4900, lng: -69.8500, zoom: 4_000),
    LocationSuggestion(name: "Las Américas",         province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.4600, lng: -69.7100, zoom: 8_000),
    LocationSuggestion(name: "San Isidro",           province: "Santo Domingo",        icon: "building.2.fill", popular: false, lat: 18.4970, lng: -69.8150, zoom: 5_000),

    // ════════════════════════════════════════════════════════════════
    // SANTIAGO — Province & Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Santiago de los Caballeros", province: "Santiago",        icon: "building.2.fill", popular: false, lat: 19.4500, lng: -70.6940, zoom: 15_000),
    LocationSuggestion(name: "Villa Bisonó (Navarrete)", province: "Santiago",          icon: "building.2.fill", popular: false, lat: 19.5470, lng: -70.8590, zoom: 8_000),
    LocationSuggestion(name: "Tamboril",             province: "Santiago",              icon: "building.2.fill", popular: false, lat: 19.4830, lng: -70.6100, zoom: 8_000),
    LocationSuggestion(name: "Licey al Medio",       province: "Santiago",              icon: "building.2.fill", popular: false, lat: 19.4300, lng: -70.6100, zoom: 6_000),
    LocationSuggestion(name: "Puñal",                province: "Santiago",              icon: "building.2.fill", popular: false, lat: 19.3900, lng: -70.5650, zoom: 8_000),
    LocationSuggestion(name: "San José de las Matas",province: "Santiago",              icon: "mountain.2.fill", popular: false, lat: 19.3340, lng: -70.9310, zoom: 10_000),
    LocationSuggestion(name: "Jánico",               province: "Santiago",              icon: "mountain.2.fill", popular: false, lat: 19.3330, lng: -70.7780, zoom: 10_000),
    LocationSuggestion(name: "Pedro García",         province: "Santiago",              icon: "building.2.fill", popular: false, lat: 19.3800, lng: -70.7000, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // LA ALTAGRACIA — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Higüey",               province: "La Altagracia",        icon: "building.2.fill", popular: false, lat: 18.6150, lng: -68.7080, zoom: 10_000),
    LocationSuggestion(name: "San Rafael del Yuma",  province: "La Altagracia",        icon: "building.2.fill", popular: false, lat: 18.4280, lng: -68.6710, zoom: 10_000),
    LocationSuggestion(name: "Cap Cana",             province: "La Altagracia",        icon: "beach.umbrella",  popular: false, lat: 18.5150, lng: -68.3700, zoom: 8_000),
    LocationSuggestion(name: "Verón",                province: "La Altagracia",        icon: "building.2.fill", popular: false, lat: 18.6750, lng: -68.4620, zoom: 6_000),
    LocationSuggestion(name: "Uvero Alto",           province: "La Altagracia",        icon: "beach.umbrella",  popular: false, lat: 18.7600, lng: -68.5200, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // LA ROMANA — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "La Romana (ciudad)",   province: "La Romana",            icon: "building.2.fill", popular: false, lat: 18.4270, lng: -68.9730, zoom: 10_000),
    LocationSuggestion(name: "Casa de Campo",        province: "La Romana",            icon: "beach.umbrella",  popular: false, lat: 18.4170, lng: -68.9280, zoom: 8_000),
    LocationSuggestion(name: "Guaymate",             province: "La Romana",            icon: "building.2.fill", popular: false, lat: 18.4820, lng: -68.8680, zoom: 8_000),
    LocationSuggestion(name: "Villa Hermosa",        province: "La Romana",            icon: "building.2.fill", popular: false, lat: 18.4060, lng: -69.0420, zoom: 8_000),
    LocationSuggestion(name: "Bayahíbe",             province: "La Romana",            icon: "beach.umbrella",  popular: false, lat: 18.3690, lng: -68.8380, zoom: 6_000),
    LocationSuggestion(name: "Dominicus",            province: "La Romana",            icon: "beach.umbrella",  popular: false, lat: 18.3600, lng: -68.8200, zoom: 5_000),

    // ════════════════════════════════════════════════════════════════
    // SAN PEDRO DE MACORÍS — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "San Pedro de Macorís (ciudad)", province: "San Pedro de Macorís", icon: "building.2.fill", popular: false, lat: 18.4530, lng: -69.3080, zoom: 10_000),
    LocationSuggestion(name: "Consuelo",             province: "San Pedro de Macorís", icon: "building.2.fill", popular: false, lat: 18.4760, lng: -69.3020, zoom: 6_000),
    LocationSuggestion(name: "Quisqueya",            province: "San Pedro de Macorís", icon: "building.2.fill", popular: false, lat: 18.5000, lng: -69.3770, zoom: 6_000),
    LocationSuggestion(name: "Ramón Santana",        province: "San Pedro de Macorís", icon: "building.2.fill", popular: false, lat: 18.5380, lng: -69.2050, zoom: 8_000),
    LocationSuggestion(name: "Guayacanes",           province: "San Pedro de Macorís", icon: "beach.umbrella",  popular: false, lat: 18.4350, lng: -69.4700, zoom: 5_000),

    // ════════════════════════════════════════════════════════════════
    // PUERTO PLATA — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Puerto Plata (ciudad)",province: "Puerto Plata",         icon: "building.2.fill", popular: false, lat: 19.7930, lng: -70.6880, zoom: 10_000),
    LocationSuggestion(name: "Sosúa",                province: "Puerto Plata",         icon: "beach.umbrella",  popular: false, lat: 19.7520, lng: -70.5170, zoom: 6_000),
    LocationSuggestion(name: "Cabarete",             province: "Puerto Plata",         icon: "beach.umbrella",  popular: false, lat: 19.7580, lng: -70.4210, zoom: 6_000),
    LocationSuggestion(name: "Imbert",               province: "Puerto Plata",         icon: "building.2.fill", popular: false, lat: 19.7410, lng: -70.8340, zoom: 8_000),
    LocationSuggestion(name: "Luperón",              province: "Puerto Plata",         icon: "building.2.fill", popular: false, lat: 19.8600, lng: -70.9570, zoom: 8_000),
    LocationSuggestion(name: "Altamira",             province: "Puerto Plata",         icon: "building.2.fill", popular: false, lat: 19.6720, lng: -70.8330, zoom: 8_000),
    LocationSuggestion(name: "Costámbar",            province: "Puerto Plata",         icon: "beach.umbrella",  popular: false, lat: 19.8100, lng: -70.7300, zoom: 5_000),
    LocationSuggestion(name: "Playa Dorada",         province: "Puerto Plata",         icon: "beach.umbrella",  popular: false, lat: 19.7900, lng: -70.6380, zoom: 5_000),

    // ════════════════════════════════════════════════════════════════
    // SAMANÁ — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Santa Bárbara de Samaná", province: "Samaná",            icon: "beach.umbrella",  popular: false, lat: 19.2060, lng: -69.3360, zoom: 8_000),
    LocationSuggestion(name: "Las Terrenas",         province: "Samaná",               icon: "beach.umbrella",  popular: false, lat: 19.3100, lng: -69.5420, zoom: 8_000),
    LocationSuggestion(name: "Las Galeras",          province: "Samaná",               icon: "beach.umbrella",  popular: false, lat: 19.2090, lng: -69.2440, zoom: 6_000),
    LocationSuggestion(name: "Sánchez",              province: "Samaná",               icon: "building.2.fill", popular: false, lat: 19.2330, lng: -69.6090, zoom: 6_000),
    LocationSuggestion(name: "El Limón",             province: "Samaná",               icon: "mountain.2.fill", popular: false, lat: 19.2800, lng: -69.4500, zoom: 6_000),

    // ════════════════════════════════════════════════════════════════
    // LA VEGA — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "La Vega (ciudad)",     province: "La Vega",              icon: "building.2.fill", popular: false, lat: 19.2200, lng: -70.5300, zoom: 10_000),
    LocationSuggestion(name: "Jarabacoa",            province: "La Vega",              icon: "mountain.2.fill", popular: false, lat: 19.1200, lng: -70.6370, zoom: 10_000),
    LocationSuggestion(name: "Constanza",            province: "La Vega",              icon: "mountain.2.fill", popular: false, lat: 18.9100, lng: -70.7500, zoom: 10_000),
    LocationSuggestion(name: "Jima Abajo",           province: "La Vega",              icon: "building.2.fill", popular: false, lat: 19.1370, lng: -70.3910, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // DUARTE — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "San Francisco de Macorís", province: "Duarte",           icon: "building.2.fill", popular: false, lat: 19.2930, lng: -70.0260, zoom: 10_000),
    LocationSuggestion(name: "Pimentel",             province: "Duarte",               icon: "building.2.fill", popular: false, lat: 19.2200, lng: -69.9440, zoom: 8_000),
    LocationSuggestion(name: "Las Guáranas",         province: "Duarte",               icon: "building.2.fill", popular: false, lat: 19.2010, lng: -69.9910, zoom: 8_000),
    LocationSuggestion(name: "Castillo",             province: "Duarte",               icon: "building.2.fill", popular: false, lat: 19.2100, lng: -70.0050, zoom: 8_000),
    LocationSuggestion(name: "Villa Riva",           province: "Duarte",               icon: "building.2.fill", popular: false, lat: 19.1750, lng: -69.9090, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // SAN CRISTÓBAL — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "San Cristóbal (ciudad)", province: "San Cristóbal",      icon: "building.2.fill", popular: false, lat: 18.4170, lng: -70.1070, zoom: 10_000),
    LocationSuggestion(name: "Bajos de Haina",       province: "San Cristóbal",        icon: "building.2.fill", popular: false, lat: 18.4190, lng: -70.0280, zoom: 8_000),
    LocationSuggestion(name: "Nigua",                province: "San Cristóbal",        icon: "building.2.fill", popular: false, lat: 18.3870, lng: -70.0850, zoom: 6_000),
    LocationSuggestion(name: "Villa Altagracia",     province: "San Cristóbal",        icon: "building.2.fill", popular: false, lat: 18.6700, lng: -70.1700, zoom: 8_000),
    LocationSuggestion(name: "Yaguate",              province: "San Cristóbal",        icon: "building.2.fill", popular: false, lat: 18.3640, lng: -70.1960, zoom: 8_000),
    LocationSuggestion(name: "Cambita Garabitos",    province: "San Cristóbal",        icon: "building.2.fill", popular: false, lat: 18.4720, lng: -70.1720, zoom: 8_000),
    LocationSuggestion(name: "Palenque",             province: "San Cristóbal",        icon: "beach.umbrella",  popular: false, lat: 18.2880, lng: -70.1200, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // ESPAILLAT — Municipalities & Towns
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Moca",                 province: "Espaillat",            icon: "building.2.fill", popular: false, lat: 19.3950, lng: -70.5230, zoom: 8_000),
    LocationSuggestion(name: "Cayetano Germosén",    province: "Espaillat",            icon: "building.2.fill", popular: false, lat: 19.3470, lng: -70.4650, zoom: 8_000),
    LocationSuggestion(name: "Gaspar Hernández",     province: "Espaillat",            icon: "building.2.fill", popular: false, lat: 19.6330, lng: -70.2900, zoom: 8_000),
    LocationSuggestion(name: "Jamao al Norte",       province: "Espaillat",            icon: "building.2.fill", popular: false, lat: 19.5930, lng: -70.4490, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // PERAVIA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Baní",                 province: "Peravia",              icon: "building.2.fill", popular: false, lat: 18.2800, lng: -70.3300, zoom: 10_000),
    LocationSuggestion(name: "Nizao",                province: "Peravia",              icon: "building.2.fill", popular: false, lat: 18.2450, lng: -70.2050, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // MARÍA TRINIDAD SÁNCHEZ — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Nagua",                province: "María Trinidad Sánchez", icon: "building.2.fill", popular: false, lat: 19.3820, lng: -69.8490, zoom: 8_000),
    LocationSuggestion(name: "Río San Juan",         province: "María Trinidad Sánchez", icon: "beach.umbrella",  popular: false, lat: 19.6330, lng: -70.0770, zoom: 6_000),
    LocationSuggestion(name: "Cabrera",              province: "María Trinidad Sánchez", icon: "beach.umbrella",  popular: false, lat: 19.6310, lng: -69.9050, zoom: 6_000),
    LocationSuggestion(name: "El Factor",            province: "María Trinidad Sánchez", icon: "building.2.fill", popular: false, lat: 19.2800, lng: -69.7900, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // HERMANAS MIRABAL — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Salcedo",              province: "Hermanas Mirabal",     icon: "building.2.fill", popular: false, lat: 19.3760, lng: -70.4160, zoom: 8_000),
    LocationSuggestion(name: "Tenares",              province: "Hermanas Mirabal",     icon: "building.2.fill", popular: false, lat: 19.3700, lng: -70.3530, zoom: 8_000),
    LocationSuggestion(name: "Villa Tapia",          province: "Hermanas Mirabal",     icon: "building.2.fill", popular: false, lat: 19.3000, lng: -70.4360, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // EL SEIBO — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "El Seibo (ciudad)",    province: "El Seibo",             icon: "building.2.fill", popular: false, lat: 18.7650, lng: -69.0350, zoom: 8_000),
    LocationSuggestion(name: "Miches",               province: "El Seibo",             icon: "beach.umbrella",  popular: false, lat: 18.9810, lng: -69.0460, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // HATO MAYOR — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Hato Mayor del Rey",   province: "Hato Mayor",           icon: "building.2.fill", popular: false, lat: 18.7640, lng: -69.2570, zoom: 8_000),
    LocationSuggestion(name: "Sabana de la Mar",     province: "Hato Mayor",           icon: "building.2.fill", popular: false, lat: 19.0610, lng: -69.3860, zoom: 8_000),
    LocationSuggestion(name: "El Valle",             province: "Hato Mayor",           icon: "building.2.fill", popular: false, lat: 18.7100, lng: -69.3500, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // MONTE PLATA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Monte Plata (ciudad)", province: "Monte Plata",          icon: "building.2.fill", popular: false, lat: 18.8070, lng: -69.7850, zoom: 8_000),
    LocationSuggestion(name: "Bayaguana",            province: "Monte Plata",          icon: "building.2.fill", popular: false, lat: 18.7530, lng: -69.6340, zoom: 10_000),
    LocationSuggestion(name: "Sabana Grande de Boyá",province: "Monte Plata",          icon: "building.2.fill", popular: false, lat: 18.9540, lng: -69.8010, zoom: 10_000),
    LocationSuggestion(name: "Yamasá",               province: "Monte Plata",          icon: "building.2.fill", popular: false, lat: 18.7600, lng: -69.9800, zoom: 10_000),

    // ════════════════════════════════════════════════════════════════
    // SÁNCHEZ RAMÍREZ — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Cotuí",                province: "Sánchez Ramírez",      icon: "building.2.fill", popular: false, lat: 19.0600, lng: -70.1500, zoom: 8_000),
    LocationSuggestion(name: "Fantino",              province: "Sánchez Ramírez",      icon: "building.2.fill", popular: false, lat: 19.1200, lng: -70.3000, zoom: 8_000),
    LocationSuggestion(name: "Cevicos",              province: "Sánchez Ramírez",      icon: "building.2.fill", popular: false, lat: 19.0200, lng: -69.9800, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // VALVERDE — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Mao",                  province: "Valverde",             icon: "building.2.fill", popular: false, lat: 19.5560, lng: -71.0780, zoom: 8_000),
    LocationSuggestion(name: "Esperanza",            province: "Valverde",             icon: "building.2.fill", popular: false, lat: 19.5900, lng: -70.9960, zoom: 8_000),
    LocationSuggestion(name: "Laguna Salada",        province: "Valverde",             icon: "building.2.fill", popular: false, lat: 19.6280, lng: -71.0910, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // MONTECRISTI — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Montecristi (ciudad)", province: "Montecristi",          icon: "building.2.fill", popular: false, lat: 19.8700, lng: -71.6450, zoom: 8_000),
    LocationSuggestion(name: "Castañuelas",          province: "Montecristi",          icon: "building.2.fill", popular: false, lat: 19.7200, lng: -71.5000, zoom: 8_000),
    LocationSuggestion(name: "Guayubín",             province: "Montecristi",          icon: "building.2.fill", popular: false, lat: 19.6360, lng: -71.3470, zoom: 8_000),
    LocationSuggestion(name: "Villa Vásquez",        province: "Montecristi",          icon: "building.2.fill", popular: false, lat: 19.7420, lng: -71.4310, zoom: 6_000),

    // ════════════════════════════════════════════════════════════════
    // DAJABÓN — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Dajabón (ciudad)",     province: "Dajabón",              icon: "building.2.fill", popular: false, lat: 19.5490, lng: -71.7080, zoom: 8_000),
    LocationSuggestion(name: "Loma de Cabrera",      province: "Dajabón",              icon: "building.2.fill", popular: false, lat: 19.4270, lng: -71.6190, zoom: 8_000),
    LocationSuggestion(name: "Restauración",         province: "Dajabón",              icon: "building.2.fill", popular: false, lat: 19.3130, lng: -71.6930, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // SANTIAGO RODRÍGUEZ — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "San Ignacio de Sabaneta", province: "Santiago Rodríguez", icon: "building.2.fill", popular: false, lat: 19.3850, lng: -71.3440, zoom: 8_000),
    LocationSuggestion(name: "Monción",              province: "Santiago Rodríguez",   icon: "building.2.fill", popular: false, lat: 19.3200, lng: -71.1740, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // SAN JUAN — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "San Juan de la Maguana", province: "San Juan",            icon: "building.2.fill", popular: false, lat: 18.8060, lng: -71.2300, zoom: 10_000),
    LocationSuggestion(name: "Las Matas de Farfán",  province: "San Juan",             icon: "building.2.fill", popular: false, lat: 18.8750, lng: -71.5150, zoom: 8_000),
    LocationSuggestion(name: "El Cercado",           province: "San Juan",             icon: "building.2.fill", popular: false, lat: 18.7430, lng: -71.3620, zoom: 8_000),
    LocationSuggestion(name: "Vallejuelo",           province: "San Juan",             icon: "building.2.fill", popular: false, lat: 18.6560, lng: -71.3340, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // AZUA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Azua de Compostela",   province: "Azua",                 icon: "building.2.fill", popular: false, lat: 18.4530, lng: -70.7290, zoom: 10_000),
    LocationSuggestion(name: "Padre Las Casas",      province: "Azua",                 icon: "building.2.fill", popular: false, lat: 18.7370, lng: -70.9390, zoom: 8_000),
    LocationSuggestion(name: "Peralta",              province: "Azua",                 icon: "building.2.fill", popular: false, lat: 18.5600, lng: -70.7650, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // BARAHONA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Barahona (ciudad)",    province: "Barahona",             icon: "building.2.fill", popular: false, lat: 18.2000, lng: -71.1000, zoom: 10_000),
    LocationSuggestion(name: "Cabral",               province: "Barahona",             icon: "building.2.fill", popular: false, lat: 18.2430, lng: -71.2180, zoom: 8_000),
    LocationSuggestion(name: "Paraíso",              province: "Barahona",             icon: "beach.umbrella",  popular: false, lat: 18.0160, lng: -71.1610, zoom: 6_000),
    LocationSuggestion(name: "Enriquillo",           province: "Barahona",             icon: "building.2.fill", popular: false, lat: 17.8940, lng: -71.2350, zoom: 8_000),
    LocationSuggestion(name: "Vicente Noble",        province: "Barahona",             icon: "building.2.fill", popular: false, lat: 18.3910, lng: -71.1810, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // BAORUCO — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Neyba",                province: "Baoruco",              icon: "building.2.fill", popular: false, lat: 18.4870, lng: -71.4180, zoom: 8_000),
    LocationSuggestion(name: "Tamayo",               province: "Baoruco",              icon: "building.2.fill", popular: false, lat: 18.4900, lng: -71.3550, zoom: 8_000),
    LocationSuggestion(name: "Galván",               province: "Baoruco",              icon: "building.2.fill", popular: false, lat: 18.5000, lng: -71.3400, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // INDEPENDENCIA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Jimaní",               province: "Independencia",        icon: "building.2.fill", popular: false, lat: 18.4930, lng: -71.8410, zoom: 8_000),
    LocationSuggestion(name: "Duvergé",              province: "Independencia",        icon: "building.2.fill", popular: false, lat: 18.3610, lng: -71.5280, zoom: 8_000),
    LocationSuggestion(name: "La Descubierta",       province: "Independencia",        icon: "building.2.fill", popular: false, lat: 18.5650, lng: -71.7280, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // PEDERNALES — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Pedernales (ciudad)",  province: "Pedernales",           icon: "building.2.fill", popular: false, lat: 18.0370, lng: -71.7440, zoom: 8_000),
    LocationSuggestion(name: "Oviedo",               province: "Pedernales",           icon: "building.2.fill", popular: false, lat: 17.8110, lng: -71.3760, zoom: 8_000),
    LocationSuggestion(name: "Bahía de las Águilas", province: "Pedernales",           icon: "beach.umbrella",  popular: false, lat: 17.8400, lng: -71.6200, zoom: 6_000),

    // ════════════════════════════════════════════════════════════════
    // ELÍAS PIÑA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Comendador",           province: "Elías Piña",           icon: "building.2.fill", popular: false, lat: 18.8760, lng: -71.6940, zoom: 8_000),
    LocationSuggestion(name: "Bánica",               province: "Elías Piña",           icon: "building.2.fill", popular: false, lat: 19.0230, lng: -71.6650, zoom: 8_000),
    LocationSuggestion(name: "Hondo Valle",          province: "Elías Piña",           icon: "building.2.fill", popular: false, lat: 18.7230, lng: -71.6770, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // SAN JOSÉ DE OCOA — Municipalities
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "San José de Ocoa (ciudad)", province: "San José de Ocoa", icon: "mountain.2.fill", popular: false, lat: 18.5460, lng: -70.5060, zoom: 8_000),
    LocationSuggestion(name: "Sabana Larga",         province: "San José de Ocoa",     icon: "building.2.fill", popular: false, lat: 18.6030, lng: -70.5450, zoom: 8_000),
    LocationSuggestion(name: "Rancho Arriba",        province: "San José de Ocoa",     icon: "building.2.fill", popular: false, lat: 18.6960, lng: -70.4850, zoom: 8_000),

    // ════════════════════════════════════════════════════════════════
    // PROVINCES (for province-wide searches)
    // ════════════════════════════════════════════════════════════════
    LocationSuggestion(name: "Distrito Nacional",       province: "Distrito Nacional",      icon: "mappin.circle.fill", popular: false, lat: 18.4861, lng: -69.9312, zoom: 15_000),
    LocationSuggestion(name: "Santo Domingo",           province: "Santo Domingo",          icon: "mappin.circle.fill", popular: false, lat: 18.5000, lng: -69.8500, zoom: 35_000),
    LocationSuggestion(name: "Santiago",                province: "Santiago",                icon: "mappin.circle.fill", popular: false, lat: 19.4500, lng: -70.6900, zoom: 40_000),
    LocationSuggestion(name: "La Romana",               province: "La Romana",              icon: "mappin.circle.fill", popular: false, lat: 18.4270, lng: -68.9730, zoom: 35_000),
    LocationSuggestion(name: "San Pedro de Macorís",    province: "San Pedro de Macorís",   icon: "mappin.circle.fill", popular: false, lat: 18.4530, lng: -69.3080, zoom: 35_000),
    LocationSuggestion(name: "Puerto Plata",            province: "Puerto Plata",           icon: "mappin.circle.fill", popular: false, lat: 19.7930, lng: -70.6880, zoom: 40_000),
    LocationSuggestion(name: "La Altagracia",           province: "La Altagracia",          icon: "mappin.circle.fill", popular: false, lat: 18.6150, lng: -68.6200, zoom: 60_000),
    LocationSuggestion(name: "Duarte",                  province: "Duarte",                 icon: "mappin.circle.fill", popular: false, lat: 19.2930, lng: -70.0260, zoom: 50_000),
    LocationSuggestion(name: "San Cristóbal",           province: "San Cristóbal",          icon: "mappin.circle.fill", popular: false, lat: 18.4170, lng: -70.1070, zoom: 40_000),
    LocationSuggestion(name: "Espaillat",               province: "Espaillat",              icon: "mappin.circle.fill", popular: false, lat: 19.3950, lng: -70.5230, zoom: 40_000),
    LocationSuggestion(name: "Peravia",                 province: "Peravia",                icon: "mappin.circle.fill", popular: false, lat: 18.2800, lng: -70.3300, zoom: 40_000),
    LocationSuggestion(name: "La Vega",                 province: "La Vega",                icon: "mappin.circle.fill", popular: false, lat: 19.2200, lng: -70.5300, zoom: 50_000),
    LocationSuggestion(name: "Samaná",                  province: "Samaná",                 icon: "mappin.circle.fill", popular: false, lat: 19.2060, lng: -69.3360, zoom: 50_000),
    LocationSuggestion(name: "El Seibo",                province: "El Seibo",               icon: "mappin.circle.fill", popular: false, lat: 18.7650, lng: -69.0350, zoom: 50_000),
    LocationSuggestion(name: "Hato Mayor",              province: "Hato Mayor",             icon: "mappin.circle.fill", popular: false, lat: 18.7640, lng: -69.2570, zoom: 50_000),
    LocationSuggestion(name: "Monte Plata",             province: "Monte Plata",            icon: "mappin.circle.fill", popular: false, lat: 18.8070, lng: -69.7850, zoom: 60_000),
    LocationSuggestion(name: "María Trinidad Sánchez",  province: "María Trinidad Sánchez", icon: "mappin.circle.fill", popular: false, lat: 19.3820, lng: -69.8490, zoom: 50_000),
    LocationSuggestion(name: "Hermanas Mirabal",        province: "Hermanas Mirabal",       icon: "mappin.circle.fill", popular: false, lat: 19.3600, lng: -70.3300, zoom: 40_000),
    LocationSuggestion(name: "Valverde",                province: "Valverde",               icon: "mappin.circle.fill", popular: false, lat: 19.5900, lng: -70.9800, zoom: 40_000),
    LocationSuggestion(name: "Montecristi",             province: "Montecristi",            icon: "mappin.circle.fill", popular: false, lat: 19.8500, lng: -71.6500, zoom: 50_000),
    LocationSuggestion(name: "Dajabón",                 province: "Dajabón",                icon: "mappin.circle.fill", popular: false, lat: 19.5490, lng: -71.7080, zoom: 40_000),
    LocationSuggestion(name: "Santiago Rodríguez",      province: "Santiago Rodríguez",     icon: "mappin.circle.fill", popular: false, lat: 19.4720, lng: -71.3400, zoom: 40_000),
    LocationSuggestion(name: "Elías Piña",              province: "Elías Piña",             icon: "mappin.circle.fill", popular: false, lat: 18.8760, lng: -71.6940, zoom: 50_000),
    LocationSuggestion(name: "San Juan",                province: "San Juan",               icon: "mappin.circle.fill", popular: false, lat: 18.8060, lng: -71.2300, zoom: 60_000),
    LocationSuggestion(name: "Azua",                    province: "Azua",                   icon: "mappin.circle.fill", popular: false, lat: 18.4530, lng: -70.7290, zoom: 50_000),
    LocationSuggestion(name: "Baoruco",                 province: "Baoruco",                icon: "mappin.circle.fill", popular: false, lat: 18.4900, lng: -71.4200, zoom: 50_000),
    LocationSuggestion(name: "Barahona",                province: "Barahona",               icon: "mappin.circle.fill", popular: false, lat: 18.2000, lng: -71.1000, zoom: 50_000),
    LocationSuggestion(name: "Independencia",           province: "Independencia",          icon: "mappin.circle.fill", popular: false, lat: 18.4900, lng: -71.8400, zoom: 60_000),
    LocationSuggestion(name: "Pedernales",              province: "Pedernales",             icon: "mappin.circle.fill", popular: false, lat: 18.0400, lng: -71.7500, zoom: 60_000),
    LocationSuggestion(name: "San José de Ocoa",        province: "San José de Ocoa",       icon: "mappin.circle.fill", popular: false, lat: 18.5460, lng: -70.5060, zoom: 40_000),
    LocationSuggestion(name: "Sánchez Ramírez",         province: "Sánchez Ramírez",        icon: "mappin.circle.fill", popular: false, lat: 19.0600, lng: -70.1500, zoom: 50_000),
]
