import SwiftUI

// MARK: - Buyer Application Detail (B2)
//
// Buyer-facing detail screen for an application. Distinct from
// `ApplicationDetailView`, which is the broker / agent view and exposes
// status-change controls, commission flows, and broker-only metadata.
// This screen is read-only with one CTA: retire (withdraw) the
// application.
//
// Sections:
//   1. Status timeline (read-only, derived from `timeline_events`)
//   2. Documentos solicitados (link to MyDocumentsView)
//   3. Comprobantes de pago (read-only summary)
//   4. Conversación (link / read-only summary of chat messages)
//   5. Retirar aplicación (calls POST /api/applications/:id/withdraw)

struct BuyerApplicationDetailView: View {
    let id: String
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var detail: [String: Any]? = nil
    @State private var loading: Bool = true
    @State private var errorMsg: String? = nil

    @State private var showWithdrawConfirm: Bool = false
    @State private var withdrawing: Bool = false
    @State private var withdrawReason: String = ""
    @State private var showWithdrawSheet: Bool = false

    // MARK: - Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if loading {
                    HStack {
                        Spacer()
                        ProgressView("Cargando aplicación…")
                            .padding(.vertical, 60)
                        Spacer()
                    }
                } else if let err = errorMsg {
                    errorState(err)
                } else if let app = detail {
                    header(app)
                    statusTimelineSection(app)
                    documentsSection(app)
                    paymentSection(app)
                    conversationSection(app)
                    withdrawSection(app)
                }
            }
            .padding(16)
        }
        .navigationTitle("Mi aplicación")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showWithdrawSheet) {
            withdrawSheet
        }
    }

    // MARK: - Sections

    private func header(_ app: [String: Any]) -> some View {
        let title  = (app["listing_title"] as? String) ?? "Aplicación"
        let status = (app["status"] as? String) ?? ""
        return VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.title3.bold())
                .lineLimit(3)
            HStack(spacing: 8) {
                Image(systemName: statusIcon(status))
                    .foregroundStyle(statusColor(status))
                Text(statusLabel(status))
                    .font(.subheadline.bold())
                    .foregroundStyle(statusColor(status))
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(statusColor(status).opacity(0.12))
            .clipShape(Capsule())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusTimelineSection(_ app: [String: Any]) -> some View {
        let events = (app["timeline_events"] as? [[String: Any]]) ?? []
        let statusEvents = events.filter { ($0["type"] as? String) == "status_change" }
        return sectionCard(
            title: "Línea de tiempo",
            systemImage: "clock.badge.checkmark"
        ) {
            if statusEvents.isEmpty {
                Text("Sin eventos por el momento.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(statusEvents.enumerated()), id: \.offset) { _, ev in
                        timelineRow(ev)
                    }
                }
            }
        }
    }

    private func timelineRow(_ ev: [String: Any]) -> some View {
        let desc = (ev["description"] as? String) ?? ""
        let when = (ev["created_at"] as? String) ?? ""
        let data = ev["data"] as? [String: Any]
        let toStatus = data?["to"] as? String ?? ""
        return HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(statusColor(toStatus))
                .frame(width: 8, height: 8)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(desc)
                    .font(.caption)
                Text(when)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func documentsSection(_ app: [String: Any]) -> some View {
        let requested = (app["documents_requested"] as? [[String: Any]]) ?? []
        let uploaded  = (app["documents_uploaded"]  as? [[String: Any]]) ?? []
        return sectionCard(title: "Documentos solicitados", systemImage: "doc.text.fill") {
            if requested.isEmpty && uploaded.isEmpty {
                Text("No hay documentos solicitados.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(requested.enumerated()), id: \.offset) { _, doc in
                        let label = (doc["label"] as? String) ?? (doc["type"] as? String) ?? "Documento"
                        let reqId = (doc["id"] as? String) ?? ""
                        let up = uploaded.first { ($0["request_id"] as? String) == reqId }
                        let st = (up?["review_status"] as? String) ?? (doc["status"] as? String) ?? "pending"
                        HStack {
                            Image(systemName: "doc.fill")
                                .foregroundStyle(.secondary)
                            Text(label)
                                .font(.caption)
                            Spacer()
                            Text(docStatusLabel(st))
                                .font(.caption2.bold())
                                .foregroundStyle(docStatusColor(st))
                        }
                    }
                    NavigationLink {
                        MyDocumentsView().environmentObject(api)
                    } label: {
                        Label("Ir a Mis Documentos", systemImage: "arrow.up.forward.app")
                            .font(.subheadline.bold())
                            .foregroundStyle(Color.rdBlue)
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private func paymentSection(_ app: [String: Any]) -> some View {
        let payment = app["payment"] as? [String: Any]
        let plan    = app["payment_plan"] as? [String: Any]
        return sectionCard(title: "Comprobantes de pago", systemImage: "creditcard.fill") {
            if let plan = plan, let installments = plan["installments"] as? [[String: Any]] {
                if installments.isEmpty {
                    Text("Plan de pagos sin cuotas.").font(.caption).foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(installments.enumerated()), id: \.offset) { _, inst in
                            let label = (inst["label"] as? String) ?? "Cuota"
                            let st    = (inst["status"] as? String) ?? "pending"
                            HStack {
                                Text(label).font(.caption)
                                Spacer()
                                Text(installmentStatusLabel(st))
                                    .font(.caption2.bold())
                                    .foregroundStyle(installmentStatusColor(st))
                            }
                        }
                    }
                }
            } else if let pmt = payment {
                let st     = (pmt["verification_status"] as? String) ?? "none"
                let amount = pmt["amount"] as? Double
                let cur    = (pmt["currency"] as? String) ?? "DOP"
                if st == "none" {
                    Text("Aún no has subido un comprobante.").font(.caption).foregroundStyle(.secondary)
                } else {
                    HStack {
                        if let amt = amount {
                            Text("\(cur) \(Int(amt).formatted())").font(.caption.bold())
                        }
                        Spacer()
                        Text(receiptStatusLabel(st))
                            .font(.caption2.bold())
                            .foregroundStyle(receiptStatusColor(st))
                    }
                }
            } else {
                Text("Sin información de pago.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func conversationSection(_ app: [String: Any]) -> some View {
        let events = (app["timeline_events"] as? [[String: Any]]) ?? []
        let messages = events.filter { ($0["type"] as? String) == "message" }
        return sectionCard(title: "Conversación", systemImage: "bubble.left.and.bubble.right.fill") {
            if messages.isEmpty {
                Text("Aún no hay mensajes en este hilo.").font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(messages.suffix(5).enumerated()), id: \.offset) { _, ev in
                        let actorName = (ev["actor_name"] as? String) ?? "Mensaje"
                        let desc      = (ev["description"] as? String) ?? ""
                        VStack(alignment: .leading, spacing: 2) {
                            Text(actorName).font(.caption2.bold()).foregroundStyle(Color.rdBlue)
                            Text(desc).font(.caption).foregroundStyle(.primary)
                        }
                    }
                    Text("Para responder, abre el hilo desde Conversaciones.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func withdrawSection(_ app: [String: Any]) -> some View {
        let status = (app["status"] as? String) ?? ""
        let isTerminal = (status == "rechazado" || status == "completado")
        return Group {
            if !isTerminal {
                Button(role: .destructive) {
                    showWithdrawSheet = true
                } label: {
                    Label("Retirar aplicación", systemImage: "xmark.circle.fill")
                        .font(.subheadline.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.red.opacity(0.10))
                        .foregroundStyle(Color.red)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(withdrawing)
            }
        }
    }

    // MARK: - Withdraw sheet

    private var withdrawSheet: some View {
        NavigationStack {
            Form {
                Section("Motivo (opcional)") {
                    TextEditor(text: $withdrawReason)
                        .frame(minHeight: 100)
                }
                Section {
                    Button(role: .destructive) {
                        Task { await performWithdraw() }
                    } label: {
                        if withdrawing {
                            ProgressView()
                        } else {
                            Text("Confirmar retiro")
                        }
                    }
                    .disabled(withdrawing)
                } footer: {
                    Text("Al retirar, tu agente dejará de trabajar esta solicitud.")
                        .font(.caption2)
                }
            }
            .navigationTitle("Retirar aplicación")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { showWithdrawSheet = false }
                }
            }
        }
    }

    // MARK: - Loading

    private func load() async {
        loading = (detail == nil)
        errorMsg = nil
        do {
            guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(id)") else {
                throw APIError.server("URL inválida")
            }
            let req = try api.authedRequest(url)
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                throw APIError.server("HTTP \(http.statusCode)")
            }
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                detail = json
            } else {
                throw APIError.server("Respuesta inválida")
            }
        } catch is CancellationError {
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func performWithdraw() async {
        withdrawing = true
        defer { withdrawing = false }
        do {
            guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(id)/withdraw") else { return }
            var req = try api.authedRequest(url, method: "POST")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = ["reason": withdrawReason.trimmingCharacters(in: .whitespacesAndNewlines)]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                throw APIError.server("HTTP \(http.statusCode)")
            }
            showWithdrawSheet = false
            await load()
        } catch {
            // Errors surface via the load() refetch + status; keep UI simple.
        }
    }

    // MARK: - Helpers

    private func errorState(_ msg: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text(msg).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Reintentar") { Task { await load() } }
                .buttonStyle(.borderedProminent)
        }
        .padding(40)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func sectionCard<Content: View>(title: String, systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .foregroundStyle(Color.rdBlue)
                Text(title)
                    .font(.subheadline.bold())
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func statusLabel(_ s: String) -> String {
        let map: [String: String] = [
            "aplicado": "Aplicado",
            "en_revision": "En revisión",
            "documentos_requeridos": "Documentos requeridos",
            "documentos_enviados": "Documentos enviados",
            "documentos_insuficientes": "Documentos insuficientes",
            "en_aprobacion": "En aprobación",
            "reservado": "Reservado",
            "aprobado": "Aprobado",
            "pendiente_pago": "Pendiente de pago",
            "pago_enviado": "Pago enviado",
            "pago_aprobado": "Pago aprobado",
            "completado": "Completado",
            "rechazado": "Rechazado",
        ]
        return map[s] ?? s.capitalized
    }

    private func statusIcon(_ s: String) -> String {
        switch s {
        case "completado", "pago_aprobado", "aprobado": return "checkmark.seal.fill"
        case "rechazado":                                return "xmark.circle.fill"
        case "documentos_requeridos":                    return "doc.badge.arrow.up"
        case "pendiente_pago", "pago_enviado":           return "creditcard.fill"
        default:                                         return "clock.fill"
        }
    }

    private func statusColor(_ s: String) -> Color {
        switch s {
        case "completado", "pago_aprobado", "aprobado": return Color.rdGreen
        case "rechazado", "documentos_insuficientes":   return Color.rdRed
        case "pendiente_pago", "documentos_requeridos": return .orange
        default:                                        return Color.rdBlue
        }
    }

    private func docStatusLabel(_ s: String) -> String {
        switch s {
        case "approved": return "Aprobado"
        case "rejected": return "Rechazado"
        case "pending":  return "En revisión"
        case "uploaded": return "Subido"
        default:         return "Pendiente"
        }
    }

    private func docStatusColor(_ s: String) -> Color {
        switch s {
        case "approved": return Color.rdGreen
        case "rejected": return Color.rdRed
        case "pending", "uploaded": return Color.rdBlue
        default: return .secondary
        }
    }

    private func receiptStatusLabel(_ s: String) -> String {
        switch s {
        case "approved": return "Aprobado"
        case "rejected": return "Rechazado"
        case "pending":  return "En revisión"
        default:         return "—"
        }
    }

    private func receiptStatusColor(_ s: String) -> Color {
        switch s {
        case "approved": return Color.rdGreen
        case "rejected": return Color.rdRed
        case "pending":  return .orange
        default:         return .secondary
        }
    }

    private func installmentStatusLabel(_ s: String) -> String {
        switch s {
        case "approved":       return "Aprobada"
        case "rejected":       return "Rechazada"
        case "proof_uploaded": return "En revisión"
        default:               return "Pendiente"
        }
    }

    private func installmentStatusColor(_ s: String) -> Color {
        switch s {
        case "approved": return Color.rdGreen
        case "rejected": return Color.rdRed
        case "proof_uploaded": return .orange
        default: return .secondary
        }
    }
}
