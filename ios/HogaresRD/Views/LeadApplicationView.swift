import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Multi-step application form — mirrors the redesigned web apply modal.
/// Steps:
///   1. Contact + intent
///   2. Personal + employment + co-applicant
///   3. Documents (attach now / defer / skip)
struct LeadApplicationView: View {
    let listing: Listing
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    // ── Step state ───────────────────────────────────────────────
    @State private var currentStep = 1
    private let stepCount = 3

    // ── Step 1: Contact & intent ─────────────────────────────────
    @State private var name          = ""
    @State private var phone         = ""
    @State private var email         = ""
    @State private var intent        = "comprar"
    @State private var timeline      = "1-3 meses"
    @State private var budget        = ""
    @State private var contactMethod = "whatsapp"

    // ── Step 2: Personal / employment / co-applicant ─────────────
    @State private var idType          = ""
    @State private var idNumber        = ""
    @State private var nationality     = ""
    @State private var dob             = Date()
    @State private var dobSet          = false
    @State private var currentAddress  = ""
    @State private var employmentStatus = ""
    @State private var employer        = ""
    @State private var jobTitle        = ""
    @State private var monthlyIncome   = ""
    @State private var incomeCurrency  = "DOP"
    @State private var financing       = ""
    @State private var preApproved     = false
    @State private var hasCoapp        = false
    @State private var coappName       = ""
    @State private var coappPhone      = ""
    @State private var coappId         = ""
    @State private var coappIncome     = ""
    @State private var notes           = ""

    // ── Step 3: Documents ────────────────────────────────────────
    enum DocState: Equatable {
        case skipped
        case deferred
        case attached(data: Data, filename: String)
    }

    struct DocSlot: Identifiable {
        let id = UUID()
        let type: String
        let label: String
        let required: Bool
    }

    private let docSlots: [DocSlot] = [
        DocSlot(type: "cedula",            label: "Cédula de Identidad o Pasaporte",     required: true),
        DocSlot(type: "income_proof",      label: "Comprobante de Ingresos",              required: true),
        DocSlot(type: "employment_letter", label: "Carta de Trabajo",                     required: false),
        DocSlot(type: "bank_statement",    label: "Estado de Cuenta Bancario (3 meses)",  required: false),
        DocSlot(type: "pre_approval",      label: "Carta de Pre-Aprobación Bancaria",     required: false),
        DocSlot(type: "tax_return",        label: "Declaración de Impuestos",             required: false),
    ]

    @State private var docStates: [String: DocState] = [:]
    @State private var pickerTargetSlot: DocSlot?
    @State private var photoPickerItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false

    // ── Submit state ─────────────────────────────────────────────
    @State private var submitting = false
    @State private var submitted  = false
    @State private var errorMsg   = ""
    @State private var hadDeferredOnSuccess = false

    // MARK: - Body

    var body: some View {
        NavigationStack {
            if submitted {
                successView
            } else {
                formShell
            }
        }
        .onAppear(perform: prefillFromCurrentUser)
    }

    private func prefillFromCurrentUser() {
        if docStates.isEmpty {
            for slot in docSlots { docStates[slot.type] = .skipped }
        }
        if let me = api.currentUser {
            if name.isEmpty  { name  = me.name }
            if email.isEmpty { email = me.email }
        }
    }

    // MARK: - Shell

    private var formShell: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    listingPill
                    Group {
                        if currentStep == 1 { step1 }
                        else if currentStep == 2 { step2 }
                        else { step3 }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 24)
            }
            footer
        }
        .navigationTitle("Aplicar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cerrar") { dismiss() }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Progress dots
            HStack(spacing: 6) {
                ForEach(1...stepCount, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(i <= currentStep ? Color.rdBlue : Color(.systemGray5))
                        .frame(height: 5)
                }
            }
            HStack {
                Text("Paso \(currentStep) de \(stepCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(stepName(currentStep))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .textCase(.uppercase)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(Color(.systemBackground))
    }

    private func stepName(_ step: Int) -> String {
        switch step {
        case 1: return "Contacto e intención"
        case 2: return "Datos personales"
        case 3: return "Documentos"
        default: return ""
        }
    }

    private var listingPill: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.rdBlue)
                    .frame(width: 36, height: 36)
                Image(systemName: "house.fill")
                    .foregroundStyle(.white)
                    .font(.system(size: 16))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(listing.title)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                if !listing.price.isEmpty, let priceNum = Double(listing.price), priceNum > 0 {
                    Text("$\(Int(priceNum).formatted())\(listing.type == "alquiler" ? "/mes" : "")")
                        .font(.caption)
                        .foregroundStyle(Color.rdBlue)
                        .bold()
                }
            }
            Spacer()
        }
        .padding(12)
        .background(Color.rdBlue.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.rdBlue.opacity(0.25), lineWidth: 1)
        )
    }

    // MARK: - Step 1

    private var step1: some View {
        VStack(alignment: .leading, spacing: 18) {
            sectionTitle("Tus datos de contacto")
            field("Nombre completo *") {
                TextField("Nombre y apellido", text: $name)
                    .textContentType(.name)
            }
            HStack(spacing: 10) {
                field("Teléfono *") {
                    TextField("809-555-0000", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                }
                field("Correo") {
                    TextField("tu@email.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .autocapitalization(.none)
                }
            }

            sectionTitle("¿Qué te interesa?")
            HStack(spacing: 10) {
                menuField(label: "Intención", selection: $intent, options: [
                    ("comprar","Comprar"), ("alquilar","Alquilar"), ("invertir","Invertir")
                ])
                menuField(label: "Plazo", selection: $timeline, options: [
                    ("Inmediato","Inmediato"),
                    ("1-3 meses","1–3 meses"),
                    ("3-6 meses","3–6 meses"),
                    ("6-12 meses","6–12 meses"),
                    ("+1 año","Más de un año"),
                ])
            }
            HStack(spacing: 10) {
                field("Presupuesto (USD)") {
                    TextField("ej. 150,000", text: $budget)
                        .keyboardType(.numbersAndPunctuation)
                }
                menuField(label: "Contacto preferido", selection: $contactMethod, options: [
                    ("whatsapp","WhatsApp"),
                    ("llamada","Llamada"),
                    ("email","Email"),
                ])
            }
        }
    }

    // MARK: - Step 2

    private var step2: some View {
        VStack(alignment: .leading, spacing: 18) {
            sectionTitle("Datos personales")
            HStack(spacing: 10) {
                menuField(label: "Identificación", selection: $idType, options: [
                    ("","Seleccionar"), ("cedula","Cédula"), ("passport","Pasaporte")
                ])
                field("Número") {
                    TextField("000-0000000-0", text: $idNumber)
                }
            }
            HStack(spacing: 10) {
                field("Nacionalidad") {
                    TextField("Dominicano", text: $nationality)
                }
                dateField("Fecha de nacimiento", date: $dob, set: $dobSet)
            }
            field("Dirección actual") {
                TextField("Calle, sector, ciudad", text: $currentAddress)
            }

            sectionTitle("Información laboral")
            menuField(label: "Situación laboral", selection: $employmentStatus, options: [
                ("",""),
                ("employed","Empleado"),
                ("self_employed","Independiente"),
                ("retired","Jubilado"),
                ("student","Estudiante"),
                ("unemployed","Sin empleo"),
            ])
            HStack(spacing: 10) {
                field("Empresa") {
                    TextField("Nombre del empleador", text: $employer)
                }
                field("Puesto") {
                    TextField("ej. Gerente", text: $jobTitle)
                }
            }
            HStack(spacing: 10) {
                field("Ingreso mensual") {
                    TextField("ej. 85,000", text: $monthlyIncome)
                        .keyboardType(.numbersAndPunctuation)
                }
                menuField(label: "Moneda", selection: $incomeCurrency, options: [
                    ("DOP","DOP"), ("USD","USD")
                ])
                .frame(maxWidth: 120)
            }

            sectionTitle("Financiamiento")
            menuField(label: "Método", selection: $financing, options: [
                ("",""),
                ("efectivo","Efectivo"),
                ("banco","Financiamiento bancario"),
                ("desarrollador","Financiamiento del desarrollador"),
                ("vendedor","Financiamiento del vendedor"),
            ])
            Toggle(isOn: $preApproved) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pre-aprobado por el banco").font(.subheadline.weight(.semibold))
                    Text("Si ya tienes una carta de pre-aprobación")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .tint(Color.rdGreen)
            .padding(12)
            .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            sectionTitle("Co-aplicante (opcional)")
            Toggle(isOn: $hasCoapp) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Aplicar junto con otra persona").font(.subheadline.weight(.semibold))
                    Text("Cónyuge, pareja o co-propietario")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .tint(Color.rdBlue)
            .padding(12)
            .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            if hasCoapp {
                HStack(spacing: 10) {
                    field("Nombre") { TextField("Nombre y apellido", text: $coappName) }
                    field("Teléfono") {
                        TextField("809-555-0000", text: $coappPhone).keyboardType(.phonePad)
                    }
                }
                HStack(spacing: 10) {
                    field("Cédula / Pasaporte") { TextField("000-0000000-0", text: $coappId) }
                    field("Ingreso mensual") {
                        TextField("ej. 60,000", text: $coappIncome).keyboardType(.numbersAndPunctuation)
                    }
                }
            }

            field("Notas adicionales") {
                TextField("Algo que debamos saber…", text: $notes, axis: .vertical)
                    .lineLimit(2...4)
            }
        }
    }

    // MARK: - Step 3

    private var step3: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("Documentos de aplicación")
            Text("Para cada documento puedes **adjuntar ahora**, **marcar para subir después** o **omitir** si no aplica.")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(docSlots) { slot in
                docRow(slot)
            }

            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "lock.shield.fill")
                    .foregroundStyle(Color.rdBlue)
                Text("Tus documentos se comparten solo con la inmobiliaria afiliada al listing y con HogaresRD. Nunca los publicamos.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .background(Color.rdBlue.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private func docRow(_ slot: DocSlot) -> some View {
        let state = docStates[slot.type] ?? .skipped
        let borderColor: Color = {
            switch state {
            case .attached: return Color.rdGreen
            case .deferred: return Color.orange
            default:        return Color(.systemGray4)
            }
        }()
        let bgColor: Color = {
            switch state {
            case .attached: return Color.rdGreen.opacity(0.08)
            case .deferred: return Color.orange.opacity(0.08)
            default:        return Color(.systemBackground)
            }
        }()

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.fill")
                            .foregroundStyle(Color.rdBlue)
                            .font(.system(size: 14))
                        Text(slot.label)
                            .font(.subheadline.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if slot.required {
                        Text("REQUERIDO")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.red)
                    }
                }
                Spacer()
            }
            HStack(spacing: 6) {
                chipButton("Adjuntar",
                           active: { if case .attached = state { return true }; return false }(),
                           accent: .rdGreen) {
                    pickerTargetSlot = slot
                    showPhotoPicker = true
                }
                chipButton("Después",
                           active: state == .deferred,
                           accent: .orange) {
                    docStates[slot.type] = .deferred
                }
                chipButton("Omitir",
                           active: state == .skipped,
                           accent: Color(.systemGray)) {
                    docStates[slot.type] = .skipped
                }
            }
            if case .attached(_, let fname) = state {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.rdGreen)
                    Text(fname).font(.caption).lineLimit(1)
                    Spacer()
                    Button("Quitar") { docStates[slot.type] = .skipped }
                        .font(.caption.bold())
                        .foregroundStyle(.red)
                }
            } else if state == .deferred {
                HStack(spacing: 6) {
                    Image(systemName: "clock.fill").foregroundStyle(.orange)
                    Text("Lo subirás más tarde desde tu panel")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(12)
        .background(bgColor, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(borderColor, lineWidth: 1.5)
        )
        .photosPicker(isPresented: Binding(
            get: { showPhotoPicker && pickerTargetSlot?.type == slot.type },
            set: { if !$0 { showPhotoPicker = false } }
        ), selection: $photoPickerItem, matching: .images)
        .onChange(of: photoPickerItem) { _, newItem in
            guard let newItem, let slot = pickerTargetSlot else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self) {
                    let fname = "\(slot.type)_\(Int(Date().timeIntervalSince1970)).jpg"
                    await MainActor.run {
                        docStates[slot.type] = .attached(data: data, filename: fname)
                        photoPickerItem = nil
                        pickerTargetSlot = nil
                    }
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Button {
                    guard currentStep > 1 else { return }
                    currentStep -= 1
                    errorMsg = ""
                } label: {
                    Text("← Atrás")
                        .font(.subheadline.weight(.bold))
                        .padding(.vertical, 12)
                        .padding(.horizontal, 16)
                        .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 10))
                }
                .foregroundStyle(currentStep == 1 ? Color(.systemGray3) : .primary)
                .disabled(currentStep == 1)

                if !errorMsg.isEmpty {
                    Text(errorMsg)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                } else {
                    Spacer()
                }

                Button {
                    handleNext()
                } label: {
                    HStack(spacing: 6) {
                        if submitting {
                            ProgressView().tint(.white)
                        } else if currentStep == stepCount {
                            Text("Enviar Aplicación")
                        } else {
                            Text("Continuar →")
                        }
                    }
                    .font(.subheadline.weight(.bold))
                    .padding(.vertical, 12)
                    .padding(.horizontal, 18)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(.white)
                }
                .disabled(submitting)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
    }

    // MARK: - Validation & submit

    private func handleNext() {
        errorMsg = ""
        if currentStep == 1 && !validateStep1() { return }
        if currentStep == 2 && !validateStep2() { return }
        if currentStep == 3 && !validateStep3() { return }
        if currentStep < stepCount {
            currentStep += 1
            return
        }
        Task { await submit() }
    }

    private func trimmed(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isValidEmail(_ s: String) -> Bool {
        s.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"#, options: .regularExpression) != nil
    }

    private func isValidPhone(_ s: String) -> Bool {
        s.range(of: #"^\+?[\d\s\-().]{7,20}$"#, options: .regularExpression) != nil
    }

    private func parseMoney(_ s: String) -> Double? {
        let cleaned = s.replacingOccurrences(of: ",", with: "")
                       .replacingOccurrences(of: "$", with: "")
                       .trimmingCharacters(in: .whitespaces)
        return Double(cleaned)
    }

    private func validateStep1() -> Bool {
        if trimmed(name).count < 2           { errorMsg = "Ingresa tu nombre completo."; return false }
        if trimmed(phone).isEmpty             { errorMsg = "El teléfono es obligatorio."; return false }
        if !isValidPhone(phone)               { errorMsg = "Número de teléfono inválido."; return false }
        if trimmed(email).isEmpty             { errorMsg = "El correo electrónico es obligatorio."; return false }
        if !isValidEmail(email)               { errorMsg = "Correo electrónico inválido."; return false }
        if trimmed(intent).isEmpty            { errorMsg = "Selecciona tu intención."; return false }
        if trimmed(timeline).isEmpty          { errorMsg = "Selecciona un plazo estimado."; return false }
        if trimmed(contactMethod).isEmpty     { errorMsg = "Selecciona un método de contacto."; return false }
        guard let b = parseMoney(budget), b > 0 else {
            errorMsg = "Ingresa un presupuesto válido."; return false
        }
        return true
    }

    private func validateStep2() -> Bool {
        if trimmed(idType).isEmpty            { errorMsg = "Selecciona un tipo de identificación."; return false }
        if trimmed(idNumber).count < 5        { errorMsg = "Número de identificación inválido."; return false }
        if !dobSet {
            errorMsg = "La fecha de nacimiento es obligatoria."; return false
        }
        // Age 18+ check
        let years = Calendar.current.dateComponents([.year], from: dob, to: Date()).year ?? 0
        if years < 18 {
            errorMsg = "Debes ser mayor de edad para aplicar."; return false
        }
        if trimmed(currentAddress).count < 5 { errorMsg = "Ingresa tu dirección actual."; return false }
        if trimmed(employmentStatus).isEmpty { errorMsg = "Selecciona tu situación laboral."; return false }
        if ["employed", "self_employed"].contains(employmentStatus) {
            if trimmed(employer).isEmpty      { errorMsg = "Indica el nombre de tu empleador."; return false }
            if trimmed(jobTitle).isEmpty      { errorMsg = "Indica tu puesto."; return false }
        }
        guard let inc = parseMoney(monthlyIncome), inc > 0 else {
            errorMsg = "Ingresa un ingreso mensual válido."; return false
        }
        if trimmed(financing).isEmpty         { errorMsg = "Selecciona un método de financiamiento."; return false }

        if hasCoapp {
            if trimmed(coappName).count < 2   { errorMsg = "Nombre del co-aplicante es obligatorio."; return false }
            if !isValidPhone(coappPhone)      { errorMsg = "Teléfono del co-aplicante inválido."; return false }
            if trimmed(coappId).count < 5     { errorMsg = "Cédula/Pasaporte del co-aplicante es obligatorio."; return false }
            guard let coInc = parseMoney(coappIncome), coInc > 0 else {
                errorMsg = "Ingreso del co-aplicante es obligatorio."; return false
            }
        }
        return true
    }

    private func validateStep3() -> Bool {
        // cedula and income_proof must be attached OR deferred (not skipped)
        let required: [String] = ["cedula", "income_proof"]
        let labels = ["cedula": "Cédula/Pasaporte", "income_proof": "Comprobante de Ingresos"]
        let missing = required.filter { type in
            let st = docStates[type] ?? .skipped
            return st == .skipped
        }
        if !missing.isEmpty {
            let names = missing.compactMap { labels[$0] }.joined(separator: ", ")
            errorMsg = "Debes adjuntar o marcar para subir después: \(names)."
            return false
        }
        return true
    }

    private func submit() async {
        submitting = true
        errorMsg   = ""
        defer { submitting = false }

        // Collect deferred docs
        let deferred = docSlots
            .filter { docStates[$0.type] == .deferred }
            .map { [
                "type":     $0.type,
                "label":    $0.label,
                "required": $0.required,
            ] as [String: Any] }

        // Tell the server which required docs will arrive as initial-uploads
        // right after create — otherwise the create would reject with a
        // "missing required docs" error before we get a chance to upload.
        let attachedTypes: [String] = docSlots.compactMap { slot in
            if case .attached = docStates[slot.type] { return slot.type }
            return nil
        }

        // Build payload
        var payload: [String: Any] = [
            "name":  name, "phone": phone, "email": email,
            "intent": intent, "timeline": timeline,
            "financing": financing, "pre_approved": preApproved,
            "contact_method": contactMethod,
            "budget": budget, "notes": notes,
            "id_type":  idType, "id_number": idNumber,
            "nationality": nationality,
            "current_address": currentAddress,
            "employment_status": employmentStatus,
            "employer_name": employer, "job_title": jobTitle,
            "monthly_income": monthlyIncome,
            "income_currency": incomeCurrency,
            "deferred_documents": deferred,
            "attached_document_types": attachedTypes,
        ]
        if dobSet {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
            payload["date_of_birth"] = f.string(from: dob)
        }
        if hasCoapp {
            payload["co_applicant"] = [
                "name":  coappName, "phone": coappPhone,
                "id_number": coappId, "monthly_income": coappIncome,
            ]
        }

        do {
            let appId = try await api.submitApplication(listing: listing, payload: payload)

            // Upload attached files in sequence
            let attached = docSlots.compactMap { slot -> (DocSlot, Data, String)? in
                if case .attached(let data, let fname) = docStates[slot.type] {
                    return (slot, data, fname)
                }
                return nil
            }
            for (slot, data, fname) in attached {
                do {
                    try await api.uploadInitialDocument(
                        applicationId: appId,
                        type: slot.type,
                        label: slot.label,
                        data: data,
                        filename: fname
                    )
                } catch {
                    // Non-fatal; keep going
                }
            }

            hadDeferredOnSuccess = !deferred.isEmpty
            submitted = true
        } catch {
            errorMsg = (error as? APIError).map { e in
                if case .server(let s) = e { return s }
                return "Error al enviar."
            } ?? "Error al enviar."
        }
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 72))
                .foregroundStyle(Color.rdGreen)
            Text("¡Aplicación enviada!")
                .font(.title2.weight(.heavy))
            VStack(spacing: 6) {
                Text("El broker se pondrá en contacto contigo pronto.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if hadDeferredOnSuccess {
                    Text("Recuerda subir los documentos pendientes desde tu panel para avanzar más rápido.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 32)
            Spacer()
            Button("Cerrar") { dismiss() }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.rdBlue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
        }
        .navigationTitle("Aplicación")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Helpers

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.top, 4)
    }

    @ViewBuilder
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color(.tertiaryLabel))
                .textCase(.uppercase)
                .kerning(0.4)
            content()
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private func menuField(label: String, selection: Binding<String>, options: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color(.tertiaryLabel))
                .textCase(.uppercase)
                .kerning(0.4)
            Menu {
                ForEach(options, id: \.0) { opt in
                    Button(opt.1) { selection.wrappedValue = opt.0 }
                }
            } label: {
                HStack {
                    Text(options.first(where: { $0.0 == selection.wrappedValue })?.1 ?? "Seleccionar")
                        .foregroundStyle(selection.wrappedValue.isEmpty ? .secondary : .primary)
                    Spacer()
                    Image(systemName: "chevron.down").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    @ViewBuilder
    private func dateField(_ label: String, date: Binding<Date>, set: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color(.tertiaryLabel))
                .textCase(.uppercase)
                .kerning(0.4)
            DatePicker("", selection: date, in: ...Date(), displayedComponents: .date)
                .datePickerStyle(.compact)
                .labelsHidden()
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 10))
                .onChange(of: date.wrappedValue) { _, _ in set.wrappedValue = true }
        }
    }

    @ViewBuilder
    private func chipButton(_ title: String, active: Bool, accent: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.bold))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? accent : Color(.systemBackground), in: Capsule())
                .foregroundStyle(active ? .white : .secondary)
                .overlay(
                    Capsule().stroke(active ? accent : Color(.systemGray4), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
