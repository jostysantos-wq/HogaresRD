import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// MARK: - My Documents (Buyer document submission)
//
// Wave 8-C refactor: Things-style checklist rows (leading checkmark
// circle, title + caption, no in-section dividers), groups inside
// `FormCard`s, rejected docs callout in `Color.rdRed.opacity(0.12)`,
// empty state via `EmptyStateView.calm`.

struct MyDocumentsView: View {
    @EnvironmentObject var api: APIService
    @State private var applications: [[String: Any]] = []
    @State private var loading = true
    @State private var uploadingFor: String? = nil // applicationId being uploaded to
    @State private var showPicker = false
    @State private var showFileImporter = false
    @State private var showCamera = false
    @State private var pickerContext: PickerContext?
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var successMessage: String?
    @State private var errorMessage: String?
    // #40: 0…1 progress driven by URLSessionTaskDelegate while a multipart
    // upload is in flight. -1 means "uploading but progress unknown".
    @State private var uploadProgress: Double = 0
    // B6: per-application amount + currency for payment-receipt uploads.
    // Keyed by application id so each card preserves its draft input.
    @State private var paymentAmounts:    [String: String] = [:]
    @State private var paymentCurrencies: [String: String] = [:]

    struct PickerContext {
        let applicationId: String
        let requestId: String?
        let type: String
        let label: String
        // B6: receipt-only — amount as user-entered string + currency code.
        var amount:   String? = nil
        var currency: String? = nil
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.s16) {
                if loading {
                    VStack(spacing: Spacing.s16) {
                        Spacer().frame(height: 40)
                        ProgressView()
                        Text("Cargando documentos...")
                            .font(.subheadline)
                            .foregroundStyle(Color.rdInkSoft)
                    }
                } else if applications.isEmpty {
                    EmptyStateView.calm(
                        systemImage: "doc.text",
                        title: "Sin documentos pendientes",
                        description: "Cuando apliques a una propiedad y el agente solicite documentos, aparecerán aquí."
                    )
                    .padding(.top, Spacing.s32)
                } else {
                    ForEach(Array(applications.enumerated()), id: \.offset) { _, app in
                        applicationCard(app)
                    }
                }
            }
            .padding(.horizontal, Spacing.s16)
            .padding(.vertical, Spacing.s16)
        }
        .background(Color.rdBg)
        .navigationTitle("Mis Documentos")
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
        .refreshable { await load() }
        .overlay {
            if let msg = successMessage {
                VStack {
                    Spacer()
                    HStack(spacing: Spacing.s8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.white)
                        Text(msg)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 20).padding(.vertical, Spacing.s12)
                    .background(Color.rdGreen, in: Capsule())
                    .shadow(radius: 8)
                    .padding(.bottom, Spacing.s32)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task {
                    try? await Task.sleep(for: .seconds(3))
                    withAnimation { successMessage = nil }
                }
            }
            // #27 / #40: error toast surfacing the server's >=400 message
            // so the buyer knows what went wrong instead of silently
            // staring at an unchanged form.
            if let err = errorMessage {
                VStack {
                    Spacer()
                    HStack(alignment: .top, spacing: Spacing.s8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.white)
                        Text(err)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.leading)
                    }
                    .padding(.horizontal, 20).padding(.vertical, Spacing.s12)
                    .background(Color.rdRed, in: RoundedRectangle(cornerRadius: Radius.medium))
                    .shadow(radius: 8)
                    .padding(.horizontal, Spacing.s24)
                    .padding(.bottom, Spacing.s32)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task {
                    try? await Task.sleep(for: .seconds(5))
                    withAnimation { errorMessage = nil }
                }
            }
        }
        .photosPicker(isPresented: $showPicker, selection: $selectedPhotos, maxSelectionCount: 5, matching: .any(of: [.images]))
        .onChange(of: selectedPhotos) {
            guard let ctx = pickerContext, let item = selectedPhotos.first else { return }
            Task { await handlePickedPhoto(item: item, context: ctx) }
            selectedPhotos = []
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf, .jpeg, .png, .heic, .data], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first, let ctx = pickerContext else { return }
                guard url.startAccessingSecurityScopedResource() else { return }
                defer { url.stopAccessingSecurityScopedResource() }
                guard let data = try? Data(contentsOf: url) else { return }
                let filename = url.lastPathComponent
                Task { await handleFileData(data: data, filename: filename, context: ctx) }
            case .failure:
                break
            }
        }
        .sheet(isPresented: $showCamera) {
            if let ctx = pickerContext {
                CameraPickerView { image in
                    showCamera = false
                    guard let data = image.jpegData(compressionQuality: 0.85) else { return }
                    let filename = "foto_\(Int(Date().timeIntervalSince1970)).jpg"
                    Task { await handleFileData(data: data, filename: filename, context: ctx) }
                }
                .ignoresSafeArea()
            }
        }
    }

    // MARK: - Unified Upload Menu

    private func uploadMenu<Label: View>(ctx: PickerContext, @ViewBuilder label: () -> Label) -> some View {
        Menu {
            Button {
                pickerContext = ctx
                showCamera = true
            } label: {
                SwiftUI.Label("Tomar foto", systemImage: "camera.fill")
            }
            Button {
                pickerContext = ctx
                showPicker = true
            } label: {
                SwiftUI.Label("Elegir de Fotos", systemImage: "photo.on.rectangle")
            }
            Button {
                pickerContext = ctx
                showFileImporter = true
            } label: {
                SwiftUI.Label("Elegir de Archivos", systemImage: "folder")
            }
        } label: {
            label()
        }
        .disabled(uploadingFor != nil)
    }

    // MARK: - Load

    private func load() async {
        if applications.isEmpty { loading = true }
        do {
            applications = try await api.getMyApplicationsFull()
        } catch is CancellationError {
        } catch {
            applications = []
        }
        loading = false
    }

    // MARK: - Application Card

    private func applicationCard(_ app: [String: Any]) -> some View {
        let appId = app["id"] as? String ?? ""
        let title = app["listing_title"] as? String ?? app["listingTitle"] as? String ?? "Propiedad"
        let status = app["status"] as? String ?? ""
        let docsRequested = app["documents_requested"] as? [[String: Any]] ?? []
        let docsUploaded = app["documents_uploaded"] as? [[String: Any]] ?? []
        let payment = app["payment"] as? [String: Any]
        let paymentPlan = app["payment_plan"] as? [String: Any]

        return VStack(alignment: .leading, spacing: Spacing.s16) {
            // Header card with status
            FormCard {
                LabeledRow(title) {
                    statusBadge(status)
                }
                LabeledRow("Estado") {
                    Text(statusLabel(status))
                }
            }

            // Requested Documents
            if !docsRequested.isEmpty {
                FormCard("Documentos solicitados") {
                    ForEach(Array(docsRequested.enumerated()), id: \.offset) { _, doc in
                        documentRow(doc: doc, appId: appId, uploadedDocs: docsUploaded)
                    }
                }
            }

            // Payment receipt section
            if let pmt = payment, status == "pendiente_pago" || status == "pago_enviado" {
                FormCard("Comprobante de pago") {
                    let verStatus = pmt["verification_status"] as? String ?? "none"
                    if verStatus == "none" || verStatus == "rejected" {
                        paymentReceiptForm(appId: appId, listingCurrency: app["listing_currency"] as? String)
                        if verStatus == "rejected" {
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: "exclamationmark.circle")
                                    .foregroundStyle(Color.rdRed)
                                Text("Rechazado — sube un nuevo comprobante")
                                    .font(.caption)
                                    .foregroundStyle(Color.rdRed)
                            }
                            .padding(Spacing.s8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.rdRed.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: Radius.small))
                        }
                    } else {
                        Label(verStatus == "approved" ? "Pago aprobado" : "En revisión",
                              systemImage: verStatus == "approved" ? "checkmark.circle.fill" : "clock.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(verStatus == "approved" ? Color.rdGreen : Color.rdOrange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, Spacing.s4)
                    }
                }
            }

            // Payment plan installments
            if let plan = paymentPlan, let installments = plan["installments"] as? [[String: Any]] {
                let pending = installments.filter { ($0["status"] as? String) == "pending" || ($0["status"] as? String) == "rejected" }
                if !pending.isEmpty {
                    FormCard("Cuotas pendientes") {
                        ForEach(Array(pending.enumerated()), id: \.offset) { _, inst in
                            installmentRow(inst: inst, appId: appId)
                        }
                    }
                }
            }

            // Upload progress — #40: surface granular percent driven by
            // URLSessionTaskDelegate. Falls back to indeterminate spinner
            // when the OS hasn't reported any progress yet.
            if uploadingFor == appId {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        if uploadProgress > 0 && uploadProgress < 1 {
                            Text("Subiendo \(Int(uploadProgress * 100))%")
                                .font(.caption)
                                .foregroundStyle(Color.rdInkSoft)
                        } else {
                            ProgressView().scaleEffect(0.8)
                            Text("Subiendo...")
                                .font(.caption)
                                .foregroundStyle(Color.rdInkSoft)
                        }
                    }
                    if uploadProgress > 0 {
                        ProgressView(value: min(max(uploadProgress, 0), 1))
                            .tint(Color.rdAccent)
                    }
                }
                .padding(.horizontal, Spacing.s4)
            }
        }
    }

    // MARK: - Payment Receipt Form (B6)

    /// Inline amount + currency picker shown above the receipt upload button.
    /// `listingCurrency` (USD/DOP) seeds the default when known.
    @ViewBuilder
    private func paymentReceiptForm(appId: String, listingCurrency: String?) -> some View {
        // Seed defaults once per appId
        let defaultCurrency: String = {
            let c = listingCurrency?.uppercased() ?? ""
            return (c == "USD" || c == "DOP") ? c : "DOP"
        }()
        let amountString  = paymentAmounts[appId] ?? ""
        let currencyValue = paymentCurrencies[appId] ?? defaultCurrency
        let parsed        = Double(amountString.replacingOccurrences(of: ",", with: "."))
        let isValid       = (parsed ?? 0) > 0

        VStack(alignment: .leading, spacing: Spacing.s8) {
            HStack(spacing: Spacing.s8) {
                // Amount field
                HStack(spacing: 4) {
                    Image(systemName: "creditcard.fill")
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                    TextField("Monto", text: Binding(
                        get: { paymentAmounts[appId] ?? "" },
                        set: { paymentAmounts[appId] = $0 }
                    ))
                    .keyboardType(.decimalPad)
                    .font(.subheadline)
                }
                .padding(.horizontal, Spacing.s8).padding(.vertical, Spacing.s8)
                .background(Color.rdSurfaceMuted)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small))
                .frame(maxWidth: .infinity)

                // Currency picker
                Picker("Moneda", selection: Binding(
                    get: { paymentCurrencies[appId] ?? defaultCurrency },
                    set: { paymentCurrencies[appId] = $0 }
                )) {
                    Text("DOP").tag("DOP")
                    Text("USD").tag("USD")
                }
                .pickerStyle(.segmented)
                .frame(width: 130)
            }

            if !amountString.isEmpty && !isValid {
                Text("Ingresa un monto mayor a 0.")
                    .font(.caption)
                    .foregroundStyle(Color.rdRed)
            }

            uploadMenu(ctx: PickerContext(
                applicationId: appId, requestId: nil,
                type: "payment_receipt", label: "Comprobante de pago",
                amount: amountString, currency: currencyValue
            )) {
                Label("Subir comprobante", systemImage: "arrow.up.doc.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background((isValid ? Color.rdAccent : Color.rdMuted), in: RoundedRectangle(cornerRadius: Radius.medium))
            }
            .disabled(uploadingFor == appId || !isValid)
            .accessibilityLabel("Subir comprobante de pago")
        }
    }

    // MARK: - Document Row (Things-style checklist)

    private func documentRow(doc: [String: Any], appId: String, uploadedDocs: [[String: Any]]) -> some View {
        let reqId = doc["id"] as? String ?? ""
        let label = doc["label"] as? String ?? doc["type"] as? String ?? "Documento"
        let _    = doc["type"] as? String ?? "other"
        let isRequired = doc["required"] as? Bool ?? true
        let docStatus = doc["status"] as? String ?? "pending"

        // Check if a matching uploaded document exists
        let uploaded = uploadedDocs.first { ($0["request_id"] as? String) == reqId }
        let reviewStatus = uploaded?["review_status"] as? String
        // B5: surface the broker's rejection note when the doc was rejected.
        // The server stores it as `review_note` on the uploaded record.
        let reviewNote = (uploaded?["review_note"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isUploaded = (reviewStatus == "approved" || reviewStatus == "pending" || docStatus == "uploaded")

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Spacing.s12) {
                Image(systemName: isUploaded ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(reviewStatus == "rejected" ? Color.rdRed : (isUploaded ? Color.rdGreen : Color.rdMuted))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(label)
                            .font(.body)
                            .foregroundStyle(Color.rdInk)
                        if isRequired {
                            Text("*")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.rdRed)
                        }
                    }
                    if let rs = reviewStatus {
                        Text(rs == "approved" ? "Aprobado" : rs == "rejected" ? "Rechazado" : rs == "pending" ? "En revisión" : "Pendiente")
                            .font(.caption)
                            .foregroundStyle(rs == "approved" ? Color.rdGreen : rs == "rejected" ? Color.rdRed : Color.rdInkSoft)
                    } else if docStatus == "uploaded" {
                        Text("Subido — en revisión")
                            .font(.caption)
                            .foregroundStyle(Color.rdInkSoft)
                    } else {
                        Text("Pendiente de subir")
                            .font(.caption)
                            .foregroundStyle(Color.rdOrange)
                    }
                }

                Spacer()

                if reviewStatus == nil || reviewStatus == "rejected" {
                    uploadMenu(ctx: PickerContext(applicationId: appId, requestId: reqId, type: doc["type"] as? String ?? "other", label: label)) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundStyle(Color.rdAccent)
                    }
                    .accessibilityLabel("Subir \(label)")
                } else if reviewStatus == "approved" {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Color.rdGreen)
                        .accessibilityLabel("\(label) aprobado")
                } else {
                    Image(systemName: "clock.fill")
                        .font(.title3)
                        .foregroundStyle(Color.rdOrange)
                        .accessibilityLabel("\(label) en revisión")
                }
            }
            .padding(.vertical, Spacing.s4)
            .frame(minHeight: 56)
            .contentShape(Rectangle())

            // B5: red callout with the broker's rejection note
            if reviewStatus == "rejected", let note = reviewNote, !note.isEmpty {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.bubble.fill")
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                    Text("Nota del agente: \(note)")
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                }
                .padding(Spacing.s8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.rdRed.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Radius.small))
            }
        }
    }

    // MARK: - Installment Row

    private func installmentRow(inst: [String: Any], appId: String) -> some View {
        let instId = inst["id"] as? String ?? ""
        let label = inst["label"] as? String ?? "Cuota"
        let amount = inst["amount"] as? Double ?? 0
        let status = inst["status"] as? String ?? "pending"

        return HStack(spacing: Spacing.s12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.body)
                    .foregroundStyle(Color.rdInk)
                Text("$\(Int(amount).formatted())")
                    .font(.caption)
                    .foregroundStyle(Color.rdAccent)
            }

            Spacer()

            if status == "pending" || status == "rejected" {
                uploadMenu(ctx: PickerContext(applicationId: appId, requestId: instId, type: "installment_proof", label: label)) {
                    Text("Subir prueba")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, Spacing.s12).padding(.vertical, 7)
                        .background(Color.rdAccent, in: Capsule())
                }
                .accessibilityLabel("Subir prueba de \(label)")
            }
        }
        .padding(.vertical, Spacing.s4)
        .frame(minHeight: 56)
    }

    // MARK: - Photo Handling

    private func handlePickedPhoto(item: PhotosPickerItem, context: PickerContext) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let filename = "document_\(Date().timeIntervalSince1970).jpg"
        await runUpload(context: context, data: data, filename: filename, mimeType: "image/jpeg")
    }

    // MARK: - File Handling (from Files app)

    private func handleFileData(data: Data, filename: String, context: PickerContext) async {
        // Determine MIME type from extension
        let ext = (filename as NSString).pathExtension.lowercased()
        let mimeType: String
        switch ext {
        case "pdf": mimeType = "application/pdf"
        case "png": mimeType = "image/png"
        case "jpg", "jpeg": mimeType = "image/jpeg"
        case "heic": mimeType = "image/heic"
        default: mimeType = "application/octet-stream"
        }
        await runUpload(context: context, data: data, filename: filename, mimeType: mimeType)
    }

    // MARK: - Unified upload runner (#40, #27)
    //
    // Handles all three upload variants (general document, payment
    // receipt, installment proof) with progress driven by
    // `URLSessionTaskDelegate.didSendBodyData`, plus surfaces the server's
    // >=400 error message instead of silently swallowing it.
    private func runUpload(context: PickerContext, data: Data, filename: String, mimeType: String) async {
        uploadingFor = context.applicationId
        uploadProgress = 0
        defer {
            Task { @MainActor in
                uploadingFor = nil
                uploadProgress = 0
            }
        }
        do {
            if context.type == "payment_receipt" {
                let amountStr = (context.amount ?? "")
                    .trimmingCharacters(in: .whitespaces)
                    .replacingOccurrences(of: ",", with: ".")
                guard let amt = Double(amountStr), amt > 0 else {
                    withAnimation { errorMessage = "Ingresa un monto mayor a 0 antes de subir." }
                    return
                }
                try await uploadPaymentReceiptWithCurrency(
                    applicationId: context.applicationId,
                    amount: String(amt),
                    currency: context.currency ?? "DOP",
                    fileData: data,
                    filename: filename,
                    mimeType: mimeType
                )
            } else if context.type == "installment_proof", let instId = context.requestId {
                try await uploadInstallmentProof(
                    applicationId: context.applicationId,
                    installmentId: instId,
                    fileData: data,
                    filename: filename,
                    mimeType: mimeType
                )
            } else {
                try await uploadGeneralDocument(
                    applicationId: context.applicationId,
                    requestId: context.requestId,
                    type: context.type,
                    fileData: data,
                    filename: filename,
                    mimeType: mimeType
                )
            }
            withAnimation { successMessage = "\(context.label) subido correctamente" }
            await load()
        } catch {
            // #27: surface the actual server error (already a string) so
            // the buyer knows what went wrong. Falls back to a generic
            // localized description for transport failures.
            let msg: String = {
                if case .server(let s)? = error as? APIError { return s }
                return error.localizedDescription
            }()
            withAnimation { errorMessage = msg }
        }
    }

    // MARK: - Helpers

    /// B6 / #40: Upload a payment receipt with explicit amount + currency.
    /// We POST directly (instead of going through APIService.uploadPaymentReceipt)
    /// because that helper does not accept a currency field. Progress is
    /// driven by `UploadProgressDelegate`; the body is built into a temp
    /// file so URLSession can stream it and the OS reports byte-by-byte
    /// progress.
    private func uploadPaymentReceiptWithCurrency(
        applicationId: String,
        amount: String,
        currency: String,
        fileData: Data,
        filename: String,
        mimeType: String
    ) async throws {
        guard let t = api.token else { throw APIError.server("No autenticado") }
        guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(applicationId)/payment/upload") else {
            throw APIError.server("URL inválida")
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let safeFilename = sanitizeMultipartFilename(filename)
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8) ?? Data())
        body.append(("Content-Disposition: form-data; name=\"receipt\"; filename=\"\(safeFilename)\"\r\nContent-Type: \(mimeType)\r\n\r\n").data(using: .utf8) ?? Data())
        body.append(fileData)
        body.append("\r\n--\(boundary)\r\n".data(using: .utf8) ?? Data())
        body.append(("Content-Disposition: form-data; name=\"amount\"\r\n\r\n\(amount)\r\n").data(using: .utf8) ?? Data())
        body.append("--\(boundary)\r\n".data(using: .utf8) ?? Data())
        body.append(("Content-Disposition: form-data; name=\"currency\"\r\n\r\n\(currency)\r\n").data(using: .utf8) ?? Data())
        body.append("--\(boundary)--\r\n".data(using: .utf8) ?? Data())
        try await runMultipartUpload(request: req, body: body, fallbackError: "Error subiendo comprobante")
    }

    /// #40 / #27: replacement for the inline installment-proof upload
    /// that went through `URLSession.shared.data(for:)` without checking
    /// HTTP status codes.
    private func uploadInstallmentProof(
        applicationId: String,
        installmentId: String,
        fileData: Data,
        filename: String,
        mimeType: String
    ) async throws {
        guard let t = api.token else { throw APIError.server("No autenticado") }
        guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(applicationId)/payment-plan/\(installmentId)/upload") else {
            throw APIError.server("URL inválida")
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let safeFilename = sanitizeMultipartFilename(filename)
        var body = Data()
        body.append(("--\(boundary)\r\n").data(using: .utf8) ?? Data())
        body.append(("Content-Disposition: form-data; name=\"proof\"; filename=\"\(safeFilename)\"\r\nContent-Type: \(mimeType)\r\n\r\n").data(using: .utf8) ?? Data())
        body.append(fileData)
        body.append(("\r\n--\(boundary)--\r\n").data(using: .utf8) ?? Data())
        try await runMultipartUpload(request: req, body: body, fallbackError: "Error subiendo prueba de pago")
    }

    /// #40 / #27: same shape as APIService.uploadDocument but goes through
    /// URLSessionUploadTask so we can drive a progress bar.
    private func uploadGeneralDocument(
        applicationId: String,
        requestId: String?,
        type: String,
        fileData: Data,
        filename: String,
        mimeType: String
    ) async throws {
        guard let t = api.token else { throw APIError.server("No autenticado") }
        guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(applicationId)/documents/upload") else {
            throw APIError.server("URL inválida")
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let safeFilename = sanitizeMultipartFilename(filename)
        // Server uses `multer.array('files', 10)` so the field name is `files`.
        var body = Data()
        body.append(("--\(boundary)\r\n").data(using: .utf8) ?? Data())
        body.append(("Content-Disposition: form-data; name=\"files\"; filename=\"\(safeFilename)\"\r\nContent-Type: \(mimeType)\r\n\r\n").data(using: .utf8) ?? Data())
        body.append(fileData)
        body.append(("\r\n--\(boundary)\r\n").data(using: .utf8) ?? Data())
        body.append(("Content-Disposition: form-data; name=\"type\"\r\n\r\n\(type)\r\n").data(using: .utf8) ?? Data())
        if let rId = requestId, !rId.isEmpty {
            body.append(("--\(boundary)\r\n").data(using: .utf8) ?? Data())
            body.append(("Content-Disposition: form-data; name=\"request_id\"\r\n\r\n\(rId)\r\n").data(using: .utf8) ?? Data())
        }
        body.append(("--\(boundary)--\r\n").data(using: .utf8) ?? Data())
        try await runMultipartUpload(request: req, body: body, fallbackError: "Error subiendo documento")
    }

    /// #40: shared multipart upload runner. Drives `uploadProgress` via
    /// the delegate's `didSendBodyData` callback and surfaces server-side
    /// error messages on >=400 instead of swallowing them.
    private func runMultipartUpload(request: URLRequest, body: Data, fallbackError: String) async throws {
        let delegate = UploadProgressDelegate { progress in
            Task { @MainActor in
                self.uploadProgress = progress
            }
        }
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        let (data, response) = try await session.upload(for: request, from: body)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            // Surface the server's `error` field if present.
            let serverMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.server(serverMsg ?? "\(fallbackError) (\(http.statusCode))")
        }
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

    private func docIcon(_ type: String) -> String {
        switch type {
        case "cedula", "passport": return "person.text.rectangle"
        case "income_proof", "employment_letter": return "briefcase.fill"
        case "bank_statement": return "building.columns.fill"
        case "tax_return": return "doc.text.fill"
        case "pre_approval": return "checkmark.seal.fill"
        case "proof_of_funds": return "dollarsign.circle.fill"
        default: return "doc.fill"
        }
    }

    private func statusLabel(_ status: String) -> String {
        let labels: [String: String] = [
            "aplicado": "Aplicado",
            "en_revision": "En revisión",
            "documentos_requeridos": "Documentos requeridos",
            "documentos_enviados": "Documentos enviados",
            "documentos_insuficientes": "Documentos insuficientes",
            "pendiente_pago": "Pendiente de pago",
            "pago_enviado": "Pago enviado",
            "pago_aprobado": "Pago aprobado",
            "completado": "Completado",
            "rechazado": "Rechazado",
        ]
        return labels[status] ?? status.capitalized
    }

    private func statusBadge(_ status: String) -> some View {
        let color: Color = {
            switch status {
            case "completado", "pago_aprobado": return .rdGreen
            case "rechazado", "documentos_insuficientes": return .rdRed
            case "documentos_requeridos", "pendiente_pago": return .rdOrange
            default: return .rdBlue
            }
        }()
        return DSStatusBadge(label: statusLabel(status), tint: color)
    }
}

// MARK: - Upload Progress Delegate (#40)
//
// Receives `didSendBodyData` callbacks for the duration of an upload and
// forwards a 0…1 progress fraction to the closure. We use a per-upload
// URLSession so the delegate's lifecycle is bounded — `runMultipartUpload`
// invalidates the session in its defer block.

final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    private let onProgress: (Double) -> Void

    init(_ onProgress: @escaping (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        let progress = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        onProgress(progress)
    }
}

// MARK: - Camera Picker (UIImagePickerController with .camera source)

struct CameraPickerView: UIViewControllerRepresentable {
    var onCapture: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage) -> Void
        init(onCapture: @escaping (UIImage) -> Void) { self.onCapture = onCapture }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            picker.dismiss(animated: true)
            if let image = info[.originalImage] as? UIImage { onCapture(image) }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
        }
    }
}
