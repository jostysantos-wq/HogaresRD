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
    var unitIds   = ""   // newline-separated IDs (e.g. "Apt 1A\nApt 2A\nApt 3A")
}

// MARK: - Submit Listing View

struct SubmitListingView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    // Transaction type
    @State private var listingType = "venta"

    // Basic info
    @State private var title       = ""
    @State private var propertyType = ""
    @State private var condition   = ""
    @State private var description = ""

    // Price & size
    @State private var price     = ""
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

    // Tags
    @State private var selectedTags: Set<String> = []

    // Photos
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var selectedImages: [UIImage] = []
    @State private var uploadedPhotoURLs: [String] = []
    @State private var uploadingPhotos = false

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

    // Options
    private let listingTypes   = [("venta","En Venta"),("alquiler","En Alquiler"),("proyecto","Proyecto")]
    private let propertyTypes  = ["Casa","Apartamento","Villa","Penthouse","Solar / Terreno","Local Comercial","Finca"]
    private let conditions     = ["Nueva construcción","En planos","Excelente estado","Buen estado","Necesita remodelación"]
    private let bedroomOpts    = ["Estudio","1","2","3","4","5","6+"]
    private let bathroomOpts   = ["1","1.5","2","2.5","3","4+"]
    private let parkingOpts    = ["0","1","2","3","4+"]
    private let floorsOpts     = ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20+"]
    private let projectStages  = ["En planos","En construcción","Listo para entrega"]
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
        ("piscina","Piscina"),("jacuzzi","Jacuzzi"),("gym","Gimnasio"),("bbq","Área BBQ"),
        ("balcon","Balcón / Terraza"),("jardin","Jardín"),("ac","Aire Acondicionado"),
        ("planta","Planta Eléctrica"),("cisterna","Cisterna / Bomba"),("seguridad","Vigilancia 24/7"),
        ("camaras","Cámaras CCTV"),("elevador","Elevador"),("amueblado","Amueblado"),
        ("semi_amueblado","Semi-amueblado"),("paneles_solares","Paneles Solares"),
        ("vista_mar","Vista al Mar"),("frente_mar","Frente al Mar"),("cancha","Cancha Deportiva")
    ]

    private var needsBedsBaths: Bool {
        !["Solar / Terreno","Local Comercial","Finca"].contains(propertyType)
    }

    var body: some View {
        NavigationStack {
            Group {
                if success { successView } else { formView }
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
                                    .font(.system(size:10,weight:.bold))
                                    .foregroundStyle(Color(.tertiaryLabel)).kerning(0.5)
                                TextEditor(text: $description)
                                    .frame(minHeight: 110)
                                    .padding(10)
                                    .background(Color(.secondarySystemBackground))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
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
                                FloatingField(label: "Constructora / Empresa", text: $constructionCompany)
                                HStack(spacing: 12) {
                                    FloatingField(label: "Total de Unidades", text: $unitsTotal)
                                        .keyboardType(.numberPad)
                                    FloatingField(label: "Unidades Disponibles", text: $unitsAvailable)
                                        .keyboardType(.numberPad)
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("FECHA DE ENTREGA")
                                        .font(.system(size:10,weight:.bold))
                                        .foregroundStyle(Color(.tertiaryLabel)).kerning(0.5)
                                    DatePicker("", selection: $deliveryDate, displayedComponents: .date)
                                        .datePickerStyle(.compact)
                                        .labelsHidden()
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
                            FloatingField(label: "Precio (USD) *", text: $price)
                                .keyboardType(.numberPad)
                            HStack(spacing: 12) {
                                FloatingField(label: "Área Construida (m²)", text: $areaConst)
                                    .keyboardType(.numberPad)
                                FloatingField(label: "Área Terreno (m²)", text: $areaLand)
                                    .keyboardType(.numberPad)
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
                    }

                    // ── Etiquetas ────────────────────────────────────────
                    FormSection(title: "Etiquetas", icon: "tag.fill", color: Color.rdRed) {
                        TagPickerView(selected: $selectedTags)
                    }

                    // ── Contacto ────────────────────────────────────────
                    // ── Photos ──
                    FormSection(title: "Fotos de la propiedad", icon: "camera.fill", color: .orange) {
                        PhotosPicker(selection: $selectedPhotoItems,
                                     maxSelectionCount: 5,
                                     matching: .images) {
                            HStack {
                                Image(systemName: "photo.on.rectangle.angled")
                                Text(selectedImages.isEmpty ? "Seleccionar fotos (máx. 5)" : "\(selectedImages.count) foto(s) seleccionada(s)")
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(.secondary)
                            }
                        }
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
                    }
                    .tint(Color.rdBlue)
                    .padding(.horizontal, 4)

                    // ── Submit ───────────────────────────────────────────
                    Button { Task { await submit() } } label: {
                        Group {
                            if loading { ProgressView().tint(.white) }
                            else {
                                HStack(spacing: 8) {
                                    Image(systemName: "paperplane.fill")
                                    Text("Publicar Propiedad").fontWeight(.bold)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity).padding()
                        .background(canSubmit && !loading ? Color.rdRed : Color(.systemGray4))
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(!canSubmit || loading)
                    .padding(.bottom, 40)
                }
                .padding(.horizontal)
                .padding(.top, 20)
            }
        }
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: 24) {
            Spacer()
            ZStack {
                Circle().fill(Color.rdGreen.opacity(0.12)).frame(width: 100, height: 100)
                Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Color.rdGreen)
            }
            Text("¡Propiedad Enviada!").font(.title2).bold()
            Text("Tu propiedad está pendiente de aprobación. Nos pondremos en contacto contigo pronto.")
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal, 32)
            Button("Cerrar") { dismiss() }
                .font(.headline).frame(maxWidth: .infinity).padding()
                .background(Color.rdBlue).foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14)).padding(.horizontal, 32)
            Spacer()
        }
    }

    // MARK: - Validation

    private var canSubmit: Bool {
        !title.isEmpty && !propertyType.isEmpty && !condition.isEmpty &&
        !description.isEmpty && !price.isEmpty && !province.isEmpty &&
        !city.isEmpty && !contactName.isEmpty && !contactEmail.isEmpty && !contactPhone.isEmpty &&
        acceptedTerms
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
        for item in items.prefix(5) {
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
            data.append("--\(boundary)\r\n".data(using: .utf8)!)
            data.append("Content-Disposition: form-data; name=\"photos\"; filename=\"photo\(i).jpg\"\r\n".data(using: .utf8)!)
            data.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
            data.append(jpeg)
            data.append("\r\n".data(using: .utf8)!)
        }
        data.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = data

        let (responseData, resp) = try await URLSession.shared.data(for: request)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.server("Error subiendo fotos")
        }
        struct UploadResponse: Decodable { let urls: [String] }
        let result = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        return result.urls
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

        var body: [String: Any] = [
            "submission_type": "new_property",
            "type":            listingType,
            "title":           title,
            "property_type":   propertyType,
            "condition":       condition,
            "description":     description,
            "price":           price,
            "area_const":      areaConst,
            "area_land":       areaLand,
            "bedrooms":        bedrooms,
            "bathrooms":       bathrooms,
            "parking":         parking,
            "province":        province,
            "city":            city,
            "sector":          sector,
            "address":         address,
            "amenities":       Array(selectedAmenities),
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
        ]
        if let coord = coordinate {
            body["lat"] = coord.latitude
            body["lng"] = coord.longitude
        }
        if !unitTypes.isEmpty {
            body["unit_types"] = unitTypes.map {
                let ids = $0.unitIds.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                return ["name": $0.name, "bedrooms": $0.bedrooms, "bathrooms": $0.bathrooms,
                 "area": $0.area, "price": $0.price, "available": $0.available,
                 "unitIds": ids] as [String: Any]
            }
        }
        if let user = api.currentUser, user.isAgency {
            body["agencies"] = [[
                "name": user.agencyName ?? user.name, "agent": user.name,
                "email": user.email, "phone": contactPhone
            ]]
        }
        do {
            try await api.submitListing(body)
            await MainActor.run { success = true }
        } catch { self.error = error.localizedDescription }
        loading = false
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

            // Unit IDs — shown when available count > 0
            if let count = Int(unit.available), count > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("IDs de las unidades (uno por línea)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color(.label))
                    Text("Ej: Apt 1A, Apt 2A… Dejar vacío para generar automáticamente.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $unit.unitIds)
                        .font(.system(size: 14))
                        .frame(minHeight: 60)
                        .padding(6)
                        .background(Color(.secondarySystemBackground))
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

struct FormSection<Content: View>: View {
    let title: String
    let icon: String
    let color: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.callout).foregroundStyle(color)
                Text(title).font(.subheadline).bold()
            }
            content()
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: Color.rdBlue.opacity(0.06), radius: 6, y: 2)
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
                .font(.system(size:10,weight:.bold)).foregroundStyle(Color(.tertiaryLabel)).kerning(0.5)
            Menu {
                Button("— Seleccionar —") { selection = "" }
                ForEach(options, id: \.self) { opt in Button(opt) { selection = opt } }
            } label: {
                HStack {
                    Text(selection.isEmpty ? "Seleccionar" : selection)
                        .foregroundStyle(selection.isEmpty ? Color(.placeholderText) : Color(.label))
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Color(.tertiaryLabel))
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
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
