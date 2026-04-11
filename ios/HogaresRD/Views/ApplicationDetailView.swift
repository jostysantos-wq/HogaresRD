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
                        withAnimation(.easeInOut(duration: 0.15)) { selectedTab = tab }
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
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "doc.fill")
                        .foregroundStyle(Color.rdBlue)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(up.original_name ?? up.label ?? DocumentCatalog.label(for: up.type ?? ""))
                            .font(.subheadline.bold())
                            .lineLimit(1)
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
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
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
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(timelineEventColor(ev.type))
                        .frame(width: 10, height: 10)
                        .padding(.top, 6)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(ev.description ?? ev.type.capitalized)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                        HStack(spacing: 6) {
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
                .background(Color(.secondarySystemGroupedBackground))
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

            let commissionStatuses = ["aprobado", "pendiente_pago", "pago_enviado", "pago_aprobado", "completado"]
            if commissionStatuses.contains(d.status) {
                Button {
                    showCommissionSheet = true
                } label: {
                    Label("Registrar / Revisar comisión", systemImage: "dollarsign.circle.fill")
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
        loading = true
        errorMsg = nil
        do {
            detail = try await api.fetchApplicationDetail(id: id)
            lastStateVersion = nil  // reset the poll baseline
        } catch {
            if case .server(let s)? = error as? APIError { errorMsg = s }
            else { errorMsg = "No se pudo cargar la aplicación" }
        }
        loading = false
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

    private func formatCurrencyD(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "$\(Int(value))"
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

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Para: \(detail.client.name)").font(.caption.bold())
                        if let email = detail.client.email { Text(email).font(.caption2).foregroundStyle(.secondary) }
                    }
                }
                Section("Mensaje") {
                    TextField("Hola, soy tu agente…", text: $message, axis: .vertical)
                        .lineLimit(4...10)
                }
                if sent {
                    Section {
                        Label("Mensaje enviado", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    }
                } else if let err = errorMsg {
                    Section {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Contactar cliente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(sent ? "Cerrar" : "Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "…" : "Enviar") {
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
            try await api.contactApplicationClient(
                applicationId: detail.id,
                message: message.trimmingCharacters(in: .whitespaces)
            )
            sent = true
            try? await Task.sleep(for: .seconds(1.0))
            dismiss()
        } catch {
            if case .server(let s)? = error as? APIError { errorMsg = s }
            else { errorMsg = "Error al enviar el mensaje" }
        }
    }
}
