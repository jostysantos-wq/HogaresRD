import SwiftUI

// MARK: - ApplicationDetailView
//
// Broker-side detail screen for an application. Mirrors the web
// broker.html detail panel: Resumen / Documentos / Timeline tabs plus
// an Acciones menu that groups change-status, request docs, contact
// client, and open the commission form.
//
// Navigation source: DashboardApplicationsTab.ApplicationRow →
//                    NavigationLink → ApplicationDetailView(id:)
//
// TODO(C4 — broker reassign): wire a "Reasignar" action into the
// Acciones menu. The web counterpart calls
//   POST /api/applications/:id/reassign  { newBrokerUserId, reason }
// and pulls candidates from /api/inmobiliaria/brokers. Skipped here
// because dropping a same-team picker into the existing menu cleanly
// would require >30 lines of new SwiftUI plus team-fetch plumbing.

struct ApplicationDetailView: View {
    let id: String

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var loading = true
    @State private var detail: ApplicationDetail?
    @State private var errorMsg: String?
    @State private var selectedTab: DetailTab = .resumen

    // Action state
    @State private var showStatusSheet   = false
    @State private var showDocsSheet     = false
    @State private var showMessageSheet  = false
    @State private var showCommissionSheet = false
    @State private var showSkipDocsSheet = false
    @State private var showReassignSheet = false
    @State private var showSkipPhaseSheet = false
    @State private var showWithdrawAlert  = false
    @State private var withdrawNote: String = ""
    @State private var withdrawing: Bool = false
    @State private var withdrawError: String?
    @State private var skipDocsNote      = ""
    @State private var skipDocsBusy      = false
    @State private var skipDocsError: String?

    // #61: doc review sheet — present ReviewDocumentSheet (defined in
    // BrokerDashboardView) for any uploaded document tapped in the
    // Documentos tab. We adapt the row's data into the ArchiveDocument
    // shape that sheet already speaks.
    @State private var reviewingDoc: ArchiveDocument?

    // Workflow action bar state
    @State private var workflowBusy      = false
    @State private var workflowError: String?

    // Polling state
    @State private var lastStateVersion: String?

    enum DetailTab: String, CaseIterable, Identifiable {
        case resumen    = "Resumen"
        case documentos = "Documentos"
        case timeline   = "Timeline"
        var id: String { rawValue }
        var icon: String {
            switch self {
            case .resumen:    return "person.text.rectangle"
            case .documentos: return "doc.text.fill"
            case .timeline:   return "clock.arrow.circlepath"
            }
        }
    }

    var body: some View {
        Group {
            if loading {
                ProgressView("Cargando aplicación…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg, detail == nil {
                VStack(spacing: 14) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 40)).foregroundStyle(.orange)
                    Text(err)
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Reintentar") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                }
                .padding(40)
            } else if let d = detail {
                content(d)
            }
        }
        .navigationTitle(detail?.client.name ?? "Aplicación")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let d = detail {
                ToolbarItem(placement: .topBarTrailing) {
                    actionMenu(d)
                }
            }
        }
        .task { await load() }
        .task {
            // Subscribes to the SSE stream for zero-lag updates and
            // automatically falls back to /state polling if the stream
            // fails. Auto-cancelled when the view disappears.
            await startLiveUpdates()
        }
        .refreshable { await load() }
        // Re-fetch every time the app comes back to the foreground so the
        // broker never acts on a detail that's older than the last time
        // they switched away. Belt-and-suspenders with push notifications.
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active && detail != nil {
                Task { await load() }
            }
        }
        .sheet(isPresented: $showStatusSheet) {
            if let d = detail {
                ChangeStatusSheet(detail: d) { updated in
                    detail = updated
                }
                .environmentObject(api)
            }
        }
        .sheet(isPresented: $showDocsSheet) {
            if let d = detail {
                RequestDocumentsSheet(applicationId: d.id) { updated in
                    detail = updated
                }
                .environmentObject(api)
            }
        }
        .sheet(isPresented: $showMessageSheet) {
            if let d = detail {
                ContactClientSheet(detail: d)
                    .environmentObject(api)
            }
        }
        .sheet(isPresented: $showCommissionSheet) {
            if let d = detail, let row = commissionRow(from: d) {
                CommissionFormSheet(row: row, mode: .edit) {
                    Task { await load() }
                }
                .environmentObject(api)
            }
        }
        .sheet(isPresented: $showSkipDocsSheet) {
            skipDocsSheetBody
        }
        .sheet(isPresented: $showReassignSheet) {
            // #57: same-team broker picker → POST /applications/:id/reassign
            if let d = detail {
                ReassignBrokerSheet(applicationId: d.id) {
                    showReassignSheet = false
                    Task { await load() }
                }
                .environmentObject(api)
            }
        }
        .sheet(isPresented: $showSkipPhaseSheet) {
            // #60: bypass-the-flow target picker → POST /:id/skip-phase
            if let d = detail {
                SkipPhaseSheet(detail: d) { updated in
                    detail = updated
                }
                .environmentObject(api)
            }
        }
        .alert("Retirar solicitud", isPresented: $showWithdrawAlert) {
            TextField("Motivo (opcional)", text: $withdrawNote)
            Button("Cancelar", role: .cancel) { withdrawNote = "" }
            Button("Retirar", role: .destructive) {
                Task { await withdraw() }
            }
        } message: {
            Text("Esta acción cierra la solicitud. El agente y la inmobiliaria serán notificados. No podrás reactivarla desde la app.")
        }
        .alert(withdrawError ?? "", isPresented: .constant(withdrawError != nil)) {
            Button("OK") { withdrawError = nil }
        }
        .sheet(item: $reviewingDoc) { doc in
            NavigationStack {
                ReviewDocumentSheet(
                    doc: doc,
                    onReviewed: {
                        reviewingDoc = nil
                        Task { await load() }
                    },
                    onPreview: { previewReviewingDocument(doc) }
                )
                .environmentObject(api)
            }
        }
        .sheet(item: $pendingPreviewURL) { wrap in
            ArchiveDocPreview(url: wrap.url)
                .ignoresSafeArea()
        }
    }

    /// Adapt a `AppDocumentUploaded` row into the `ArchiveDocument` shape
    /// that `ReviewDocumentSheet` already renders. We only need fields
    /// the sheet displays + the doc/app IDs to call the review endpoint.
    private func makeArchiveDocument(
        from up: AppDocumentUploaded,
        applicationDetail d: ApplicationDetail
    ) -> ArchiveDocument {
        let sizeStr: String? = up.size.map { n in
            let kb = Double(n) / 1024.0
            return kb >= 1024
                ? String(format: "%.1f MB", kb / 1024)
                : String(format: "%.0f KB", kb)
        }
        return ArchiveDocument(
            id:          up.id,
            appId:       d.id,
            docId:       up.id,
            name:        up.original_name ?? up.label,
            filename:    up.filename,
            type:        up.type,
            status:      up.review_status,
            client:      d.client.name,
            clientEmail: d.client.email,
            property:    d.listing_title,
            listingId:   d.listing_id,
            uploadDate:  up.uploaded_at,
            fileSize:    sizeStr,
            reviewNote:  up.review_note
        )
    }

    // #61: shared preview helper — same temp-file + SFSafariView pattern
    // used by BrokerDashboardView. Documents are auth-only downloads,
    // so we fetch the bytes and write them to a temp file before
    // handing them to the preview sheet. The actual sheet is presented
    // by ReviewDocumentSheet's onPreview callback.
    @State private var pendingPreviewURL: ArchiveDocURL?

    private func previewReviewingDocument(_ doc: ArchiveDocument) {
        guard let appId = doc.appId, let docId = doc.docId else { return }
        Task {
            do {
                let (data, mime) = try await api.downloadDocument(
                    applicationId: appId, documentId: docId
                )
                let ext: String = {
                    if let m = mime?.lowercased() {
                        if m.contains("pdf") { return "pdf" }
                        if m.contains("png") { return "png" }
                        if m.contains("jpeg") || m.contains("jpg") { return "jpg" }
                        if m.contains("heic") { return "heic" }
                        if m.contains("webp") { return "webp" }
                    }
                    return "bin"
                }()
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("hrd-doc-\(UUID().uuidString).\(ext)")
                try data.write(to: tmp, options: .atomic)
                await MainActor.run { pendingPreviewURL = ArchiveDocURL(url: tmp) }
            } catch {
                // Silent — broker can still hit Approve/Reject in the sheet.
            }
        }
    }

    // MARK: - Skip-documents sheet
    //
    // Presented from the Documentos tab when there's at least one pending
    // request. Captures a mandatory note (server-side minimum 5 chars) and
    // calls /documents/skip, which marks every pending request as 'skipped'
    // with that reason and advances the status out of the doc-cycle. The
    // note ends up in the application's audit timeline.
    @ViewBuilder
    private var skipDocsSheetBody: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Confirma que ya tienes los documentos del cliente y que no necesitas que los suba.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Comentario") {
                    TextEditor(text: $skipDocsNote)
                        .frame(minHeight: 110)
                    Text("Mínimo 5 caracteres. Quedará registrado en el historial de la aplicación.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let err = skipDocsError {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Omitir documentos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { showSkipDocsSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if skipDocsBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Confirmar") {
                            Task { await performSkipDocs() }
                        }
                        .disabled(skipDocsNote.trimmingCharacters(in: .whitespacesAndNewlines).count < 5)
                    }
                }
            }
        }
    }

    private func performSkipDocs() async {
        guard let id = detail?.id else { return }
        skipDocsBusy = true
        skipDocsError = nil
        defer { skipDocsBusy = false }
        do {
            let updated = try await api.skipApplicationDocuments(id: id, note: skipDocsNote)
            await MainActor.run {
                detail = updated
                showSkipDocsSheet = false
                skipDocsNote = ""
            }
        } catch {
            await MainActor.run {
                skipDocsError = (error as? APIError).map { e in
                    if case .server(let msg) = e { return msg } else { return error.localizedDescription }
                } ?? error.localizedDescription
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ d: ApplicationDetail) -> some View {
        VStack(spacing: 0) {
            // Header strip
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(d.listing_title ?? "Propiedad")
                            .font(.headline)
                            .lineLimit(2)
                        Text(d.priceFormatted)
                            .font(.subheadline.bold())
                            .foregroundStyle(Color.rdBlue)
                    }
                    Spacer()
                    statusBadge(d.status)
                }
                if let reason = d.status_reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(.horizontal)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .background(Color(.systemBackground))

            // Tab selector
            HStack(spacing: 6) {
                ForEach(DetailTab.allCases) { tab in
                    Button {
                        withAnimation(Motion.fade) { selectedTab = tab }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: tab.icon).font(.system(size: 11))
                            Text(tab.rawValue).font(.caption).bold()
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(selectedTab == tab ? Color.rdBlue : Color(.secondarySystemFill))
                        .foregroundStyle(selectedTab == tab ? .white : .primary)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 10)

            Divider()

            // Content
            ScrollView {
                VStack(spacing: 16) {
                    switch selectedTab {
                    case .resumen:    resumenSection(d)
                    case .documentos: documentosSection(d)
                    case .timeline:   timelineSection(d)
                    }
                }
                .padding()
            }
        }
    }

    // MARK: - Resumen tab

    @ViewBuilder
    private func resumenSection(_ d: ApplicationDetail) -> some View {
        // Primary action bar — the broker's single most important
        // "next thing" based on the current workflow stage.
        primaryActionBar(for: d)

        // Progress checklist — linear view of the workflow showing
        // where the application currently is and what's blocked on
        // whom.
        workflowChecklistView(for: d)

        // Client info
        infoBlock(title: "Información del Cliente") {
            infoRow("Nombre",        d.client.name)
            infoRow("Email",         d.client.email ?? "—")
            infoRow("Teléfono",      d.client.phone ?? "—")
            if let m = d.contact_method, !m.isEmpty {
                infoRow("Contacto preferido", m.capitalized)
            }
            if let idn = d.client.id_number, !idn.isEmpty {
                infoRow("Cédula / Pasaporte", idn)
            }
            if let na = d.client.nationality, !na.isEmpty {
                infoRow("Nacionalidad", na)
            }
            if let dob = d.client.date_of_birth, !dob.isEmpty {
                infoRow("Fecha de nacimiento", dob)
            }
            if let addr = d.client.current_address, !addr.isEmpty {
                infoRow("Dirección actual", addr)
            }
        }

        // Employment
        if let status = d.client.employment_status, !status.isEmpty {
            infoBlock(title: "Información Laboral") {
                infoRow("Situación", employmentLabel(status))
                if let e = d.client.employer_name, !e.isEmpty {
                    infoRow("Empleador", e)
                }
                if let j = d.client.job_title, !j.isEmpty {
                    infoRow("Puesto", j)
                }
                if let inc = d.client.monthly_income, !inc.isEmpty {
                    infoRow("Ingreso mensual", inc + " " + (d.client.income_currency ?? "DOP"))
                }
            }
        }

        // Application details
        infoBlock(title: "Detalles de la Aplicación") {
            if let i = d.intent, !i.isEmpty       { infoRow("Intención", i.capitalized) }
            if let t = d.timeline, !t.isEmpty     { infoRow("Plazo", t) }
            if let f = d.financing, !f.isEmpty    { infoRow("Financiamiento", f.capitalized) }
            if let b = d.budget, !b.isEmpty       { infoRow("Presupuesto", b) }
            if let pa = d.pre_approved {          infoRow("Pre-aprobado", pa ? "Sí" : "No") }
            if let n = d.notes, !n.isEmpty        { infoRow("Notas", n) }
        }

        // Co-applicant
        if let co = d.co_applicant,
           (co.name?.isEmpty == false || co.phone?.isEmpty == false) {
            infoBlock(title: "Co-aplicante") {
                if let n = co.name,  !n.isEmpty  { infoRow("Nombre", n) }
                if let p = co.phone, !p.isEmpty  { infoRow("Teléfono", p) }
                if let i = co.id_number, !i.isEmpty { infoRow("Cédula / Pasaporte", i) }
                if let inc = co.monthly_income, !inc.isEmpty {
                    infoRow("Ingreso mensual", inc)
                }
            }
        }

        // Broker assigned
        if let b = d.broker {
            infoBlock(title: "Agente Asignado") {
                infoRow("Agente", b.name ?? "Sin asignar")
                if let e = b.email, !e.isEmpty { infoRow("Email", e) }
                if let p = b.phone, !p.isEmpty { infoRow("Teléfono", p) }
                if let a = b.agency_name, !a.isEmpty { infoRow("Inmobiliaria", a) }
            }
        }

        // Commission snapshot
        if let c = d.commission, c.sale_amount > 0 {
            infoBlock(title: "Comisión") {
                HStack {
                    Text("Estado")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(c.statusLabel)
                        .font(.caption.bold())
                        .foregroundStyle(commissionColor(c.status))
                }
                infoRow("Venta",            formatCurrencyD(c.sale_amount))
                infoRow("Comisión agente",  "\(c.agent_percent)% · \(formatCurrencyD(c.agent_amount))")
                if c.inmobiliaria_amount > 0 {
                    infoRow("Cuota inmobiliaria", "\(c.inmobiliaria_percent)% · \(formatCurrencyD(c.inmobiliaria_amount))")
                }
                infoRow("Neto agente",      formatCurrencyD(c.agent_net))
                if let note = c.adjustment_note, !note.isEmpty {
                    infoRow("Nota de revisión", note)
                }
            }
        }
    }

    // MARK: - Documentos tab

    @ViewBuilder
    private func documentosSection(_ d: ApplicationDetail) -> some View {
        Button {
            showDocsSheet = true
        } label: {
            Label("Solicitar documentos", systemImage: "doc.badge.plus")
                .font(.subheadline.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color.rdBlue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)

        // Skip-documents action — only meaningful when there's at least one
        // pending request. Used when the broker already has the documents
        // offline and doesn't want the client to upload anything.
        let pendingCount = (d.documents_requested ?? []).filter {
            ($0.status ?? "pending") == "pending"
        }.count
        if pendingCount > 0 {
            Button {
                skipDocsNote = ""
                skipDocsError = nil
                showSkipDocsSheet = true
            } label: {
                Label("Omitir documentos pendientes", systemImage: "checkmark.circle")
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .foregroundStyle(Color.rdBlue)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.rdBlue.opacity(0.4), lineWidth: 1.5)
                    )
            }
            .buttonStyle(.plain)
        }

        // Requested documents
        let requested = d.documents_requested ?? []
        if !requested.isEmpty {
            sectionHeader("Solicitados")
            ForEach(requested) { req in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: docStatusIcon(req.status ?? "pending"))
                        .foregroundStyle(docStatusColor(req.status ?? "pending"))
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(req.label ?? DocumentCatalog.label(for: req.type))
                            .font(.subheadline.bold())
                        HStack(spacing: 8) {
                            Text(docStatusLabel(req.status ?? "pending"))
                                .font(.caption2.bold())
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(docStatusColor(req.status ?? "pending").opacity(0.15))
                                .foregroundStyle(docStatusColor(req.status ?? "pending"))
                                .clipShape(Capsule())
                            if req.required == true {
                                Text("Requerido")
                                    .font(.caption2.bold())
                                    .foregroundStyle(.red)
                            }
                            if req.deferred == true {
                                Text("Diferido")
                                    .font(.caption2.bold())
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                    Spacer()
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }

        // Uploaded documents
        let uploaded = d.documents_uploaded ?? []
        if !uploaded.isEmpty {
            sectionHeader("Subidos")
            ForEach(uploaded) { up in
                Button {
                    // #61: open ReviewDocumentSheet to approve/reject
                    // straight from the detail view. We adapt the
                    // upload row into the ArchiveDocument shape that
                    // sheet already renders.
                    reviewingDoc = makeArchiveDocument(from: up, applicationDetail: d)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "doc.fill")
                            .foregroundStyle(Color.rdBlue)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(up.original_name ?? up.label ?? DocumentCatalog.label(for: up.type ?? ""))
                                .font(.subheadline.bold())
                                .lineLimit(1)
                                .foregroundStyle(.primary)
                            if let rs = up.review_status {
                                Text(reviewStatusLabel(rs))
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(reviewStatusColor(rs).opacity(0.15))
                                    .foregroundStyle(reviewStatusColor(rs))
                                    .clipShape(Capsule())
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption2.bold())
                            .foregroundStyle(.tertiary)
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }

        if requested.isEmpty && uploaded.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 38)).foregroundStyle(.secondary)
                Text("Sin documentos todavía")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Pulsa «Solicitar documentos» para pedir lo que necesitas al cliente.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(.vertical, 30)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Timeline tab

    @ViewBuilder
    private func timelineSection(_ d: ApplicationDetail) -> some View {
        let events = (d.timeline_events ?? []).sorted {
            ($0.created_at ?? "") > ($1.created_at ?? "")
        }
        if events.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "clock")
                    .font(.system(size: 38)).foregroundStyle(.secondary)
                Text("Sin eventos todavía").font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.vertical, 30)
            .frame(maxWidth: .infinity)
        } else {
            ForEach(events) { ev in
                let internalNote = ev.is_internal == true
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(timelineEventColor(ev.type))
                        .frame(width: 10, height: 10)
                        .padding(.top, 6)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if internalNote {
                                Image(systemName: "lock.fill")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(ev.description ?? ev.type.capitalized)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                        }
                        HStack(spacing: 6) {
                            if internalNote {
                                Text("Nota interna").bold()
                                    .foregroundStyle(.orange)
                            }
                            if let actor = ev.actor_name, !actor.isEmpty {
                                Text(actor)
                            }
                            if let date = ev.created_at {
                                Text(formatEventDate(date))
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(12)
                .background(internalNote
                            ? Color.orange.opacity(0.10)
                            : Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    // MARK: - Action menu

    @ViewBuilder
    private func actionMenu(_ d: ApplicationDetail) -> some View {
        Menu {
            Button {
                showMessageSheet = true
            } label: {
                Label("Enviar mensaje al cliente", systemImage: "message.fill")
            }
            .disabled((d.client.email?.isEmpty ?? true) && (d.client.user_id?.isEmpty ?? true))

            Button {
                showStatusSheet = true
            } label: {
                Label("Cambiar estado", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(ApplicationStatus.nextOptions(from: d.status).isEmpty)

            Button {
                showDocsSheet = true
            } label: {
                Label("Solicitar documentos", systemImage: "doc.badge.plus")
            }

            // #60: skip-phase — broker overrides the natural status flow.
            // Only shown when there's at least one valid forward target.
            if !ApplicationStatus.nextOptions(from: d.status).isEmpty {
                Button {
                    showSkipPhaseSheet = true
                } label: {
                    Label("Saltar fase", systemImage: "forward.fill")
                }
            }

            // #57: Reasignar — broker-only (gated on user role). The
            // server endpoint also enforces same-inmobiliaria membership.
            if let role = api.currentUser?.role.lowercased(),
               ["broker", "agency", "inmobiliaria", "constructora", "admin"].contains(role) {
                Button {
                    showReassignSheet = true
                } label: {
                    Label("Reasignar", systemImage: "arrow.triangle.swap")
                }
            }

            let commissionStatuses = ["aprobado", "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"]
            if commissionStatuses.contains(d.status) {
                Button {
                    showCommissionSheet = true
                } label: {
                    Label("Registrar / Revisar comisión", systemImage: "dollarsign.circle.fill")
                }
            }

            // Buyer-only: withdraw their own application. Hidden once
            // the deal has reached terminal/late states. Server also
            // enforces ownership.
            if let me = api.currentUser?.id,
               d.client.user_id == me,
               !["completado", "rechazado"].contains(d.status) {
                Divider()
                Button(role: .destructive) {
                    showWithdrawAlert = true
                } label: {
                    Label("Retirar solicitud", systemImage: "xmark.circle.fill")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle.fill")
                .font(.title3)
        }
    }

    // MARK: - Workflow Checklist + Primary Action Bar

    @ViewBuilder
    private func primaryActionBar(for d: ApplicationDetail) -> some View {
        if let step = WorkflowChecklist.primaryAction(for: d.status) {
            VStack(alignment: .leading, spacing: 10) {
                // Context line
                HStack(spacing: 6) {
                    Circle()
                        .fill(step.actor.color)
                        .frame(width: 6, height: 6)
                    Text("Siguiente paso · \(step.actor.label)")
                        .font(.caption2).bold()
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                }

                Text(step.title)
                    .font(.headline)
                Text(step.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // Primary + optional secondary action
                HStack(spacing: 8) {
                    if let label = step.actionLabel, let action = step.action {
                        Button {
                            handleWorkflowAction(action, on: d)
                        } label: {
                            HStack {
                                if workflowBusy { ProgressView().tint(.white) }
                                Image(systemName: step.icon)
                                Text(label)
                            }
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(step.actor == .client ? Color.orange : Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .disabled(workflowBusy)
                    }

                    if let secondary = WorkflowChecklist.secondaryAction(for: d.status),
                       let sLabel = secondary.actionLabel,
                       let sAction = secondary.action {
                        Button {
                            handleWorkflowAction(sAction, on: d)
                        } label: {
                            HStack {
                                Image(systemName: secondary.icon)
                                Text(sLabel)
                            }
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(.secondarySystemGroupedBackground))
                            .foregroundStyle(Color.rdBlue)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .disabled(workflowBusy)
                    }
                }

                if let err = workflowError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.rdBlue.opacity(0.25), lineWidth: 1)
            )
        } else if d.status == "completado" {
            workflowBanner(icon: "checkmark.seal.fill",
                           color: .green,
                           title: "Aplicación completada",
                           subtitle: "Registra la comisión si aún no lo has hecho.")
        } else if d.status == "rechazado" {
            workflowBanner(icon: "xmark.octagon.fill",
                           color: .red,
                           title: "Aplicación rechazada",
                           subtitle: d.status_reason ?? "Puedes reabrir esta aplicación desde el menú.")
        }
    }

    private func workflowBanner(icon: String, color: Color, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.bold())
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(14)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func workflowChecklistView(for d: ApplicationDetail) -> some View {
        let steps = WorkflowChecklist.steps(for: d.status)

        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Progreso", systemImage: "list.bullet.clipboard")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                Text("\(completedStepCount(steps, status: d.status)) de \(steps.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 8)

            VStack(spacing: 0) {
                ForEach(Array(steps.enumerated()), id: \.element.id) { idx, step in
                    checklistRow(step: step,
                                 status: d.status,
                                 isFirst: idx == 0,
                                 isLast: idx == steps.count - 1)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func completedStepCount(_ steps: [WorkflowStep], status: String) -> Int {
        steps.filter { WorkflowChecklist.rowState(for: $0, status: status) == .done }.count
    }

    @ViewBuilder
    private func checklistRow(step: WorkflowStep,
                              status: String,
                              isFirst: Bool,
                              isLast: Bool) -> some View {
        let state = WorkflowChecklist.rowState(for: step, status: status)

        HStack(alignment: .top, spacing: 12) {
            // Left: indicator + connector line
            VStack(spacing: 0) {
                ZStack {
                    Circle()
                        .fill(indicatorFill(state))
                        .frame(width: 24, height: 24)
                    Image(systemName: indicatorIcon(state))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(indicatorIconColor(state))
                }
                if !isLast {
                    Rectangle()
                        .fill(state == .done ? Color.green.opacity(0.35) : Color(.separator))
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 24)

            // Right: title + subtitle + actor chip
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(step.title)
                        .font(.subheadline.bold())
                        .foregroundStyle(titleColor(state))
                    if state == .active || state == .waiting {
                        Text(state == .waiting ? "ESPERANDO" : "ACTUAL")
                            .font(.system(size: 8, weight: .heavy))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(state == .waiting ? Color.orange : Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }
                }
                Text(step.subtitle)
                    .font(.caption2)
                    .foregroundStyle(state == .future ? .tertiary : .secondary)
            }
            Spacer()
        }
        .padding(.vertical, isFirst || isLast ? 6 : 8)
    }

    private func indicatorFill(_ state: WorkflowChecklist.RowState) -> Color {
        switch state {
        case .done:    return .green
        case .active:  return .rdBlue
        case .waiting: return .orange
        case .future:  return Color(.tertiarySystemFill)
        }
    }
    private func indicatorIcon(_ state: WorkflowChecklist.RowState) -> String {
        switch state {
        case .done:    return "checkmark"
        case .active:  return "play.fill"
        case .waiting: return "hourglass"
        case .future:  return "circle"
        }
    }
    private func indicatorIconColor(_ state: WorkflowChecklist.RowState) -> Color {
        switch state {
        case .done, .active, .waiting: return .white
        case .future: return .secondary
        }
    }
    private func titleColor(_ state: WorkflowChecklist.RowState) -> Color {
        switch state {
        case .done:    return .primary
        case .active:  return .primary
        case .waiting: return .primary
        case .future:  return .secondary
        }
    }

    // MARK: - Workflow Action Handler

    private func handleWorkflowAction(_ action: WorkflowAction, on d: ApplicationDetail) {
        workflowError = nil
        switch action {
        case .setStatus(let newStatus, let reasonRequired):
            if reasonRequired {
                // Open the status sheet so the broker can enter a reason.
                showStatusSheet = true
            } else {
                Task { await changeStatus(to: newStatus) }
            }
        case .openDocumentRequest:
            showDocsSheet = true
        case .reviewDocuments:
            selectedTab = .documentos
        case .reviewPayment:
            // Route to the payments tab of the parent dashboard — for
            // now we open the ChangeStatusSheet which will surface the
            // waiting explanation. A future pass can deep-link straight
            // into ReviewPaymentSheet.
            showStatusSheet = true
        case .contactClient:
            showMessageSheet = true
        case .openCommission:
            showCommissionSheet = true
        case .remindClient:
            showMessageSheet = true
        }
    }

    private func changeStatus(to newStatus: String) async {
        workflowBusy = true
        defer { workflowBusy = false }
        do {
            let updated = try await api.updateApplicationStatus(
                id: id,
                newStatus: newStatus,
                reason: ""
            )
            detail = updated
        } catch {
            if case .server(let s)? = error as? APIError {
                workflowError = s
                // On stale state errors, refresh so the UI catches up.
                if s.contains("Transición no válida") || s.contains("automáticamente") {
                    await load()
                }
            } else {
                workflowError = "Error al actualizar el estado"
            }
        }
    }

    // MARK: - Load

    private func load() async {
        if detail == nil { loading = true }
        errorMsg = nil
        do {
            detail = try await api.fetchApplicationDetail(id: id)
            lastStateVersion = nil  // reset the poll baseline
        } catch is CancellationError {
        } catch {
            if case .server(let s)? = error as? APIError { errorMsg = s }
            else { errorMsg = "No se pudo cargar la aplicación" }
        }
        loading = false
    }

    /// Buyer withdraws their own application. Server enforces ownership
    /// and rejects the request once the deal is in a terminal state.
    private func withdraw() async {
        let note = withdrawNote.trimmingCharacters(in: .whitespacesAndNewlines)
        withdrawNote = ""
        withdrawing = true
        defer { withdrawing = false }
        do {
            _ = try await api.withdrawApplication(id: id, reason: note.isEmpty ? nil : note)
            await load()
        } catch {
            withdrawError = (error as? LocalizedError)?.errorDescription ?? "No se pudo retirar la solicitud."
        }
    }

    // MARK: - Live state updates (SSE + polling fallback)

    /// Primary path: subscribe to the backend SSE stream and reload the
    /// full detail whenever a new state envelope arrives with a version
    /// we haven't seen. If the stream errors (network blip, Nginx reap,
    /// older backend) we back off exponentially and retry; after a few
    /// failures we fall back to plain polling so the broker always gets
    /// at least eventual consistency.
    private func startLiveUpdates() async {
        var backoff: UInt64 = 1_000_000_000 // 1s
        var sseFailures = 0

        while !Task.isCancelled {
            let stream = ApplicationEventStream(applicationId: id, api: api)
            do {
                for try await state in stream.states() {
                    if Task.isCancelled { return }
                    // Successful event → reset the backoff.
                    backoff = 1_000_000_000
                    sseFailures = 0
                    await applyLiveState(state)
                }
            } catch {
                sseFailures += 1
                if Task.isCancelled { return }

                // After several consecutive SSE failures, assume the
                // endpoint is unreachable and switch to polling for the
                // rest of this view session. This keeps the broker
                // informed even if an intermediate proxy strips SSE.
                if sseFailures >= 3 {
                    await startStatePolling()
                    return
                }
                // Exponential backoff before reconnecting.
                try? await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, 30_000_000_000) // cap at 30s
            }
        }
    }

    private func applyLiveState(_ state: ApplicationState) async {
        if let last = lastStateVersion, last == state.version { return }
        lastStateVersion = state.version
        // First event after load just records the baseline.
        if detail != nil {
            await load()
        }
    }

    /// Fallback when SSE is unavailable — polls /:id/state every ~20s
    /// and only re-fetches the full detail if the version changed.
    private func startStatePolling() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            if Task.isCancelled { break }
            guard let state = await api.getApplicationState(id: id) else { continue }
            await applyLiveState(state)
        }
    }

    // MARK: - Small helpers

    @ViewBuilder
    private func infoBlock<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            VStack(spacing: 0) {
                content()
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 130, alignment: .leading)
            Text(value)
                .font(.caption)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(.separator)).frame(height: 0.5).padding(.leading, 130)
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.caption.bold())
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
    }

    private func statusBadge(_ s: String) -> some View {
        let (bg, fg): (Color, Color) = {
            switch s {
            case "aplicado":                return (.blue.opacity(0.15), .blue)
            case "en_revision":             return (.orange.opacity(0.15), .orange)
            case "documentos_requeridos",
                 "documentos_enviados":     return (.yellow.opacity(0.2), .yellow)
            case "documentos_insuficientes": return (.red.opacity(0.15), .red)
            case "en_aprobacion":           return (.purple.opacity(0.15), .purple)
            case "reservado":               return (.teal.opacity(0.15), .teal)
            case "aprobado":                return (.green.opacity(0.15), .green)
            case "pendiente_pago",
                 "pago_enviado":            return (.orange.opacity(0.15), .orange)
            case "pago_aprobado",
                 "completado":              return (.green.opacity(0.2), .green)
            case "rechazado":               return (.red.opacity(0.15), .red)
            default:                        return (.gray.opacity(0.15), .gray)
            }
        }()
        return Text(ApplicationStatus.label(for: s))
            .font(.caption2.bold())
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(bg)
            .foregroundStyle(fg)
            .clipShape(Capsule())
    }

    private func employmentLabel(_ key: String) -> String {
        switch key {
        case "employed":       return "Empleado"
        case "self_employed":  return "Independiente"
        case "retired":        return "Jubilado"
        case "student":        return "Estudiante"
        case "unemployed":     return "Sin empleo"
        default:               return key.capitalized
        }
    }

    private func docStatusLabel(_ s: String) -> String {
        switch s {
        case "pending":  return "Pendiente"
        case "uploaded": return "Subido"
        case "approved": return "Aprobado"
        case "rejected": return "Rechazado"
        default:         return s.capitalized
        }
    }
    private func docStatusColor(_ s: String) -> Color {
        switch s {
        case "pending":  return .orange
        case "uploaded": return .blue
        case "approved": return .green
        case "rejected": return .red
        default:         return .gray
        }
    }
    private func docStatusIcon(_ s: String) -> String {
        switch s {
        case "uploaded": return "doc.fill"
        case "approved": return "checkmark.seal.fill"
        case "rejected": return "xmark.seal.fill"
        default:         return "hourglass"
        }
    }

    private func reviewStatusLabel(_ s: String) -> String {
        docStatusLabel(s)
    }
    private func reviewStatusColor(_ s: String) -> Color {
        docStatusColor(s)
    }

    private func commissionColor(_ s: String) -> Color {
        switch s {
        case "approved":       return .green
        case "rejected":       return .red
        case "pending_review": return .orange
        default:               return .gray
        }
    }

    private func timelineEventColor(_ type: String) -> Color {
        switch type {
        case "status_change":       return .blue
        case "document_uploaded":   return .purple
        case "documents_requested": return .orange
        case "message":             return .teal
        case "commission_submitted",
             "commission_approve":  return .green
        case "commission_reject":   return .red
        default:                    return .gray
        }
    }

    private func formatEventDate(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        guard let date = f.date(from: iso) else { return iso }
        let out = DateFormatter()
        out.locale = Locale(identifier: "es_DO")
        out.dateFormat = "d MMM · HH:mm"
        return out.string(from: date)
    }

    private func formatCurrencyD(_ value: Double, code: String = "DOP") -> String {
        // #50: render with es_DO locale so DOP shows RD$ and USD shows US$.
        let cleaned = code.uppercased().isEmpty ? "DOP" : code.uppercased()
        return value.formatted(
            .currency(code: cleaned)
            .locale(Locale(identifier: "es_DO"))
            .precision(.fractionLength(0))
        )
    }

    /// Build a synthetic CommissionRow so we can reuse the existing
    /// CommissionFormSheet from BrokerDashboardView.
    private func commissionRow(from d: ApplicationDetail) -> CommissionRow? {
        let base = d.commission ?? Commission(
            sale_amount: 0, agent_percent: 0, agent_amount: 0,
            inmobiliaria_percent: 0, inmobiliaria_amount: 0, agent_net: 0,
            status: "pending_review",
            submitted_by: nil, submitted_name: nil, submitted_at: nil,
            reviewed_by: nil, reviewer_name: nil, reviewed_at: nil,
            adjustment_note: nil
        )
        return CommissionRow(
            application_id: d.id,
            listing_title:  d.listing_title,
            listing_price:  d.listing_price,
            client_name:    d.client.name,
            agent_user_id:  d.broker?.user_id,
            agent_name:     d.broker?.name,
            commission:     base,
            status:         d.status,
            created_at:     d.created_at,
            updated_at:     d.updated_at
        )
    }
}

// MARK: - Change Status Sheet

struct ChangeStatusSheet: View {
    let detail: ApplicationDetail
    var onChanged: (ApplicationDetail) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    // Start from the passed-in detail but allow auto-refresh to replace it
    // with the current server state so we never try an invalid transition.
    @State private var liveDetail: ApplicationDetail
    @State private var refreshing = true
    @State private var target: String = ""
    @State private var reason: String = ""
    @State private var saving = false
    @State private var errorMsg: String?
    @State private var infoMsg: String?

    init(detail: ApplicationDetail, onChanged: @escaping (ApplicationDetail) -> Void) {
        self.detail = detail
        self.onChanged = onChanged
        _liveDetail = State(initialValue: detail)
    }

    private var currentStatus: String { liveDetail.status }

    // Only show the broker-settable transitions. Client-automated
    // (pago_enviado, documentos_enviados) and review-automated
    // (pago_aprobado, documentos_insuficientes) statuses are hidden
    // because they're set by dedicated flows elsewhere in the app.
    private var options: [String] {
        ApplicationStatus.manualNextOptions(from: currentStatus)
    }

    // Gives the user a heads-up if there ARE next steps, but none of
    // them are manual (e.g. pendiente_pago → pago_enviado only, which
    // is driven by the client uploading a receipt).
    private var waitingOnOther: Bool {
        !ApplicationStatus.nextOptions(from: currentStatus).isEmpty && options.isEmpty
    }

    private var waitingExplanation: String {
        switch currentStatus {
        case "pendiente_pago":
            return "Esperando que el cliente suba el comprobante de pago."
        case "documentos_requeridos":
            return "Esperando que el cliente suba los documentos solicitados."
        case "pago_enviado":
            return "Usa \"Revisar Pago\" para aprobar o rechazar el comprobante."
        case "documentos_enviados":
            return "Revisa cada documento desde la pestaña Documentos."
        case "pago_aprobado":
            return "Pago aprobado — marca como Completado cuando corresponda."
        default:
            return "Este estado se actualiza automáticamente por otro flujo."
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Estado actual") {
                    HStack {
                        Text(ApplicationStatus.label(for: currentStatus))
                        Spacer()
                        if refreshing {
                            ProgressView().scaleEffect(0.7)
                        }
                    }
                }
                if let info = infoMsg {
                    Section {
                        Text(info)
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Section("Nuevo estado") {
                    if options.isEmpty {
                        if waitingOnOther {
                            // Specific explanation when the next step is
                            // client- or review-driven and can't be set manually.
                            VStack(alignment: .leading, spacing: 6) {
                                Label(waitingExplanation, systemImage: "hourglass")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                                Text("Este paso se actualizará solo cuando la otra persona complete su acción.")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        } else {
                            Text("No hay transiciones disponibles desde el estado actual.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        ForEach(options, id: \.self) { opt in
                            Button {
                                target = opt
                            } label: {
                                HStack {
                                    Text(ApplicationStatus.label(for: opt))
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if target == opt {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(.green)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if target == "rechazado" || !reason.isEmpty {
                    Section("Motivo\(target == "rechazado" ? " (obligatorio)" : " (opcional)")") {
                        TextField("Escribe el motivo…", text: $reason, axis: .vertical)
                            .lineLimit(2...5)
                    }
                }
                if let err = errorMsg {
                    Section { Text(err).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Cambiar estado")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "…" : "Guardar") {
                        Task { await save() }
                    }
                    .disabled(target.isEmpty || saving || refreshing)
                }
            }
            .task {
                await refreshLive()
            }
        }
    }

    // Re-fetch the application detail so we never let the user pick a
    // transition against a stale local status (e.g. the client may have
    // just uploaded a receipt, moving the app to pago_enviado server-side).
    private func refreshLive() async {
        refreshing = true
        defer { refreshing = false }
        do {
            let fresh = try await api.fetchApplicationDetail(id: detail.id)
            if fresh.status != liveDetail.status {
                infoMsg = "El estado se actualizó a \(ApplicationStatus.label(for: fresh.status)) mientras tanto."
            }
            liveDetail = fresh
            // If the chosen target is no longer valid, clear it so the user
            // has to re-select an option that matches the current status.
            if !options.contains(target) { target = "" }
        } catch {
            // If refresh fails we silently keep the initial detail — the
            // user will still see a server-side error on submit if stale.
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        defer { saving = false }

        if target == "rechazado" && reason.trimmingCharacters(in: .whitespaces).isEmpty {
            errorMsg = "El motivo es obligatorio al rechazar."
            return
        }

        do {
            let updated = try await api.updateApplicationStatus(
                id: detail.id,
                newStatus: target,
                reason: reason
            )
            onChanged(updated)
            dismiss()
        } catch {
            if case .server(let s)? = error as? APIError {
                errorMsg = s
                // If the server rejected because the local state was stale,
                // refresh again so the user can pick valid options.
                if s.contains("Transición no válida") {
                    await refreshLive()
                }
            } else {
                errorMsg = "Error al cambiar el estado"
            }
        }
    }
}

// MARK: - Request Documents Sheet

struct RequestDocumentsSheet: View {
    let applicationId: String
    var onRequested: (ApplicationDetail) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var selected: Set<String> = []
    @State private var saving = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Los documentos marcados se solicitarán al cliente. Recibirá una tarea y podrá subirlos desde su app.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Documentos") {
                    ForEach(DocumentCatalog.types, id: \.key) { doc in
                        Button {
                            if selected.contains(doc.key) { selected.remove(doc.key) }
                            else { selected.insert(doc.key) }
                        } label: {
                            HStack {
                                Image(systemName: selected.contains(doc.key)
                                      ? "checkmark.square.fill"
                                      : "square")
                                    .foregroundStyle(selected.contains(doc.key) ? Color.rdBlue : .secondary)
                                Text(doc.label).foregroundStyle(.primary)
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let err = errorMsg {
                    Section { Text(err).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Solicitar documentos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "…" : "Solicitar") {
                        Task { await send() }
                    }
                    .disabled(selected.isEmpty || saving)
                }
            }
        }
    }

    private func send() async {
        saving = true
        errorMsg = nil
        defer { saving = false }
        let docs = selected.map { key -> (type: String, label: String, required: Bool) in
            (type: key, label: DocumentCatalog.label(for: key), required: true)
        }
        do {
            let updated = try await api.requestApplicationDocuments(id: applicationId, documents: docs)
            onRequested(updated)
            dismiss()
        } catch {
            if case .server(let s)? = error as? APIError { errorMsg = s }
            else { errorMsg = "Error al solicitar documentos" }
        }
    }
}

// MARK: - Contact Client Sheet

struct ContactClientSheet: View {
    let detail: ApplicationDetail

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var message: String = ""
    @State private var sending = false
    @State private var errorMsg: String?
    @State private var sent = false
    // #59: broker can flag the message as an internal team note.
    // Internal notes never sync to conversations or notify the client —
    // they show in the timeline only, with a lock icon.
    @State private var mode: MessageMode = .client

    enum MessageMode: String, CaseIterable, Identifiable {
        case client   = "Cliente"
        case internalNote = "Nota interna"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Destino", selection: $mode) {
                        Text("Mensaje al cliente").tag(MessageMode.client)
                        Text("Nota interna").tag(MessageMode.internalNote)
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    if mode == .internalNote {
                        Text("Las notas internas no se envían al cliente. Quedan visibles solo para el equipo en la línea de tiempo.")
                            .font(.caption2)
                    }
                }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(mode == .internalNote ? "Visible para el equipo" : "Para: \(detail.client.name)")
                            .font(.caption.bold())
                        if mode == .client, let email = detail.client.email {
                            Text(email).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                Section(mode == .internalNote ? "Nota" : "Mensaje") {
                    TextField(mode == .internalNote
                              ? "Anotación visible solo para el equipo…"
                              : "Hola, soy tu agente…",
                              text: $message, axis: .vertical)
                        .lineLimit(4...10)
                }
                if sent {
                    Section {
                        Label(mode == .internalNote ? "Nota guardada" : "Mensaje enviado",
                              systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    }
                } else if let err = errorMsg {
                    Section {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(mode == .internalNote ? "Nota interna" : "Contactar cliente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(sent ? "Cerrar" : "Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "…" : (mode == .internalNote ? "Guardar" : "Enviar")) {
                        Task { await send() }
                    }
                    .disabled(message.trimmingCharacters(in: .whitespaces).isEmpty || sending || sent)
                }
            }
        }
    }

    private func send() async {
        sending = true
        errorMsg = nil
        defer { sending = false }
        do {
            if mode == .internalNote {
                // #59: POST /api/applications/:id/message with is_internal=true
                // bypasses APIService.contactApplicationClient, which doesn't
                // expose the internal flag yet.
                guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(detail.id)/message") else {
                    throw APIError.server("URL inválida")
                }
                var req = try api.authedRequest(url, method: "POST")
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                let body: [String: Any] = [
                    "message":     message.trimmingCharacters(in: .whitespaces),
                    "is_internal": true,
                ]
                req.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, resp) = try await URLSession.shared.data(for: req)
                if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                    let serverMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                    throw APIError.server(serverMsg ?? "Error guardando nota (\(http.statusCode))")
                }
            } else {
                try await api.contactApplicationClient(
                    applicationId: detail.id,
                    message: message.trimmingCharacters(in: .whitespaces)
                )
            }
            sent = true
            try? await Task.sleep(for: .seconds(1.0))
            dismiss()
        } catch {
            if case .server(let s)? = error as? APIError { errorMsg = s }
            else { errorMsg = "Error al enviar el mensaje" }
        }
    }
}

// MARK: - Reassign Broker Sheet (#57)
//
// Same-team broker picker. Fetches GET /api/inmobiliaria/brokers
// (already used by InmobiliariaTeamListView), shows a single-selection
// list, and POSTs to /api/applications/:id/reassign with a reason. Server
// enforces same-inmobiliaria membership; the picker excludes the current
// user so brokers can't reassign to themselves.

struct ReassignBrokerSheet: View {
    let applicationId: String
    var onReassigned: () -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var loading = true
    @State private var loadError: String?
    @State private var brokers: [TeamBroker] = []
    @State private var selectedBrokerId: String?
    @State private var reason: String = ""
    @State private var submitting = false
    @State private var submitError: String?

    var body: some View {
        NavigationStack {
            Form {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let err = loadError {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Button("Reintentar") { Task { await loadBrokers() } }
                    }
                } else if brokers.isEmpty {
                    Section {
                        Text("No hay agentes disponibles para reasignar.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("Nuevo agente") {
                        Picker("Agente", selection: Binding(
                            get: { selectedBrokerId ?? "" },
                            set: { selectedBrokerId = $0.isEmpty ? nil : $0 }
                        )) {
                            Text("Selecciona un agente").tag("")
                            ForEach(brokers) { b in
                                Text(b.name).tag(b.id)
                            }
                        }
                        .pickerStyle(.navigationLink)
                    }
                    Section {
                        TextField("Motivo de la reasignación", text: $reason, axis: .vertical)
                            .lineLimit(2...5)
                    } header: {
                        Text("Motivo")
                    } footer: {
                        Text("Quedará registrado en la línea de tiempo de la aplicación.")
                            .font(.caption2)
                    }
                    if let err = submitError {
                        Section {
                            Label(err, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .navigationTitle("Reasignar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitting ? "…" : "Reasignar") {
                        Task { await submit() }
                    }
                    .disabled(selectedBrokerId == nil || submitting)
                }
            }
        }
        .task { await loadBrokers() }
    }

    private func loadBrokers() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let resp = try await api.getTeamBrokers()
            // Don't include the current user as a reassign target.
            let me = api.currentUser?.id
            brokers = resp.brokers.filter { $0.id != me }
        } catch {
            if case .server(let s)? = error as? APIError { loadError = s }
            else { loadError = "Error cargando equipo" }
        }
    }

    private func submit() async {
        guard let target = selectedBrokerId else { return }
        submitting = true
        submitError = nil
        defer { submitting = false }
        do {
            guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(applicationId)/reassign") else {
                throw APIError.server("URL inválida")
            }
            var req = try api.authedRequest(url, method: "POST")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = [
                "newBrokerUserId": target,
                "reason":          reason.trimmingCharacters(in: .whitespacesAndNewlines),
            ]
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                let serverMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                throw APIError.server(serverMsg ?? "Error al reasignar (\(http.statusCode))")
            }
            onReassigned()
            dismiss()
        } catch {
            if case .server(let s)? = error as? APIError { submitError = s }
            else { submitError = "Error al reasignar" }
        }
    }
}

// MARK: - Skip-phase Sheet (#60)
//
// Mirrors the broker.html skip-phase modal: pick a target status from
// the current STATUS_FLOW, write a reason, POST /:id/skip-phase. The
// dictionary below MUST mirror the server's STATUS_FLOW (routes/applications.js
// top-of-file). When the server adds a transition, update both at once.

struct SkipPhaseSheet: View {
    let detail: ApplicationDetail
    var onSkipped: (ApplicationDetail) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var target: String = ""
    @State private var reason: String = ""
    @State private var submitting = false
    @State private var errorMsg: String?

    /// MUST mirror STATUS_FLOW in routes/applications.js. Used to drive
    /// the picker; the server is the source of truth and will reject any
    /// mismatched transition with a clear error.
    private static let STATUS_FLOW: [String: [String]] = [
        "aplicado":                ["en_revision", "rechazado"],
        "en_revision":             ["documentos_requeridos", "en_aprobacion", "rechazado"],
        "documentos_requeridos":   ["documentos_enviados", "rechazado"],
        "documentos_enviados":     ["en_aprobacion", "documentos_insuficientes", "rechazado"],
        "documentos_insuficientes":["documentos_requeridos", "documentos_enviados", "rechazado"],
        "en_aprobacion":           ["reservado", "aprobado", "rechazado"],
        "reservado":               ["aprobado", "rechazado"],
        "aprobado":                ["pendiente_pago", "rechazado"],
        "pendiente_pago":          ["pago_enviado", "rechazado"],
        "pago_enviado":            ["pago_aprobado", "pendiente_pago", "rechazado"],
        "pago_aprobado":           ["completado"],
        "completado":              [],
        "rechazado":               ["aplicado"],
    ]

    private var options: [String] {
        Self.STATUS_FLOW[detail.status] ?? []
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Estado actual") {
                    Text(ApplicationStatus.label(for: detail.status))
                }
                Section("Saltar a") {
                    if options.isEmpty {
                        Text("No hay transiciones disponibles desde este estado.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(options, id: \.self) { opt in
                            Button {
                                target = opt
                            } label: {
                                HStack {
                                    Text(ApplicationStatus.label(for: opt))
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if target == opt {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(.green)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Section {
                    TextField("Explica por qué saltas la fase…", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("Motivo (obligatorio)")
                } footer: {
                    Text("Mínimo 5 caracteres. Quedará registrado en el historial.")
                        .font(.caption2)
                }
                if let err = errorMsg {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Saltar fase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitting ? "…" : "Confirmar") {
                        Task { await submit() }
                    }
                    .disabled(target.isEmpty
                              || reason.trimmingCharacters(in: .whitespaces).count < 5
                              || submitting)
                }
            }
        }
    }

    private func submit() async {
        submitting = true
        errorMsg = nil
        defer { submitting = false }
        do {
            guard let url = URL(string: "\(APIService.baseURL)/api/applications/\(detail.id)/skip-phase") else {
                throw APIError.server("URL inválida")
            }
            var req = try api.authedRequest(url, method: "POST")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = [
                "status": target,
                "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines),
            ]
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                let serverMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                throw APIError.server(serverMsg ?? "Error al saltar fase (\(http.statusCode))")
            }
            // Re-fetch full detail so the parent gets fresh state.
            let updated = try await api.fetchApplicationDetail(id: detail.id)
            onSkipped(updated)
            dismiss()
        } catch {
            if case .server(let s)? = error as? APIError { errorMsg = s }
            else { errorMsg = "Error al saltar fase" }
        }
    }
}
