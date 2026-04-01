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
    @State private var showMap         = true
    @State private var selectedListing: Listing? = nil
    @State private var pins:            [Listing] = []

    // Filter sheet
    @State private var showFilters     = false
    @State private var showLocationSheet = false
    @State private var filterProvince: String?   = nil

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

    // Pin overlay
    @StateObject private var mapState = MapStateStore()

    // Bottom sheet
    @State private var sheetExpanded  = false
    @GestureState private var dragOffset: CGFloat = 0

    // Detail nav
    @State private var detailListingID: String? = nil

    // MARK: - Computed: filtered listings
    private var filteredListings: [Listing] {
        listings.filter { listing in
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
            if showMap {
                mapContent
                    .ignoresSafeArea()
            } else {
                NavigationStack {
                    listLayer
                        .navigationBarHidden(true)
                }
            }

            HStack(spacing: 10) {
                searchBarButton
                filterIconButton
            }
            .padding(.top, 56)
            .padding(.horizontal, 16)
        }
        .ignoresSafeArea(edges: .top)
        .onAppear     { selectedType = initialType }
        .onChange(of: selectedType) { Task { await load(reset: true) } }
        .task         { await load(reset: true) }
        .sheet(isPresented: $showFilters) { filterSheet }
        .sheet(isPresented: $showLocationSheet) { locationSheet }
        .sheet(isPresented: Binding(
            get:  { detailListingID != nil },
            set:  { if !$0 { detailListingID = nil } }
        )) {
            if let id = detailListingID {
                NavigationStack { ListingDetailView(id: id) }
            }
        }
    }

    // Tab bar height estimate
    private let tabBarHeight: CGFloat = 83

    // MARK: - Map content
    @ViewBuilder
    private var mapContent: some View {
        ZStack(alignment: .bottom) {
            NativeMapView(
                listings:     pins,
                selected:     $selectedListing,
                centerOnUser: $centerOnUser,
                userLocation: locationManager.location,
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

            // Location button — above the grab bar
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    locationButton
                        .padding(.trailing, 16)
                }
            }
            .padding(.bottom, sheetExpanded ? 0 : grabBarHeight + tabBarHeight + 12)
            .opacity(sheetExpanded ? 0 : 1)

            bottomSheet

            mapToggleButton
                .padding(.bottom, grabBarHeight + 8)
                .opacity(sheetExpanded ? 0 : 1)
        }
        .onTapGesture {
            // Tap on empty map area dismisses callout
            if selectedListing != nil && !sheetExpanded {
                withAnimation(.spring(response: 0.25)) { selectedListing = nil }
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

    // MARK: - Bottom sheet
    private var grabBarHeight: CGFloat { 56 }
    private var sheetExpandedHeight: CGFloat { UIScreen.main.bounds.height * 0.75 }

    private var currentSheetHeight: CGFloat {
        let base = sheetExpanded ? sheetExpandedHeight : grabBarHeight
        return max(grabBarHeight, min(sheetExpandedHeight, base - dragOffset))
    }

    @ViewBuilder
    private var bottomSheet: some View {
        VStack(spacing: 0) {
            // Grab bar + count label
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.secondary.opacity(0.5))
                .frame(width: 38, height: 5)
                .padding(.top, 10)
                .padding(.bottom, 5)

            HStack {
                if loading && listings.isEmpty {
                    Text("Cargando...")
                        .font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Text("\(filteredListings.count) propiedades")
                        .font(.subheadline.bold())
                    if let prov = filterProvince {
                        Text("en \(prov)")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !sheetExpanded {
                    Label("Ver todas", systemImage: "chevron.up")
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdBlue)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            if sheetExpanded {
                expandedListContent
            }
        }
        .frame(height: currentSheetHeight, alignment: .top)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: sheetExpanded ? 22 : 18, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: sheetExpanded ? 20 : 8, y: -3)
        .padding(.bottom, sheetExpanded ? 0 : tabBarHeight)  // sit just above tab bar
        .gesture(
            DragGesture()
                .updating($dragOffset) { v, s, _ in s = v.translation.height }
                .onEnded { v in
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                        if v.translation.height < -50 { sheetExpanded = true }
                        else if v.translation.height > 50 { sheetExpanded = false; selectedListing = nil }
                    }
                }
        )
        .animation(.interactiveSpring(response: 0.35, dampingFraction: 0.82), value: dragOffset)
    }

    // Expanded: single-column full-width cards (larger images)
    @ViewBuilder
    private var expandedListContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 16) {
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
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 40)
            }
            .onChange(of: selectedListing) { listing in
                if let id = listing?.id {
                    withAnimation { proxy.scrollTo("row_\(id)", anchor: .center) }
                }
            }
        }
    }

    // MARK: - UI elements
    private var locationButton: some View {
        Button {
            locationManager.requestLocation()
            centerOnUser = true
        } label: {
            Image(systemName: "location.fill")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.rdBlue)
                .frame(width: 44, height: 44)
                .background(Color(.systemBackground).opacity(0.95), in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        }
    }

    private var searchBarButton: some View {
        Button { showLocationSheet = true } label: {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Color.rdBlue)
                Text(filterProvince ?? "Buscar provincia, ciudad...")
                    .font(.subheadline)
                    .foregroundStyle(filterProvince == nil ? .secondary : .primary)
                Spacer()
                if filterProvince != nil {
                    Button {
                        filterProvince = nil
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
        .buttonStyle(.plain)
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

    private var mapToggleButton: some View {
        Button {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) {
                showMap.toggle()
                if !showMap { selectedListing = nil }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: showMap ? "list.bullet" : "map.fill")
                Text(showMap ? "Lista" : "Mapa").fontWeight(.semibold)
            }
            .font(.subheadline)
            .foregroundStyle(.white)
            .padding(.horizontal, 22).padding(.vertical, 13)
            .background(Color.rdBlue, in: Capsule())
            .shadow(color: Color.rdBlue.opacity(0.4), radius: 10, y: 4)
        }
    }

    // MARK: - List layer (full screen)
    @ViewBuilder
    private var listLayer: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                Color.clear.frame(height: 80)

                if loading && listings.isEmpty {
                    ProgressView("Cargando propiedades...").padding(.top, 60)
                } else if let err = error {
                    VStack(spacing: 12) {
                        Image(systemName: "wifi.slash")
                            .font(.largeTitle).foregroundStyle(Color.rdRed)
                        Text(err).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await load(reset: true) } }
                            .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                    }.padding()
                } else {
                    LazyVStack(spacing: 16) {
                        ForEach(filteredListings) { listing in
                            NavigationLink { ListingDetailView(id: listing.id) } label: {
                                ListingRow(listing: listing, isSelected: false)
                            }
                            .buttonStyle(.plain)
                            .onAppear {
                                if listing.id == filteredListings.last?.id, page < totalPages {
                                    Task { await loadMore() }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    if loading && !listings.isEmpty { ProgressView().padding() }
                    Color.clear.frame(height: 90)
                }
            }
            .refreshable { await load(reset: true) }

            mapToggleButton.padding(.bottom, 20)
        }
    }

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

    // MARK: - Location sheet (province/city only)
    private var locationSheet: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        filterProvince = nil
                        showLocationSheet = false
                        Task { await load(reset: true) }
                    } label: {
                        HStack {
                            Image(systemName: "mappin.and.ellipse")
                                .foregroundStyle(Color.rdBlue)
                            Text("Todas las ubicaciones")
                                .foregroundStyle(.primary)
                            Spacer()
                            if filterProvince == nil {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.rdBlue)
                                    .fontWeight(.bold)
                            }
                        }
                    }
                }

                Section("Provincias") {
                    ForEach(drProvinces, id: \.self) { prov in
                        Button {
                            filterProvince = prov
                            showLocationSheet = false
                            Task { await load(reset: true) }
                        } label: {
                            HStack {
                                Image(systemName: "mappin.circle.fill")
                                    .foregroundStyle(Color.rdBlue)
                                Text(prov).foregroundStyle(.primary)
                                Spacer()
                                if filterProvince == prov {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.rdBlue)
                                        .fontWeight(.bold)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Ubicación")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { showLocationSheet = false }
                }
            }
        }
        .presentationDetents([.large])
    }

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
                type: selectedType, province: filterProvince, limit: 50, page: page
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
            type: selectedType, province: filterProvince, limit: 50, page: page
        ) {
            listings.append(contentsOf: res.listings)
            pins.append(contentsOf: res.listings.filter { $0.lat != nil && $0.lng != nil })
        }
        loading = false
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
            ZStack(alignment: .topLeading) {
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
private let drProvinces: [String] = [
    "Distrito Nacional", "Santo Domingo", "Santiago", "La Romana",
    "San Pedro de Macorís", "Puerto Plata", "La Altagracia", "Duarte",
    "San Cristóbal", "Espaillat", "Peravia", "La Vega", "Samaná",
    "El Seibo", "Hato Mayor", "Monte Plata", "María Trinidad Sánchez",
    "Hermanas Mirabal", "Valverde", "Montecristi", "Dajabón",
    "Santiago Rodríguez", "Elías Piña", "San Juan", "Azua",
    "Baoruco", "Barahona", "Independencia", "Pedernales",
    "San José de Ocoa", "Sánchez Ramírez",
]
