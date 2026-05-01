import SwiftUI
import MapKit
import PhotosUI

// MARK: - Unit Type model

struct UnitType: Identifiable {
    var id = UUID()
    var name      = ""   // e.g. "1BR", "Penthouse"
    var bedrooms  = ""
    var bathrooms = ""
    var area      = ""
    var price     = ""
    var available = ""
    var floor     = ""   // floor/level number
    var phase     = ""   // construction phase for this unit type
    var unitIds   = ""   // newline-separated IDs (e.g. "Apt 1A\nApt 2A\nApt 3A")
}

// MARK: - Submit Listing View

struct SubmitListingView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    @Environment(\.openURL) var openURL

    // Transaction type
    @State private var listingType = "venta"

    // Basic info
    @State private var title       = ""
    @State private var propertyType = ""
    @State private var condition   = ""
    @State private var description = ""

    // Price & size
    @State private var price     = ""
    @State private var priceMax  = ""
    @State private var priceRangeEnabled = false
    @State private var currency  = "USD"
    @State private var areaConst = ""
    @State private var areaLand  = ""

    // Details
    @State private var bedrooms  = ""
    @State private var bathrooms = ""
    @State private var parking   = ""

    // Project unit types
    @State private var unitTypes: [UnitType] = []

    // Location
    @State private var province = ""
    @State private var city     = ""
    @State private var sector   = ""
    @State private var address  = ""
    @State private var coordinate: CLLocationCoordinate2D? = nil

    // Amenities
    @State private var selectedAmenities: Set<String> = []
    @State private var customAmenityText = ""
    @State private var customAmenities: [String] = []

    // Tags
    @State private var selectedTags: Set<String> = []

    // Photos
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var selectedImages: [UIImage] = []
    @State private var uploadedPhotoURLs: [String] = []
    @State private var uploadingPhotos = false

    // Blueprints
    @State private var blueprintItems: [PhotosPickerItem] = []
    @State private var blueprintImages: [UIImage] = []
    @State private var uploadedBlueprintURLs: [String] = []
    @State private var uploadingBlueprints = false

    // Feed image (mandatory portrait 9:16 image used in the Reels feed).
    // Two paths: a custom portrait upload OR a focal point picked on an
    // existing photo. Either path satisfies validation.
    enum FeedImageMode { case upload, focalPoint }
    @State private var feedImageMode: FeedImageMode = .upload
    @State private var feedPhotoItem: PhotosPickerItem? = nil
    @State private var feedImage: UIImage? = nil
    @State private var feedFocalIndex: Int = 0
    @State private var feedFocalX: Double = 0.5
    @State private var feedFocalY: Double = 0.5
    @State private var feedFocalSet: Bool = false

    // Project-specific
    @State private var constructionCompany = ""
    @State private var unitsTotal    = ""
    @State private var unitsAvailable = ""
    @State private var deliveryDate  = Date()
    @State private var projectStage  = ""

    // Property details
    @State private var floors       = ""
    @State private var floorNumber  = ""
    @State private var yearBuilt    = ""
    @State private var referencePoint = ""

    // Contact
    @State private var contactName  = ""
    @State private var contactEmail = ""
    @State private var contactPhone = ""
    @State private var contactPref  = ""
    @State private var role         = ""

    // Terms
    @State private var acceptedTerms = false

    // State
    @State private var loading = false
    @State private var error: String?
    @State private var success = false

    // Paywall gating
    @State private var checkingSubscription = true
    @State private var paywallBlocked = false

    // Options
    private let listingTypes   = [("venta","En Venta"),("alquiler","En Alquiler"),("proyecto","Proyecto")]
    private let propertyTypes  = ["Casa","Apartamento","Villa","Penthouse","Solar / Terreno","Local Comercial","Finca"]
    private let conditions     = ["Nueva construcción","En planos","Excelente estado","Buen estado","Necesita remodelación"]
    private let bedroomOpts    = ["Estudio","1","2","3","4","5","6+"]
    private let bathroomOpts   = ["1","1.5","2","2.5","3","4+"]
    private let parkingOpts    = ["0","1","2","3","4+"]
    private let floorsOpts     = ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20+"]
    private let projectStages  = ["En planos","Inicio de construcción","Estructura","Acabados","Listo para entrega"]
    private let contactPrefs   = ["WhatsApp","Llamada","Correo"]
    private let roleOpts       = ["Agente/Broker","Dueño","Constructora","Inmobiliaria"]
    private let provinces      = ["Azua","Bahoruco","Barahona","Dajabón","Distrito Nacional","Duarte",
                                   "Elías Piña","El Seibo","Espaillat","Hato Mayor","Hermanas Mirabal",
                                   "Independencia","La Altagracia","La Romana","La Vega",
                                   "María Trinidad Sánchez","Monseñor Nouel","Monte Cristi","Monte Plata",
                                   "Pedernales","Peravia","Puerto Plata","Samaná","Sánchez Ramírez",
                                   "San Cristóbal","San José de Ocoa","San Juan","San Pedro de Macorís",
                                   "Santiago","Santiago Rodríguez","Santo Domingo","Valverde"]
    private let municipalities: [String: [String]] = [
        "Azua": ["Azua de Compostela","Estebanía","Guayabal","Las Charcas","Las Yayas de Viajama","Padre Las Casas","Peralta","Pueblo Viejo","Sabana Yegua","Tábara Arriba"],
        "Bahoruco": ["Neiba","Galván","Los Ríos","Tamayo","Villa Jaragua"],
        "Barahona": ["Barahona","Cabral","El Peñón","Enriquillo","Fundación","Jaquimeyes","La Ciénaga","Las Salinas","Paraíso","Polo","Vicente Noble"],
        "Dajabón": ["Dajabón","El Pino","Loma de Cabrera","Partido","Restauración"],
        "Distrito Nacional": ["Santo Domingo de Guzmán"],
        "Duarte": ["San Francisco de Macorís","Arenoso","Castillo","Eugenio María de Hostos","Las Guáranas","Pimentel","Villa Riva"],
        "Elías Piña": ["Comendador","Bánica","El Llano","Hondo Valle","Juan Santiago","Pedro Santana"],
        "El Seibo": ["El Seibo","Miches"],
        "Espaillat": ["Moca","Cayetano Germosén","Gaspar Hernández","Jamao al Norte"],
        "Hato Mayor": ["Hato Mayor del Rey","El Valle","Sabana de la Mar"],
        "Hermanas Mirabal": ["Salcedo","Tenares","Villa Tapia"],
        "Independencia": ["Jimaní","Cristóbal","Duvergé","La Descubierta","Mella","Postrer Río"],
        "La Altagracia": ["Higüey","San Rafael del Yuma","Bávaro","Punta Cana","Verón"],
        "La Romana": ["La Romana","Guaymate","Villa Hermosa","Bayahíbe"],
        "La Vega": ["La Vega","Constanza","Jarabacoa","Jima Abajo"],
        "María Trinidad Sánchez": ["Nagua","Cabrera","El Factor","Río San Juan"],
        "Monseñor Nouel": ["Bonao","Maimón","Piedra Blanca"],
        "Monte Cristi": ["Monte Cristi","Castañuelas","Guayubín","Las Matas de Santa Cruz","Pepillo Salcedo","Villa Vásquez"],
        "Monte Plata": ["Monte Plata","Bayaguana","Peralvillo","Sabana Grande de Boyá","Yamasá"],
        "Pedernales": ["Pedernales","Oviedo"],
        "Peravia": ["Baní","Nizao","Matanzas","Paya","Sombrero"],
        "Puerto Plata": ["Puerto Plata","Altamira","Guananico","Imbert","Los Hidalgos","Luperón","Sosúa","Cabarete","Villa Isabela","Villa Montellano"],
        "Samaná": ["Samaná","Las Terrenas","Sánchez","Las Galeras"],
        "Sánchez Ramírez": ["Cotuí","Cevicos","Fantino","La Mata"],
        "San Cristóbal": ["San Cristóbal","Bajos de Haina","Cambita Garabitos","Los Cacaos","Sabana Grande de Palenque","San Gregorio de Nigua","Villa Altagracia","Yaguate"],
        "San José de Ocoa": ["San José de Ocoa","Rancho Arriba","Sabana Larga"],
        "San Juan": ["San Juan de la Maguana","Bohechío","El Cercado","Juan de Herrera","Las Matas de Farfán","Vallejuelo"],
        "San Pedro de Macorís": ["San Pedro de Macorís","Consuelo","Guayacanes","Quisqueya","Ramón Santana","Juan Dolio"],
        "Santiago": ["Santiago de los Caballeros","Bisonó","Jánico","Licey al Medio","Puñal","Sabana Iglesia","San José de las Matas","Tamboril","Villa González","Villa Bisonó"],
        "Santiago Rodríguez": ["San Ignacio de Sabaneta","Monción","Villa Los Almácigos"],
        "Santo Domingo": ["Santo Domingo Este","Santo Domingo Norte","Santo Domingo Oeste","Boca Chica","Guerra","Los Alcarrizos","Pedro Brand","San Antonio de Guerra","San Isidro"],
        "Valverde": ["Mao","Esperanza","Laguna Salada"],
    ]
    private let amenitiesList: [(String,String)] = [
        // Exterior / Recreación
        ("piscina","Piscina"),("jacuzzi","Jacuzzi"),("gym","Gimnasio"),("bbq","Área BBQ"),
        ("cancha","Cancha Deportiva"),("area_juegos","Área de Juegos"),("salon_fiestas","Salón de Fiestas"),
        ("rooftop","Rooftop / Azotea"),("jardin","Jardín"),("pet_friendly","Pet Friendly"),
        // Interior / Confort
        ("balcon","Balcón / Terraza"),("ac","Aire Acondicionado"),("amueblado","Amueblado"),
        ("semi_amueblado","Semi-amueblado"),("walk_in_closet","Walk-in Closet"),
        ("cocina_modular","Cocina Modular"),("cuarto_servicio","Cuarto de Servicio"),
        ("deposito","Depósito / Storage"),("lavanderia","Área de Lavandería"),
        // Infraestructura
        ("planta","Planta Eléctrica"),("cisterna","Cisterna / Bomba"),("elevador","Elevador"),
        ("paneles_solares","Paneles Solares"),("gas_central","Gas Central"),
        ("agua_caliente","Agua Caliente"),("fibra_optica","Fibra Óptica / Internet"),
        // Seguridad
        ("seguridad","Vigilancia 24/7"),("camaras","Cámaras CCTV"),
        ("control_acceso","Control de Acceso"),("portero","Portero / Lobby"),
        // Vistas / Ubicación
        ("vista_mar","Vista al Mar"),("frente_mar","Frente al Mar"),
        ("vista_montana","Vista a la Montaña"),("vista_ciudad","Vista a la Ciudad"),
        ("cerca_playa","Cerca de la Playa"),("zona_tranquila","Zona Tranquila"),
    ]

    private var needsBedsBaths: Bool {
        !["Solar / Terreno","Local Comercial","Finca"].contains(propertyType)
    }

    var body: some View {
        NavigationStack {
            Group {
                if checkingSubscription {
                    ProgressView("Verificando suscripción…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if paywallBlocked {
                    paywallView
                } else if success {
                    successView
                } else {
                    formView
                }
            }
            .navigationTitle("Publicar Propiedad")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
        .onAppear {
            if let user = api.currentUser {
                contactName  = user.name
                contactEmail = user.email
            }
        }
        .task { await checkSubscription() }
    }

    // MARK: - Paywall

    private func checkSubscription() async {
        checkingSubscription = true
        defer { checkingSubscription = false }
        do {
            let status = try await api.getSubscriptionStatus()
            if status.required && (status.canAccessDashboard != true) {
                paywallBlocked = true
            } else {
                paywallBlocked = false
            }
        } catch {
            // If the check fails, let the user continue — server will still
            // enforce the paywall on /submit, so we fail open here.
            paywallBlocked = false
        }
    }

    private var paywallView: some View {
        VStack(spacing: Spacing.s16) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.rdInk)
            Text("Completa tu pago para publicar")
                .font(.title2).bold()
                .foregroundStyle(Color.rdInk)
                .multilineTextAlignment(.center)
            Text("Para publicar propiedades necesitas activar tu suscripción con un método de pago. Tu prueba de 14 días empieza al agregar la tarjeta y no se cobra nada hasta el día 15.")
                .font(.subheadline)
                .foregroundStyle(Color.rdInkSoft)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Spacing.s24)

            PrimaryButton(title: "Activar mi suscripción") {
                if let url = URL(string: "\(apiBase)/subscribe") { openURL(url) }
            }
            .padding(.horizontal, Spacing.s24)
            .padding(.top, Spacing.s8)

            Button("Cerrar") { dismiss() }
                .font(.subheadline)
                .foregroundStyle(Color.rdInkSoft)
                .padding(.top, 4)
                .frame(minHeight: 44)

            Spacer()
        }
        .padding()
        .background(Color.rdBg.ignoresSafeArea())
    }

    // MARK: - Form

    private var formView: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Header
                ZStack {
                    LinearGradient(colors: [Color(red:0,green:0.07,blue:0.19), Color.rdBlue],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                    VStack(spacing: 6) {
                        Image(systemName: "plus.circle.fill").font(.title).foregroundStyle(.white)
                        Text("Nueva Publicación").font(.title3).bold().foregroundStyle(.white)
                        Text("Completa los datos de tu propiedad").font(.caption).foregroundStyle(.white.opacity(0.75))
                    }
                    .padding(.vertical, 28)
                }

                VStack(spacing: 20) {

                    // ── Tipo de transacción ─────────────────────────────
                    FormSection(title: "Tipo de Transacción", icon: "tag.fill", color: Color.rdBlue) {
                        Picker("Tipo", selection: $listingType) {
                            ForEach(listingTypes, id: \.0) { Text($1).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }

                    // ── Información básica ──────────────────────────────
                    FormSection(title: "Información Básica", icon: "doc.text.fill", color: Color.rdRed) {
                        VStack(spacing: 14) {
                            FloatingField(label: "Título del anuncio *", text: $title)
                            FormPicker(label: "Tipo de propiedad *", selection: $propertyType, options: propertyTypes)
                            FormPicker(label: "Condición *", selection: $condition, options: conditions)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("DESCRIPCIÓN *")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(Color.rdInkSoft)
                                    .kerning(0.5)
                                TextEditor(text: $description)
                                    .frame(minHeight: 110)
                                    .padding(10)
                                    .background(Color.rdSurfaceMuted)
                                    .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                                    .foregroundStyle(Color.rdInk)
                                if description.isEmpty {
                                    Text("Describe la propiedad para publicarla.")
                                        .font(.caption)
                                        .foregroundStyle(Color.rdRed.opacity(0.85))
                                }
                            }
                        }
                    }

                    // ── Tipos de Unidades (proyecto only) ───────────────
                    if listingType == "proyecto" {
                        FormSection(title: "Tipos de Unidades", icon: "list.bullet.rectangle.fill", color: Color.rdBlue) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Si el proyecto incluye diferentes tipos de unidades (ej. 1BR, 2BR, Penthouse) con distintos precios o dimensiones, agrégalos aquí.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                if !unitTypes.isEmpty {
                                    VStack(spacing: 10) {
                                        ForEach($unitTypes) { $unit in
                                            UnitTypeRow(unit: $unit) {
                                                unitTypes.removeAll { $0.id == unit.id }
                                            }
                                        }
                                    }
                                }

                                Button {
                                    unitTypes.append(UnitType())
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: "plus.circle.fill")
                                        Text("Agregar Tipo de Unidad")
                                    }
                                    .font(.subheadline).bold()
                                    .foregroundStyle(Color.rdBlue)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(Color.rdBlue.opacity(0.08))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    // ── Datos del Proyecto (proyecto only) ─────────────
                    if listingType == "proyecto" {
                        FormSection(title: "Datos del Proyecto", icon: "building.2.fill", color: Color.rdGreen) {
                            VStack(spacing: 14) {
                                FloatingField(label: "Constructora / Empresa (Opcional)", text: $constructionCompany)
                                HStack(spacing: 12) {
                                    FloatingField(label: "Total de Unidades", text: $unitsTotal)
                                        .keyboardType(.numberPad)
                                    FloatingField(label: "Unidades Disponibles", text: $unitsAvailable)
                                        .keyboardType(.numberPad)
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("FECHA DE ENTREGA")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(Color.rdInkSoft)
                                        .kerning(0.5)
                                    DatePicker("", selection: $deliveryDate, displayedComponents: .date)
                                        .datePickerStyle(.compact)
                                        .labelsHidden()
                                        .tint(Color.rdInk)
                                }
                                FormPicker(label: "Etapa del Proyecto", selection: $projectStage, options: projectStages)
                            }
                        }
                    }

                    // ── Precio y medidas ────────────────────────────────
                    FormSection(title: "Precio y Medidas", icon: "dollarsign.circle.fill", color: Color.rdGreen) {
                        VStack(spacing: 14) {
                            if listingType == "proyecto" {
                                Text("Ingresa el precio más bajo (precio desde) si el proyecto tiene varios tipos de unidades.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            HStack(spacing: 12) {
                                Picker("Moneda", selection: $currency) {
                                    Text("USD $").tag("USD")
                                    Text("DOP RD$").tag("DOP")
                                }
                                .pickerStyle(.segmented)
                                .frame(width: 160)
                                FloatingField(label: priceRangeEnabled ? "Precio desde *" : "Precio *", text: $price)
                                    .keyboardType(.decimalPad)
                            }
                            Toggle(isOn: $priceRangeEnabled) {
                                Text("Rango de precio (desde — hasta)")
                                    .font(.caption)
                                    .foregroundStyle(Color.rdInk)
                            }
                            .tint(Color.rdInk)
                            if priceRangeEnabled {
                                FloatingField(label: "Precio hasta *", text: $priceMax)
                                    .keyboardType(.decimalPad)
                            }
                            HStack(spacing: Spacing.s12) {
                                FloatingField(label: "Área Construida (m²)", text: $areaConst)
                                    .keyboardType(.decimalPad)
                                FloatingField(label: "Área Terreno (m²)", text: $areaLand)
                                    .keyboardType(.decimalPad)
                            }
                            if price.isEmpty {
                                Text("Indica el precio para publicar.")
                                    .font(.caption)
                                    .foregroundStyle(Color.rdRed.opacity(0.85))
                            }
                        }
                    }

                    // ── Detalles (non-project) ──────────────────────────
                    if listingType != "proyecto" {
                        FormSection(title: "Detalles", icon: "slider.horizontal.3", color: Color.rdBlue) {
                            VStack(spacing: 14) {
                                if needsBedsBaths {
                                    HStack(spacing: 12) {
                                        FormPicker(label: "Habitaciones", selection: $bedrooms,  options: bedroomOpts)
                                        FormPicker(label: "Baños",        selection: $bathrooms, options: bathroomOpts)
                                    }
                                }
                                FormPicker(label: "Parqueos", selection: $parking, options: parkingOpts)
                                FormPicker(label: "Niveles / Pisos", selection: $floors, options: floorsOpts)
                                FloatingField(label: "¿En qué piso?", text: $floorNumber)
                                    .keyboardType(.numberPad)
                                FloatingField(label: "Año de construcción (ej. 2020)", text: $yearBuilt)
                                    .keyboardType(.numberPad)
                                FloatingField(label: "Punto de referencia (ej. Frente al parque central)", text: $referencePoint)
                            }
                        }
                    }

                    // ── Ubicación ───────────────────────────────────────
                    FormSection(title: "Ubicación", icon: "mappin.circle.fill", color: Color.rdRed) {
                        VStack(spacing: 14) {
                            FormPicker(label: "Provincia *", selection: $province, options: provinces)
                                .onChange(of: province) { city = "" }
                            FormPicker(label: "Ciudad / Municipio *", selection: $city, options: municipalities[province] ?? [])
                            FloatingField(label: "Sector / Residencial", text: $sector)
                            FloatingField(label: "Dirección", text: $address)
                        }
                    }

                    // ── Mapa ────────────────────────────────────────────
                    FormSection(title: "Ubicación en el Mapa", icon: "map.fill", color: Color.rdBlue) {
                        LocationPickerView(
                            coordinate: $coordinate,
                            searchHint: [city, sector, address, province].filter { !$0.isEmpty }.joined(separator: ", ")
                        )
                    }

                    // ── Amenidades ──────────────────────────────────────
                    FormSection(title: "Amenidades", icon: "sparkles", color: Color.rdGreen) {
                        FlowChips(items: amenitiesList, selected: $selectedAmenities)

                        // Custom amenity input
                        HStack(spacing: 8) {
                            TextField("Agregar amenidad personalizada", text: $customAmenityText)
                                .textFieldStyle(.roundedBorder)
                                .font(.subheadline)
                                .submitLabel(.done)
                                .onSubmit { addCustomAmenity() }
                            Button {
                                addCustomAmenity()
                            } label: {
                                Image(systemName: "plus.circle.fill")
                                    .foregroundStyle(Color.rdBlue)
                                    .font(.title3)
                            }
                            .disabled(customAmenityText.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        .padding(.top, 8)

                        if !customAmenities.isEmpty {
                            FlowLayout(spacing: 6) {
                                ForEach(customAmenities, id: \.self) { amenity in
                                    HStack(spacing: 4) {
                                        Text(amenity).font(.caption).bold()
                                        Button {
                                            customAmenities.removeAll { $0 == amenity }
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .font(.caption2)
                                        }
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Color.rdBlue.opacity(0.1))
                                    .foregroundStyle(Color.rdBlue)
                                    .clipShape(Capsule())
                                }
                            }
                        }
                    }

                    // ── Etiquetas ────────────────────────────────────────
                    FormSection(title: "Etiquetas", icon: "tag.fill", color: Color.rdRed) {
                        TagPickerView(selected: $selectedTags)
                    }

                    // ── Contacto ────────────────────────────────────────
                    // ── Photos ──
                    FormSection(title: "Fotos de la propiedad", icon: "camera.fill", color: .rdOrange) {
                        PhotosPicker(selection: $selectedPhotoItems,
                                     maxSelectionCount: 30,
                                     matching: .images) {
                            HStack {
                                Image(systemName: "photo.on.rectangle.angled")
                                    .foregroundStyle(Color.rdInk)
                                Text(selectedImages.isEmpty ? "Seleccionar fotos (máx. 30)" : "\(selectedImages.count) foto(s) seleccionada(s)")
                                    .foregroundStyle(Color.rdInk)
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(Color.rdInkSoft)
                            }
                            .frame(minHeight: 44)
                        }
                        .accessibilityLabel("Seleccionar fotos de la propiedad")
                        .onChange(of: selectedPhotoItems) { _, items in
                            Task { await loadPhotos(items) }
                        }
                        if !selectedImages.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(Array(selectedImages.enumerated()), id: \.offset) { i, img in
                                        Image(uiImage: img)
                                            .resizable()
                                            .scaledToFill()
                                            .frame(width: 80, height: 60)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                            .overlay(alignment: .topTrailing) {
                                                Button {
                                                    selectedImages.remove(at: i)
                                                    if i < selectedPhotoItems.count {
                                                        selectedPhotoItems.remove(at: i)
                                                    }
                                                } label: {
                                                    Image(systemName: "xmark.circle.fill")
                                                        .font(.caption)
                                                        .foregroundStyle(.white)
                                                        .background(Circle().fill(.black.opacity(0.5)))
                                                }
                                                .offset(x: 4, y: -4)
                                            }
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                        if uploadingPhotos {
                            HStack(spacing: 8) {
                                ProgressView().scaleEffect(0.7)
                                Text("Subiendo fotos…").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }

                    // ── Feed image (mandatory) ──────────────────────
                    FormSection(title: "Imagen del Feed *", icon: "play.rectangle.fill", color: .rdPurple) {
                        feedImageSection
                    }

                    // ── Planos / Blueprints ─────────────────────────
                    FormSection(title: "Planos / Blueprints", icon: "doc.richtext.fill", color: Color.rdBlue) {
                        PhotosPicker(selection: $blueprintItems,
                                     maxSelectionCount: 5,
                                     matching: .images) {
                            HStack {
                                Image(systemName: "doc.badge.plus")
                                    .foregroundStyle(Color.rdInk)
                                Text(blueprintImages.isEmpty ? "Seleccionar planos (máx. 5)" : "\(blueprintImages.count) plano(s)")
                                    .foregroundStyle(Color.rdInk)
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(Color.rdInkSoft)
                            }
                            .frame(minHeight: 44)
                        }
                        .accessibilityLabel("Seleccionar planos")
                        .onChange(of: blueprintItems) { _, items in
                            Task { await loadBlueprints(items) }
                        }
                        if !blueprintImages.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(Array(blueprintImages.enumerated()), id: \.offset) { i, img in
                                        Image(uiImage: img)
                                            .resizable()
                                            .scaledToFill()
                                            .frame(width: 80, height: 60)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                            .overlay(alignment: .topTrailing) {
                                                Button {
                                                    blueprintImages.remove(at: i)
                                                    if i < blueprintItems.count { blueprintItems.remove(at: i) }
                                                } label: {
                                                    Image(systemName: "xmark.circle.fill")
                                                        .font(.caption)
                                                        .foregroundStyle(.white)
                                                        .background(Circle().fill(.black.opacity(0.5)))
                                                }
                                                .offset(x: 4, y: -4)
                                            }
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                        if uploadingBlueprints {
                            HStack(spacing: 8) {
                                ProgressView().scaleEffect(0.7)
                                Text("Subiendo planos…").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Text("Sube planos de piso, distribuciones o renders. Formatos: JPG, PNG, PDF.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }

                    FormSection(title: "Datos de Contacto", icon: "person.fill", color: Color.rdBlue) {
                        VStack(spacing: 14) {
                            FloatingField(label: "Nombre completo *", text: $contactName)
                            FloatingField(label: "Correo electrónico *", text: $contactEmail)
                                .keyboardType(.emailAddress).autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                            FloatingField(label: "Teléfono *", text: $contactPhone)
                                .keyboardType(.phonePad)
                            FormPicker(label: "Preferencia de contacto", selection: $contactPref, options: contactPrefs)
                            FormPicker(label: "Rol", selection: $role, options: roleOpts)
                        }
                    }

                    if let err = error { ErrorBanner(message: err) }

                    // ── Términos ────────────────────────────────────────
                    Toggle(isOn: $acceptedTerms) {
                        Text("Acepto los términos y condiciones de publicación")
                            .font(.subheadline)
                            .foregroundStyle(Color.rdInk)
                    }
                    .tint(Color.rdInk)
                    .padding(.horizontal, Spacing.s4)
                    if !acceptedTerms {
                        Text("Debes aceptar los términos para publicar.")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed.opacity(0.85))
                            .padding(.horizontal, Spacing.s4)
                    }

                    Color.clear.frame(height: 80)
                }
                .padding(.horizontal)
                .padding(.top, Spacing.s16)
            }
        }
        .background(Color.rdBg.ignoresSafeArea())
        .bottomCTA(title: "Publicar", isLoading: loading) {
            Task { await submit() }
        }
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: Spacing.s24) {
            Spacer()
            ZStack {
                Circle().fill(Color.rdGreen.opacity(0.12)).frame(width: 100, height: 100)
                Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Color.rdGreen)
            }
            Text("¡Propiedad enviada!")
                .font(.title2).bold()
                .foregroundStyle(Color.rdInk)
            Text("Tu propiedad está pendiente de aprobación. Nos pondremos en contacto contigo pronto.")
                .font(.subheadline)
                .foregroundStyle(Color.rdInkSoft)
                .multilineTextAlignment(.center).padding(.horizontal, Spacing.s32)
            PrimaryButton(title: "Cerrar") { dismiss() }
                .padding(.horizontal, Spacing.s32)
            Spacer()
        }
        .background(Color.rdBg.ignoresSafeArea())
    }

    // MARK: - Validation

    private var feedImageReady: Bool {
        switch feedImageMode {
        case .upload:     return feedImage != nil
        case .focalPoint: return feedFocalSet && !selectedImages.isEmpty
        }
    }

    private var canSubmit: Bool {
        !title.isEmpty && !propertyType.isEmpty && !condition.isEmpty &&
        !description.isEmpty && !price.isEmpty && !province.isEmpty &&
        !city.isEmpty && !contactName.isEmpty && !contactEmail.isEmpty && !contactPhone.isEmpty &&
        acceptedTerms && feedImageReady
    }

    // MARK: - Feed image section

    @ViewBuilder
    private var feedImageSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("El feed muestra fotos verticales (9:16). Sube una imagen vertical o elige el punto focal de una foto existente.")
                .font(.caption).foregroundStyle(.secondary)

            // Mode tabs
            HStack(spacing: 8) {
                feedTabButton(title: "Subir vertical", isOn: feedImageMode == .upload) {
                    feedImageMode = .upload
                }
                feedTabButton(title: "Usar foto existente",
                              isOn: feedImageMode == .focalPoint,
                              disabled: selectedImages.isEmpty) {
                    if !selectedImages.isEmpty { feedImageMode = .focalPoint }
                }
            }

            switch feedImageMode {
            case .upload:
                feedUploadPane
            case .focalPoint:
                feedFocalPane
            }

            HStack(spacing: 6) {
                Image(systemName: feedImageReady ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(feedImageReady ? Color.rdGreen : Color.rdOrange)
                Text(feedImageReady ? "Imagen del feed lista" : "Imagen del feed obligatoria")
                    .font(.caption2)
                    .foregroundStyle(feedImageReady ? Color.rdGreen : Color.rdInkSoft)
            }
        }
    }

    private func feedTabButton(title: String, isOn: Bool, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption).bold()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(isOn ? Color.rdBlue : Color.clear)
                .foregroundStyle(isOn ? .white : (disabled ? .secondary : Color.rdBlue))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(isOn ? Color.rdBlue : (disabled ? Color(.systemGray4) : Color.rdBlue.opacity(0.5)), lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }

    private var feedUploadPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            PhotosPicker(selection: $feedPhotoItem, matching: .images) {
                HStack {
                    Image(systemName: "rectangle.portrait.and.arrow.right.fill")
                        .foregroundStyle(Color.rdInk)
                    Text(feedImage == nil ? "Seleccionar imagen vertical (9:16)" : "Cambiar imagen")
                        .foregroundStyle(Color.rdInk)
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(Color.rdInkSoft)
                }
                .frame(minHeight: 44)
            }
            .onChange(of: feedPhotoItem) { _, item in
                Task { await loadFeedImage(item) }
            }

            if let img = feedImage {
                HStack {
                    Spacer()
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 120, height: 213) // 9:16
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12).stroke(Color.rdBlue.opacity(0.3), lineWidth: 1)
                        )
                    Spacer()
                }
                Text("Recomendado: 1080×1920. Si no es 9:16 se recortará al centro automáticamente.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var feedFocalPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let firstImg = selectedImages.first {
                GeometryReader { geo in
                    ZStack(alignment: .topLeading) {
                        Image(uiImage: firstImg)
                            .resizable()
                            .scaledToFit()
                            .frame(width: geo.size.width)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .contentShape(Rectangle())
                            .onTapGesture { location in
                                let displayed = displayedImageRect(for: firstImg, in: geo.size)
                                guard displayed.contains(location) else { return }
                                feedFocalX = Double((location.x - displayed.minX) / displayed.width)
                                feedFocalY = Double((location.y - displayed.minY) / displayed.height)
                                feedFocalX = min(max(feedFocalX, 0), 1)
                                feedFocalY = min(max(feedFocalY, 0), 1)
                                feedFocalSet = true
                            }

                        if feedFocalSet {
                            let displayed = displayedImageRect(for: firstImg, in: geo.size)
                            let cropRect = focalCropRect(in: displayed)
                            // 9:16 crop preview
                            Rectangle()
                                .stroke(Color.rdBlue, lineWidth: 2)
                                .frame(width: cropRect.width, height: cropRect.height)
                                .offset(x: cropRect.minX, y: cropRect.minY)
                            // Focal marker
                            Circle()
                                .stroke(Color.white, lineWidth: 3)
                                .background(Circle().fill(Color.black.opacity(0.3)))
                                .frame(width: 24, height: 24)
                                .offset(
                                    x: displayed.minX + CGFloat(feedFocalX) * displayed.width - 12,
                                    y: displayed.minY + CGFloat(feedFocalY) * displayed.height - 12
                                )
                        }
                    }
                }
                .frame(height: feedFocalImageHeight(for: firstImg))

                Text(feedFocalSet
                     ? "Vista previa del recorte 9:16 · Toca otra zona para ajustar"
                     : "Toca la imagen para marcar el punto focal")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                Text("Sube primero al menos una foto de la propiedad para usar esta opción.")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            }
        }
    }

    /// Aspect-fit rect of a UIImage drawn into the given container size.
    private func displayedImageRect(for image: UIImage, in container: CGSize) -> CGRect {
        let imgRatio = image.size.width / max(image.size.height, 1)
        let boxRatio = container.width / max(container.height, 1)
        var w: CGFloat, h: CGFloat
        if imgRatio > boxRatio {
            w = container.width
            h = container.width / imgRatio
        } else {
            h = container.height
            w = container.height * imgRatio
        }
        let x = (container.width - w) / 2
        let y = (container.height - h) / 2
        return CGRect(x: x, y: y, width: w, height: h)
    }

    /// 9:16 crop rect inside the displayed image, clamped to image bounds.
    private func focalCropRect(in displayed: CGRect) -> CGRect {
        let target: CGFloat = 9.0 / 16.0
        var cw: CGFloat, ch: CGFloat
        if displayed.width / displayed.height > target {
            ch = displayed.height
            cw = ch * target
        } else {
            cw = displayed.width
            ch = cw / target
        }
        var cx = displayed.minX + CGFloat(feedFocalX) * displayed.width  - cw / 2
        var cy = displayed.minY + CGFloat(feedFocalY) * displayed.height - ch / 2
        cx = max(displayed.minX, min(cx, displayed.maxX - cw))
        cy = max(displayed.minY, min(cy, displayed.maxY - ch))
        return CGRect(x: cx, y: cy, width: cw, height: ch)
    }

    /// Approximate display height for the focal-point image so the
    /// GeometryReader has a sensible intrinsic frame.
    private func feedFocalImageHeight(for image: UIImage) -> CGFloat {
        let assumedWidth: CGFloat = 320 // typical content width on iPhone
        let r = image.size.height / max(image.size.width, 1)
        return min(420, max(180, assumedWidth * r))
    }

    private func loadFeedImage(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        if let data = try? await item.loadTransferable(type: Data.self),
           let img = UIImage(data: data) {
            await MainActor.run { feedImage = img }
        }
    }

    /// Upload the feed image to the photos endpoint and return its URL.
    private func uploadFeedImage() async throws -> String? {
        guard let img = feedImage else { return nil }
        guard let token = api.token else { return nil }
        guard let jpeg = img.jpegData(compressionQuality: 0.9) else { return nil }

        let boundary = UUID().uuidString
        var request = URLRequest(url: URL(string: "\(apiBase)/api/upload/photos")!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let safeFilename = sanitizeMultipartFilename("feed.jpg")
        var data = Data()
        data.append(("--\(boundary)\r\n").data(using: .utf8) ?? Data())
        data.append(("Content-Disposition: form-data; name=\"photos\"; filename=\"\(safeFilename)\"\r\n").data(using: .utf8) ?? Data())
        data.append(("Content-Type: image/jpeg\r\n\r\n").data(using: .utf8) ?? Data())
        data.append(jpeg)
        data.append(("\r\n--\(boundary)--\r\n").data(using: .utf8) ?? Data())
        request.httpBody = data

        let (responseData, resp) = try await URLSession.shared.data(for: request)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.server("Error subiendo imagen del feed")
        }
        struct UploadResponse: Decodable { let urls: [String] }
        return try JSONDecoder().decode(UploadResponse.self, from: responseData).urls.first
    }

    private var deliveryDateFormatted: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM"
        return fmt.string(from: deliveryDate)
    }

    // MARK: - Submit

    /// Load selected photos from PhotosPicker into UIImage array
    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        var images: [UIImage] = []
        for item in items.prefix(30) {
            if let data = try? await item.loadTransferable(type: Data.self),
               let img = UIImage(data: data) {
                images.append(img)
            }
        }
        await MainActor.run { selectedImages = images }
    }

    /// Upload selected photos to server, returns array of URL strings
    private func uploadPhotos() async throws -> [String] {
        guard !selectedImages.isEmpty else { return [] }
        guard let token = api.token else { return [] }
        await MainActor.run { uploadingPhotos = true }
        defer { Task { @MainActor in uploadingPhotos = false } }

        let boundary = UUID().uuidString
        var request = URLRequest(url: URL(string: "\(apiBase)/api/upload/photos")!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var data = Data()
        for (i, img) in selectedImages.enumerated() {
            guard let jpeg = img.jpegData(compressionQuality: 0.8) else { continue }
            let safeFilename = sanitizeMultipartFilename("photo\(i).jpg")
            data.append(("--\(boundary)\r\n").data(using: .utf8) ?? Data())
            data.append(("Content-Disposition: form-data; name=\"photos\"; filename=\"\(safeFilename)\"\r\n").data(using: .utf8) ?? Data())
            data.append(("Content-Type: image/jpeg\r\n\r\n").data(using: .utf8) ?? Data())
            data.append(jpeg)
            data.append(("\r\n").data(using: .utf8) ?? Data())
        }
        data.append(("--\(boundary)--\r\n").data(using: .utf8) ?? Data())
        request.httpBody = data

        let (responseData, resp) = try await URLSession.shared.data(for: request)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.server("Error subiendo fotos")
        }
        struct UploadResponse: Decodable { let urls: [String] }
        let result = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        return result.urls
    }

    private func loadBlueprints(_ items: [PhotosPickerItem]) async {
        var images: [UIImage] = []
        for item in items.prefix(5) {
            if let data = try? await item.loadTransferable(type: Data.self),
               let img = UIImage(data: data) {
                images.append(img)
            }
        }
        await MainActor.run { blueprintImages = images }
    }

    private func uploadBlueprints() async throws -> [String] {
        guard !blueprintImages.isEmpty else { return [] }
        guard let token = api.token else { return [] }
        await MainActor.run { uploadingBlueprints = true }
        defer { Task { @MainActor in uploadingBlueprints = false } }

        let boundary = UUID().uuidString
        var request = URLRequest(url: URL(string: "\(apiBase)/api/upload/blueprints")!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var data = Data()
        for (i, img) in blueprintImages.enumerated() {
            guard let jpeg = img.jpegData(compressionQuality: 0.9) else { continue }
            let safeFilename = sanitizeMultipartFilename("blueprint\(i).jpg")
            data.append(("--\(boundary)\r\n").data(using: .utf8) ?? Data())
            data.append(("Content-Disposition: form-data; name=\"blueprints\"; filename=\"\(safeFilename)\"\r\n").data(using: .utf8) ?? Data())
            data.append(("Content-Type: image/jpeg\r\n\r\n").data(using: .utf8) ?? Data())
            data.append(jpeg)
            data.append(("\r\n").data(using: .utf8) ?? Data())
        }
        data.append(("--\(boundary)--\r\n").data(using: .utf8) ?? Data())
        request.httpBody = data

        let (responseData, resp) = try await URLSession.shared.data(for: request)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.server("Error subiendo planos")
        }
        struct UploadResponse: Decodable { let urls: [String] }
        return try JSONDecoder().decode(UploadResponse.self, from: responseData).urls
    }

    private func addCustomAmenity() {
        let trimmed = customAmenityText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        if !customAmenities.contains(trimmed) {
            customAmenities.append(trimmed)
        }
        customAmenityText = ""
    }

    private func submit() async {
        loading = true; error = nil

        // Upload photos first
        do {
            uploadedPhotoURLs = try await uploadPhotos()
        } catch {
            self.error = "Error subiendo fotos: \(error.localizedDescription)"
            loading = false
            return
        }

        // Upload blueprints
        do {
            uploadedBlueprintURLs = try await uploadBlueprints()
        } catch {
            self.error = "Error subiendo planos: \(error.localizedDescription)"
            loading = false
            return
        }

        var body: [String: Any] = [
            "submission_type": "new_property",
            "type":            listingType,
            "title":           title,
            "property_type":   propertyType,
            "condition":       condition,
            "description":     description,
            "price":           price,
            "currency":        currency,
            "area_const":      areaConst,
            "area_land":       areaLand,
            "bedrooms":        bedrooms,
            "bathrooms":       bathrooms,
            "parking":         parking,
            "province":        province,
            "city":            city,
            "sector":          sector,
            "address":         address,
            "amenities":       Array(selectedAmenities) + customAmenities,
            "tags":            Array(selectedTags),
            "name":            contactName,
            "email":           contactEmail,
            "phone":           contactPhone,
            "construction_company": constructionCompany,
            "units_total":     unitsTotal,
            "units_available": unitsAvailable,
            "delivery_date":   deliveryDateFormatted,
            "project_stage":   projectStage,
            "floors":          floors,
            "floor_num":       floorNumber,
            "year_built":      yearBuilt,
            "reference_point": referencePoint,
            "contact_pref":    contactPref,
            "role":            role,
            "images":          uploadedPhotoURLs,
            "blueprints":      uploadedBlueprintURLs,
        ]
        if priceRangeEnabled && !priceMax.isEmpty {
            body["priceMax"] = priceMax
        }
        if let coord = coordinate {
            body["lat"] = coord.latitude
            body["lng"] = coord.longitude
        }
        if !unitTypes.isEmpty {
            body["unit_types"] = unitTypes.map {
                let ids = $0.unitIds.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                return ["name": $0.name, "bedrooms": $0.bedrooms, "bathrooms": $0.bathrooms,
                 "area": $0.area, "price": $0.price, "available": $0.available,
                 "floor": $0.floor, "phase": $0.phase, "unitIds": ids] as [String: Any]
            }
        }
        if let user = api.currentUser, user.isAgency {
            body["agencies"] = [[
                "name": user.agencyName ?? user.name, "agent": user.name,
                "email": user.email, "phone": contactPhone
            ]]
        }
        do {
            let listingId = try await api.submitListing(body)
            // ── Feed image (mandatory) ─────────────────────────────
            // Listing is created on the server; now attach the feed image.
            // If this fails we surface the error and let the user retry —
            // we do NOT mark success until the feed image is saved.
            if !listingId.isEmpty {
                if feedImageMode == .upload {
                    if let feedUrl = try await uploadFeedImage() {
                        try await api.setFeedImageFromUpload(listingId: listingId, feedImageUrl: feedUrl)
                    } else {
                        throw APIError.server("No se pudo subir la imagen del feed")
                    }
                } else {
                    try await api.setFeedImageFromFocalPoint(
                        listingId: listingId,
                        imageIndex: feedFocalIndex,
                        x: feedFocalX, y: feedFocalY
                    )
                }
            }
            await MainActor.run { success = true }
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    /// Strip characters that can break a multipart `filename="…"` header
    /// (quotes, control chars, surrogate-pair fragments). PHPicker filenames
    /// occasionally contain non-UTF-8-encodable bytes — sanitize before
    /// embedding into a header string.
    private func sanitizeMultipartFilename(_ filename: String) -> String {
        let safe = filename
            .replacingOccurrences(of: "\"", with: "_")
            .components(separatedBy: .controlCharacters)
            .joined()
        return safe.isEmpty ? "upload.bin" : safe
    }
}

// MARK: - Unit Type Row

struct UnitTypeRow: View {
    @Binding var unit: UnitType
    var onDelete: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Tipo de unidad").font(.caption).bold().foregroundStyle(Color.rdBlue)
                Spacer()
                Button { onDelete() } label: {
                    Image(systemName: "trash").font(.caption).foregroundStyle(Color.rdRed)
                }
                .buttonStyle(.plain)
            }

            FloatingField(label: "Nombre (ej. 1BR, 2BR, Penthouse)", text: $unit.name)

            HStack(spacing: 10) {
                FloatingField(label: "Hab.", text: $unit.bedrooms).keyboardType(.numberPad)
                FloatingField(label: "Baños", text: $unit.bathrooms).keyboardType(.numberPad)
                FloatingField(label: "Área m²", text: $unit.area).keyboardType(.numberPad)
            }
            HStack(spacing: 10) {
                FloatingField(label: "Precio USD", text: $unit.price).keyboardType(.numberPad)
                FloatingField(label: "Disponibles", text: $unit.available).keyboardType(.numberPad)
            }
            HStack(spacing: 10) {
                FloatingField(label: "Piso / Nivel", text: $unit.floor).keyboardType(.numberPad)
                FloatingField(label: "Etapa", text: $unit.phase)
            }

            // Unit IDs — shown when available count > 0
            if let count = Int(unit.available), count > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("IDs de las unidades (uno por línea)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.rdInk)
                    Text("Ej: Apt 1A, Apt 2A… Dejar vacío para generar automáticamente.")
                        .font(.caption2)
                        .foregroundStyle(Color.rdInkSoft)
                    TextEditor(text: $unit.unitIds)
                        .font(.subheadline)
                        .frame(minHeight: 60)
                        .padding(6)
                        .background(Color.rdSurfaceMuted)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding()
        .background(Color.rdBlue.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.rdBlue.opacity(0.15), lineWidth: 1))
    }
}

// MARK: - Location Picker

struct LocationPickerView: View {
    @Binding var coordinate: CLLocationCoordinate2D?
    var searchHint: String

    private static let drCenter = CLLocationCoordinate2D(latitude: 18.7357, longitude: -70.1627)

    @State private var position: MapCameraPosition = .region(MKCoordinateRegion(
        center: drCenter, span: MKCoordinateSpan(latitudeDelta: 4, longitudeDelta: 4)
    ))
    @State private var searchText = ""
    @State private var isSearching = false

    var body: some View {
        VStack(spacing: 10) {
            // Search bar
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Buscar dirección o lugar...", text: $searchText)
                    .font(.subheadline)
                    .onSubmit { Task { await geocode(searchText) } }
                if isSearching {
                    ProgressView().scaleEffect(0.75)
                } else if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // Auto-fill hint
            if !searchHint.isEmpty && searchText.isEmpty {
                Button {
                    searchText = searchHint
                    Task { await geocode(searchHint) }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "location.circle").font(.caption)
                        Text("Usar dirección del formulario")
                            .font(.caption)
                    }
                    .foregroundStyle(Color.rdBlue)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Map
            MapReader { proxy in
                Map(position: $position) {
                    if let coord = coordinate {
                        Annotation("Propiedad", coordinate: coord, anchor: .bottom) {
                            VStack(spacing: 0) {
                                ZStack {
                                    Circle()
                                        .fill(Color.rdRed)
                                        .frame(width: 32, height: 32)
                                        .shadow(radius: 4)
                                    Image(systemName: "house.fill")
                                        .font(.system(size: 15))
                                        .foregroundStyle(.white)
                                }
                                Image(systemName: "arrowtriangle.down.fill")
                                    .font(.system(size: 8))
                                    .foregroundStyle(Color.rdRed)
                                    .offset(y: -2)
                            }
                        }
                    }
                }
                .frame(height: 260)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator), lineWidth: 1))
                .onTapGesture { point in
                    if let coord = proxy.convert(point, from: .local) {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            coordinate = coord
                            position = .region(MKCoordinateRegion(
                                center: coord,
                                span: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)
                            ))
                        }
                    }
                }
            }

            // Coordinate readout
            if let coord = coordinate {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.rdGreen).font(.caption)
                    Text(String(format: "%.5f°, %.5f°", coord.latitude, coord.longitude))
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Quitar") {
                        coordinate = nil
                        position = .region(MKCoordinateRegion(
                            center: Self.drCenter,
                            span: MKCoordinateSpan(latitudeDelta: 4, longitudeDelta: 4)
                        ))
                    }
                    .font(.caption).foregroundStyle(Color.rdRed)
                    .buttonStyle(.plain)
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "hand.tap").foregroundStyle(.secondary).font(.caption)
                    Text("Toca el mapa para marcar la ubicación exacta")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func geocode(_ query: String) async {
        guard !query.isEmpty else { return }
        isSearching = true
        let geocoder = CLGeocoder()
        let fullQuery = query.lowercased().contains("república") ? query : "\(query), República Dominicana"
        if let placemarks = try? await geocoder.geocodeAddressString(fullQuery),
           let loc = placemarks.first?.location {
            let coord = loc.coordinate
            await MainActor.run {
                coordinate = coord
                position = .region(MKCoordinateRegion(
                    center: coord,
                    span: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)
                ))
            }
        }
        isSearching = false
    }
}

// MARK: - Form Section wrapper
//
// Thin wrapper around `FormCard` from the design system so the existing
// (icon, color)-tinted section header semantics survive while gaining
// the editorial cream surface, divider rhythm, and Dynamic Type support.

struct FormSection<Content: View>: View {
    let title: String
    let icon: String
    let color: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s8) {
            HStack(spacing: Spacing.s8) {
                Image(systemName: icon).font(.callout).foregroundStyle(color)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.rdInk)
            }
            .padding(.horizontal, Spacing.s4)

            VStack(alignment: .leading) {
                content()
            }
            .padding(Spacing.s16)
            .background(
                RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                    .fill(Color.rdSurface)
            )
        }
    }
}

// MARK: - Form Picker

struct FormPicker: View {
    let label: String
    @Binding var selection: String
    let options: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.rdInkSoft)
                .kerning(0.5)
            Menu {
                Button("— Seleccionar —") { selection = "" }
                ForEach(options, id: \.self) { opt in Button(opt) { selection = opt } }
            } label: {
                HStack {
                    Text(selection.isEmpty ? "Seleccionar" : selection)
                        .foregroundStyle(selection.isEmpty ? Color.rdInkSoft : Color.rdInk)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                }
                .padding(.horizontal, Spacing.s12)
                .padding(.vertical, Spacing.s12)
                .frame(minHeight: 44)
                .background(Color.rdSurfaceMuted)
                .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
            }
            .accessibilityLabel(label)
        }
    }
}

// MARK: - Tag Picker

struct TagPickerView: View {
    @Binding var selected: Set<String>
    @State private var searchText = ""

    private typealias TagEntry = (tag: String, group: String)
    private let allTags: [TagEntry] = [
        ("Vista al mar","Ubicación y Vistas"),("Primera línea de playa","Ubicación y Vistas"),
        ("A pasos de la playa","Ubicación y Vistas"),("Vista panorámica","Ubicación y Vistas"),
        ("Frente al campo de golf","Ubicación y Vistas"),("Zona montañosa / fresca","Ubicación y Vistas"),
        ("Zona turística","Zona"),("Zona residencial cerrada","Zona"),("Centro de la ciudad","Zona"),
        ("Barrio tranquilo","Zona"),("Cerca de autopista","Zona"),("Zona en desarrollo","Zona"),
        ("Con generador","Servicios Esenciales"),("Con inversor / batería","Servicios Esenciales"),
        ("Con paneles solares","Servicios Esenciales"),("Con cisterna","Servicios Esenciales"),
        ("Con bomba de agua","Servicios Esenciales"),("Vigilancia 24 horas","Servicios Esenciales"),
        ("Con verja / seguridad privada","Servicios Esenciales"),
        ("Apto para familias","Estilo de Vida"),("Pet friendly","Estilo de Vida"),
        ("Cerca de colegios","Estilo de Vida"),("Cerca de hospitales","Estilo de Vida"),
        ("Cerca de centros comerciales","Estilo de Vida"),("Cerca de supermercados","Estilo de Vida"),
        ("Vida nocturna cercana","Estilo de Vida"),
        ("Alta rentabilidad","Inversión"),("Apto para Airbnb","Inversión"),
        ("Alquiler vacacional","Inversión"),("Zona de revalorización","Inversión"),
        ("Precio de oportunidad","Inversión"),("Proyecto de lujo","Inversión"),
        ("Amueblado","Características"),("Remodelado / Renovado","Características"),
        ("Listo para mudarse","Características"),("Con piscina privada","Características"),
        ("Con piscina comunitaria","Características"),("Con terraza / balcón amplio","Características"),
        ("Con área de BBQ","Características"),("Acceso a playa privada","Características")
    ]

    private var results: [TagEntry] {
        guard !searchText.isEmpty else { return [] }
        return allTags.filter {
            $0.tag.localizedCaseInsensitiveContains(searchText) ||
            $0.group.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {

            // Selected chips
            if !selected.isEmpty {
                FlowLayout(spacing: 8) {
                    ForEach(Array(selected).sorted(), id: \.self) { tag in
                        Button { selected.remove(tag) } label: {
                            HStack(spacing: 4) {
                                Text(tag).font(.caption).fontWeight(.semibold)
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                            }
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                Divider()
            }

            // Search bar
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.subheadline)
                TextField("Buscar etiqueta (ej. mar, piscina, airbnb)…", text: $searchText)
                    .font(.subheadline)
                    .autocorrectionDisabled()
                if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // Results
            if searchText.isEmpty {
                if selected.isEmpty {
                    Text("Escribe para buscar entre las \(allTags.count) etiquetas disponibles.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if results.isEmpty {
                Text("No se encontraron etiquetas para \"\(searchText)\"")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                FlowLayout(spacing: 8) {
                    ForEach(results, id: \.tag) { item in
                        let on = selected.contains(item.tag)
                        Button {
                            if on { selected.remove(item.tag) } else { selected.insert(item.tag) }
                        } label: {
                            HStack(spacing: 4) {
                                if on {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 9, weight: .bold))
                                }
                                Text(item.tag)
                                    .font(.caption)
                                    .fontWeight(on ? .semibold : .regular)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(on ? Color.rdBlue : Color(.secondarySystemBackground))
                            .foregroundStyle(on ? .white : Color(.label))
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(on ? Color.rdBlue : Color(.separator), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

// MARK: - Flow Chips

struct FlowChips: View {
    let items: [(String,String)]
    @Binding var selected: Set<String>

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(items, id: \.0) { (key, label) in
                let on = selected.contains(key)
                Button {
                    if on { selected.remove(key) } else { selected.insert(key) }
                } label: {
                    Text(label)
                        .font(.caption).fontWeight(on ? .semibold : .regular)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(on ? Color.rdBlue : Color(.secondarySystemBackground))
                        .foregroundStyle(on ? Color.white : Color(.label))
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(on ? Color.rdBlue : Color(.separator), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
