import SwiftUI
import PhotosUI

// MARK: - My Documents (Buyer document submission)

struct MyDocumentsView: View {
    @EnvironmentObject var api: APIService
    @State private var applications: [[String: Any]] = []
    @State private var loading = true
    @State private var uploadingFor: String? = nil // applicationId being uploaded to
    @State private var showPicker = false
    @State private var pickerContext: PickerContext?
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var successMessage: String?

    struct PickerContext {
        let applicationId: String
        let requestId: String?
        let type: String
        let label: String
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if loading {
                    VStack(spacing: 16) {
                        Spacer().frame(height: 40)
                        ProgressView()
                        Text("Cargando documentos...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if applications.isEmpty {
                    emptyState
                } else {
                    ForEach(Array(applications.enumerated()), id: \.offset) { _, app in
                        applicationCard(app)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Mis Documentos")
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
        .refreshable { await load() }
        .overlay {
            if let msg = successMessage {
                VStack {
                    Spacer()
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.white)
                        Text(msg)
                            .font(.subheadline.bold())
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(Color.rdGreen, in: Capsule())
                    .shadow(radius: 8)
                    .padding(.bottom, 32)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task {
                    try? await Task.sleep(for: .seconds(3))
                    withAnimation { successMessage = nil }
                }
            }
        }
        .photosPicker(isPresented: $showPicker, selection: $selectedPhotos, maxSelectionCount: 5, matching: .any(of: [.images]))
        .onChange(of: selectedPhotos) {
            guard let ctx = pickerContext, let item = selectedPhotos.first else { return }
            Task { await handlePickedPhoto(item: item, context: ctx) }
            selectedPhotos = []
        }
    }

    // MARK: - Load

    private func load() async {
        loading = true
        do {
            applications = try await api.getMyApplicationsFull()
        } catch {
            applications = []
        }
        loading = false
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer().frame(height: 40)
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("Sin documentos pendientes")
                .font(.headline)
            Text("Cuando apliques a una propiedad y el agente solicite documentos, aparecerán aquí.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
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

        return VStack(alignment: .leading, spacing: 14) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.bold())
                        .lineLimit(2)
                    Text("Estado: \(statusLabel(status))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                statusBadge(status)
            }

            // Requested Documents
            if !docsRequested.isEmpty {
                Divider()
                Text("Documentos Solicitados")
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)

                ForEach(Array(docsRequested.enumerated()), id: \.offset) { _, doc in
                    documentRow(doc: doc, appId: appId, uploadedDocs: docsUploaded)
                }
            }

            // Payment receipt section
            if let pmt = payment, status == "pendiente_pago" || status == "pago_enviado" {
                Divider()
                Text("Comprobante de Pago")
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)

                let verStatus = pmt["verification_status"] as? String ?? "none"
                if verStatus == "none" || verStatus == "rejected" {
                    Button {
                        pickerContext = PickerContext(applicationId: appId, requestId: nil, type: "payment_receipt", label: "Comprobante de pago")
                        showPicker = true
                    } label: {
                        Label("Subir comprobante", systemImage: "arrow.up.doc.fill")
                            .font(.subheadline.bold())
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .disabled(uploadingFor == appId)
                    if verStatus == "rejected" {
                        Label("Rechazado — sube un nuevo comprobante", systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                    }
                } else {
                    HStack {
                        Label(verStatus == "approved" ? "Pago aprobado" : "En revision",
                              systemImage: verStatus == "approved" ? "checkmark.circle.fill" : "clock.fill")
                            .font(.caption.bold())
                            .foregroundStyle(verStatus == "approved" ? Color.rdGreen : Color.orange)
                    }
                }
            }

            // Payment plan installments
            if let plan = paymentPlan, let installments = plan["installments"] as? [[String: Any]] {
                let pending = installments.filter { ($0["status"] as? String) == "pending" || ($0["status"] as? String) == "rejected" }
                if !pending.isEmpty {
                    Divider()
                    Text("Cuotas Pendientes")
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdBlue)

                    ForEach(Array(pending.enumerated()), id: \.offset) { _, inst in
                        installmentRow(inst: inst, appId: appId)
                    }
                }
            }

            // Upload progress
            if uploadingFor == appId {
                HStack {
                    ProgressView().scaleEffect(0.8)
                    Text("Subiendo...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Document Row

    private func documentRow(doc: [String: Any], appId: String, uploadedDocs: [[String: Any]]) -> some View {
        let reqId = doc["id"] as? String ?? ""
        let label = doc["label"] as? String ?? doc["type"] as? String ?? "Documento"
        let type = doc["type"] as? String ?? "other"
        let isRequired = doc["required"] as? Bool ?? true
        let docStatus = doc["status"] as? String ?? "pending"

        // Check if a matching uploaded document exists
        let uploaded = uploadedDocs.first { ($0["request_id"] as? String) == reqId }
        let reviewStatus = uploaded?["review_status"] as? String

        return HStack(spacing: 12) {
            Image(systemName: docIcon(type))
                .font(.system(size: 20))
                .foregroundStyle(reviewStatus == "approved" ? Color.rdGreen : reviewStatus == "rejected" ? Color.rdRed : Color.rdBlue)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(label)
                        .font(.subheadline.bold())
                    if isRequired {
                        Text("*")
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdRed)
                    }
                }
                if let rs = reviewStatus {
                    Text(rs == "approved" ? "Aprobado" : rs == "rejected" ? "Rechazado" : rs == "pending" ? "En revision" : "Pendiente")
                        .font(.caption)
                        .foregroundStyle(rs == "approved" ? Color.rdGreen : rs == "rejected" ? Color.rdRed : .secondary)
                } else if docStatus == "uploaded" {
                    Text("Subido — en revision")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Pendiente de subir")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            Spacer()

            if reviewStatus == nil || reviewStatus == "rejected" {
                Button {
                    pickerContext = PickerContext(applicationId: appId, requestId: reqId, type: type, label: label)
                    showPicker = true
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(Color.rdBlue)
                }
                .buttonStyle(.plain)
                .disabled(uploadingFor != nil)
            } else if reviewStatus == "approved" {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(Color.rdGreen)
            } else {
                Image(systemName: "clock.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.orange)
            }
        }
        .padding(10)
        .background(Color(.tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Installment Row

    private func installmentRow(inst: [String: Any], appId: String) -> some View {
        let instId = inst["id"] as? String ?? ""
        let label = inst["label"] as? String ?? "Cuota"
        let amount = inst["amount"] as? Double ?? 0
        let status = inst["status"] as? String ?? "pending"

        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.subheadline.bold())
                Text("$\(Int(amount).formatted())")
                    .font(.caption)
                    .foregroundStyle(Color.rdBlue)
            }

            Spacer()

            if status == "pending" || status == "rejected" {
                Button {
                    pickerContext = PickerContext(applicationId: appId, requestId: instId, type: "installment_proof", label: label)
                    showPicker = true
                } label: {
                    Text("Subir prueba")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Color.rdBlue, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(uploadingFor != nil)
            }
        }
        .padding(10)
        .background(Color(.tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Photo Handling

    private func handlePickedPhoto(item: PhotosPickerItem, context: PickerContext) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let filename = "document_\(Date().timeIntervalSince1970).jpg"

        uploadingFor = context.applicationId
        do {
            if context.type == "payment_receipt" {
                try await api.uploadPaymentReceipt(
                    applicationId: context.applicationId,
                    amount: "0",
                    notes: "",
                    fileData: data,
                    filename: filename
                )
            } else if context.type == "installment_proof", let instId = context.requestId {
                // Use the payment plan upload endpoint
                guard let t = api.token else { throw APIError.server("No autenticado") }
                let url = URL(string: "\(APIService.baseURL)/api/applications/\(context.applicationId)/payment-plan/\(instId)/upload")!
                let boundary = "Boundary-\(UUID().uuidString)"
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
                req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
                var body = Data()
                body.append("--\(boundary)\r\n".data(using: .utf8)!)
                body.append("Content-Disposition: form-data; name=\"proof\"; filename=\"\(filename)\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
                body.append(data)
                body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
                req.httpBody = body
                let (_, _) = try await URLSession.shared.data(for: req)
            } else {
                try await api.uploadDocument(
                    applicationId: context.applicationId,
                    requestId: context.requestId,
                    type: context.type,
                    fileData: data,
                    filename: filename
                )
            }
            withAnimation { successMessage = "\(context.label) subido correctamente" }
            await load()
        } catch {
            withAnimation { successMessage = nil }
        }
        uploadingFor = nil
    }

    // MARK: - Helpers

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
            "en_revision": "En revision",
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
            case "documentos_requeridos", "pendiente_pago": return .orange
            default: return .rdBlue
            }
        }()

        return Text(statusLabel(status))
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.1))
            .clipShape(Capsule())
    }
}
