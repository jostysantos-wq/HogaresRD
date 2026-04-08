import SwiftUI

// MARK: - Inmobiliaria Dashboard (extends Broker Dashboard with Team tabs)

struct InmobiliariaDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var selectedTab = 0

    /// Tabs visible based on user's effective access level
    private var tabs: [String] {
        let level = api.currentUser?.effectiveAccessLevel ?? 1
        var t = ["Aplicaciones"]
        if level >= 2 { t.append(contentsOf: ["Analíticas", "Ventas", "Contabilidad"]) }
        t.append("Archivo")
        if level >= 3 { t.append("Auditoría") }
        t.append("Mis Propiedades")
        if level >= 2 { t.append(contentsOf: ["Agentes", "Rendimiento"]) }
        if level >= 3 { t.append(contentsOf: ["Solicitudes", "Secretarias"]) }
        return t
    }

    /// Role-aware title — "Constructora" for constructora users,
    /// "Inmobiliaria" for inmobiliaria users, plain "Dashboard" otherwise.
    /// Both roles use the SAME view with IDENTICAL tabs/data.
    private var navTitle: String {
        if api.currentUser?.isConstructora == true { return "Dashboard · Constructora" }
        if api.currentUser?.role == "inmobiliaria"  { return "Dashboard · Inmobiliaria" }
        return "Dashboard"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(tabs.enumerated()), id: \.offset) { i, title in
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { selectedTab = i }
                        } label: {
                            HStack(spacing: 4) {
                                if i >= 7 {
                                    Image(systemName: i == 7 ? "person.2.fill" : i == 8 ? "person.badge.plus" : i == 9 ? "chart.bar.fill" : "person.crop.circle.badge.checkmark")
                                        .font(.system(size: 10))
                                }
                                Text(title)
                            }
                            .font(.caption).bold()
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(selectedTab == i ? (i >= 7 ? Color(red: 0.55, green: 0.27, blue: 0.68) : Color.rdBlue) : Color(.secondarySystemFill))
                            .foregroundStyle(selectedTab == i ? .white : .primary)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
            }
            .background(Color(.systemBackground))

            Divider()

            // Content
            TabView(selection: $selectedTab) {
                // Reuse broker dashboard tabs
                DashboardApplicationsTab().tag(0)
                DashboardAnalyticsTab().tag(1)
                DashboardSalesTab().tag(2)
                DashboardAccountingTab().tag(3)
                DashboardArchiveTab().tag(4)
                DashboardAuditTab().tag(5)
                DashboardListingAnalyticsTab().tag(6)
                // Inmobiliaria-only team tabs
                TeamMembersTab().tag(7)
                TeamRequestsTab().tag(8)
                TeamPerformanceTab().tag(9)
                TeamSecretariesTab().tag(10)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .environmentObject(api)
        }
        .navigationTitle(navTitle)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    NavigationLink {
                        ChatIAView().environmentObject(api)
                    } label: {
                        Label("Chat IA", systemImage: "brain.head.profile.fill")
                    }
                    NavigationLink {
                        ConversationsView().environmentObject(api)
                    } label: {
                        Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                    NavigationLink {
                        DashboardSettingsView().environmentObject(api)
                    } label: {
                        Label("Configuración", systemImage: "gearshape.fill")
                    }
                    NavigationLink {
                        SubmitListingView()
                    } label: {
                        Label("Publicar propiedad", systemImage: "plus.circle.fill")
                    }
                    Link(destination: URL(string: "https://hogaresrd.com/broker")!) {
                        Label("Abrir en web", systemImage: "safari.fill")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 7: Agentes Afiliados (Team Members)
// ────────────────────────────────────────────────────────────────────

struct TeamMembersTab: View {
    @EnvironmentObject var api: APIService
    @State private var team: TeamResponse?
    @State private var loading = true
    @State private var searchText = ""
    @State private var selectedBroker: TeamBroker?
    @State private var copiedLink = false
    @State private var brokerToRemove: TeamBroker?
    @State private var showRemoveAlert = false
    @State private var removingId: String?
    @State private var removeSuccess: String?

    private let purpleColor = Color(red: 0.55, green: 0.27, blue: 0.68)

    private var filteredBrokers: [TeamBroker] {
        guard let brokers = team?.brokers else { return [] }
        if searchText.isEmpty { return brokers }
        let q = searchText.lowercased()
        return brokers.filter {
            $0.name.lowercased().contains(q) || $0.email.lowercased().contains(q)
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Stats
                if let t = team {
                    HStack(spacing: 10) {
                        TeamStatCard(label: "Total Agentes", value: "\(t.brokers.count)", color: purpleColor)
                        TeamStatCard(label: "Apps Totales", value: "\(t.brokers.reduce(0) { $0 + $1.appCount })", color: .blue)
                        TeamStatCard(label: "Solicitudes", value: "\(t.pendingRequests.filter { $0.status == "pending" }.count)", color: .orange)
                    }
                    .padding(.horizontal)
                }

                // Success banner
                if let msg = removeSuccess {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text(msg)
                            .font(.caption).bold()
                        Spacer()
                    }
                    .padding(12)
                    .background(Color.green.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                // Affiliate link
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Enlace de afiliación")
                            .font(.caption).bold()
                            .foregroundStyle(purpleColor)
                        Text("Comparte este enlace con agentes para que soliciten unirse a tu equipo")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        UIPasteboard.general.string = "https://hogaresrd.com/register-agency"
                        copiedLink = true
                        let impact = UIImpactFeedbackGenerator(style: .light)
                        impact.impactOccurred()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copiedLink = false }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: copiedLink ? "checkmark" : "doc.on.doc")
                                .font(.caption2)
                            Text(copiedLink ? "Copiado" : "Copiar")
                                .font(.caption).bold()
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(purpleColor)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
                .padding(14)
                .background(purpleColor.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(purpleColor.opacity(0.15), style: StrokeStyle(lineWidth: 1, dash: [6])))
                .padding(.horizontal)

                // Search
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Buscar agente por nombre o correo...", text: $searchText)
                        .font(.subheadline)
                }
                .padding(10)
                .background(Color(.secondarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)

                // Broker grid
                if loading {
                    ProgressView().padding(.top, 40)
                } else if filteredBrokers.isEmpty {
                    emptyTeamState(icon: "person.2.slash", title: "Sin agentes", subtitle: "Los agentes afiliados a tu inmobiliaria aparecerán aquí.")
                } else {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(filteredBrokers) { broker in
                            BrokerCard(
                                broker: broker,
                                isRemoving: removingId == broker.id,
                                onTap: {
                                    selectedBroker = broker
                                },
                                onRemove: {
                                    brokerToRemove = broker
                                    showRemoveAlert = true
                                }
                            )
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .task { await load(initial: true) }
        .refreshable { await load(initial: false) }
        .sheet(item: $selectedBroker) { broker in
            BrokerDetailSheet(broker: broker, onRemove: {
                selectedBroker = nil
                Task { await load(initial: false) }
            })
            .environmentObject(api)
        }
        .alert("Desvincular Agente", isPresented: $showRemoveAlert) {
            Button("Cancelar", role: .cancel) { brokerToRemove = nil }
            Button("Desvincular", role: .destructive) {
                if let broker = brokerToRemove {
                    Task { await removeBroker(broker) }
                }
            }
        } message: {
            if let broker = brokerToRemove {
                Text("¿Estás seguro de que deseas desvincular a \(broker.name) de tu inmobiliaria? Esta acción no se puede deshacer. El agente podrá solicitar unirse nuevamente.")
            }
        }
    }

    private func load(initial: Bool = true) async {
        if initial { loading = true }
        if let result = try? await api.getTeamBrokers() {
            team = result
        }
        loading = false
    }

    private func removeBroker(_ broker: TeamBroker) async {
        removingId = broker.id
        do {
            try await api.removeBroker(brokerId: broker.id)
            // Remove from local state with animation
            withAnimation(.easeInOut(duration: 0.3)) {
                team?.brokers.removeAll { $0.id == broker.id }
                removeSuccess = "\(broker.name) ha sido desvinculado del equipo."
            }
            let impact = UINotificationFeedbackGenerator()
            impact.notificationOccurred(.success)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                withAnimation { removeSuccess = nil }
            }
        } catch {
            // Reload to get fresh state
            await load()
        }
        removingId = nil
        brokerToRemove = nil
    }
}

struct TeamStatCard: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(spacing: 6) {
            Text(value)
                .font(.title2).bold()
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct BrokerCard: View {
    let broker: TeamBroker
    var isRemoving: Bool = false
    let onTap: () -> Void
    var onRemove: (() -> Void)? = nil

    private let purpleColor = Color(red: 0.55, green: 0.27, blue: 0.68)

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    // Avatar
                    ZStack {
                        Circle()
                            .fill(purpleColor)
                            .frame(width: 38, height: 38)
                        Text(broker.initials)
                            .font(.caption).bold()
                            .foregroundStyle(.white)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(broker.name)
                                .font(.caption).bold()
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(broker.accessLabel)
                                .font(.system(size: 8, weight: .bold))
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .background(levelColor(broker.accessLevel).opacity(0.15))
                                .foregroundStyle(levelColor(broker.accessLevel))
                                .clipShape(Capsule())
                        }
                        let title = broker.displayTitle
                        if !title.isEmpty {
                            Text(title)
                                .font(.system(size: 10))
                                .foregroundStyle(purpleColor)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    // Remove button
                    if let onRemove {
                        Button {
                            onRemove()
                        } label: {
                            if isRemoving {
                                ProgressView()
                                    .scaleEffect(0.6)
                                    .frame(width: 24, height: 24)
                            } else {
                                Image(systemName: "person.badge.minus")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.red.opacity(0.7))
                                    .frame(width: 24, height: 24)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(isRemoving)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Label(broker.email, systemImage: "envelope")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let phone = broker.phone, !phone.isEmpty {
                        Label(phone, systemImage: "phone")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                    if let lic = broker.licenseNumber, !lic.isEmpty {
                        Label("Lic. \(lic)", systemImage: "creditcard")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }

                HStack {
                    Text("\(broker.appCount) app\(broker.appCount == 1 ? "" : "s")")
                        .font(.system(size: 10, weight: .bold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(purpleColor.opacity(0.1))
                        .foregroundStyle(purpleColor)
                        .clipShape(Capsule())
                    Spacer()
                    HStack(spacing: 3) {
                        Text("Ver detalles")
                            .font(.system(size: 10))
                            .foregroundStyle(purpleColor)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(purpleColor)
                    }
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .opacity(isRemoving ? 0.5 : 1)
            .animation(.easeInOut(duration: 0.2), value: isRemoving)
        }
        .buttonStyle(.plain)
    }
}

private func levelColor(_ level: Int) -> Color {
    switch level {
    case 1: return .gray
    case 2: return .orange
    case 3: return .purple
    default: return .gray
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Broker Detail Sheet
// ────────────────────────────────────────────────────────────────────

struct BrokerDetailSheet: View {
    let broker: TeamBroker
    var onRemove: () -> Void
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var detail: BrokerDetail?
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var notes = ""
    @State private var savingNotes = false
    @State private var notesSaved = false
    @State private var showRemoveAlert = false
    @State private var showResetAlert = false
    @State private var actionMessage: String?
    @State private var editAccessLevel: Int = 1
    @State private var editTeamTitle: String = ""
    @State private var savingRole = false
    @State private var roleSaved = false

    private let purpleColor = Color(red: 0.55, green: 0.27, blue: 0.68)

    var body: some View {
        NavigationStack {
            ScrollView {
                if loading {
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Cargando detalles...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 60)
                } else if let err = errorMsg {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text(err)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await loadDetail() } }
                            .buttonStyle(.borderedProminent)
                            .tint(purpleColor)
                    }
                    .padding(.top, 40)
                    .padding(.horizontal, 32)
                } else {
                    let d = detail ?? BrokerDetail.fallback(from: broker)
                    VStack(spacing: 20) {
                        // Header
                        HStack(spacing: 14) {
                            ZStack {
                                Circle()
                                    .fill(purpleColor)
                                    .frame(width: 56, height: 56)
                                Text(broker.initials)
                                    .font(.title3).bold()
                                    .foregroundStyle(.white)
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(d.name)
                                    .font(.title3).bold()
                                Text(d.email)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if let phone = d.phone, !phone.isEmpty {
                                    Text(phone)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                        }
                        .padding(.horizontal)

                        // Info grid
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            infoItem("Correo", value: d.email)
                            infoItem("Teléfono", value: d.phone ?? "—")
                            infoItem("Cargo", value: d.jobTitle ?? "—")
                            infoItem("Licencia", value: d.licenseNumber ?? "—")
                            infoItem("Tipo", value: d.role == "agency" ? "Agente Broker" : "Broker")
                            infoItem("Afiliado desde", value: formatDate(d.joinedAt))
                            infoItem("Email verificado", value: d.emailVerified == true ? "✅ Sí" : "⚠️ No")
                            infoItem("Aplicaciones", value: "\(d.appCount)")
                        }
                        .padding(.horizontal)

                        // Role assignment (level 3 only)
                        if api.currentUser?.canManageTeam == true {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Rol y Acceso")
                                    .font(.headline)
                                    .padding(.horizontal)

                                VStack(spacing: 12) {
                                    TextField("Titulo del cargo (ej: CMO, Gerente)", text: $editTeamTitle)
                                        .textFieldStyle(.roundedBorder)
                                        .font(.subheadline)

                                    VStack(alignment: .leading, spacing: 6) {
                                        Text("Nivel de acceso").font(.caption).foregroundStyle(.secondary)
                                        Picker("Nivel", selection: $editAccessLevel) {
                                            Text("1 - Asistente").tag(1)
                                            Text("2 - Gerente").tag(2)
                                            Text("3 - Director").tag(3)
                                        }
                                        .pickerStyle(.segmented)

                                        Text(editAccessLevel == 1 ? "Aplicaciones asignadas y propiedades propias" :
                                             editAccessLevel == 2 ? "Agentes, pagos, analiticas del equipo" :
                                             "Acceso completo: equipo, roles, facturacion")
                                            .font(.caption2).foregroundStyle(.tertiary)
                                    }

                                    HStack {
                                        if roleSaved {
                                            Label("Guardado", systemImage: "checkmark.circle.fill")
                                                .font(.caption).foregroundStyle(.green)
                                        }
                                        Spacer()
                                        Button {
                                            Task { await saveRole() }
                                        } label: {
                                            if savingRole {
                                                ProgressView().scaleEffect(0.7)
                                            } else {
                                                Text("Guardar Rol")
                                                    .font(.caption).bold()
                                            }
                                        }
                                        .padding(.horizontal, 16).padding(.vertical, 8)
                                        .background(Color.purple, in: RoundedRectangle(cornerRadius: 8))
                                        .foregroundStyle(.white)
                                        .disabled(savingRole)
                                    }
                                }
                                .padding(14)
                                .background(Color.purple.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.purple.opacity(0.15)))
                                .padding(.horizontal)
                            }
                        }

                        // Recent apps
                        if !d.recentApps.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Aplicaciones Recientes")
                                    .font(.headline)
                                    .padding(.horizontal)

                                ForEach(d.recentApps) { app in
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(app.title ?? "Propiedad")
                                                .font(.subheadline).bold()
                                                .lineLimit(1)
                                            if let client = app.clientName {
                                                Text(client)
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                        Spacer()
                                        if let s = app.status {
                                            StatusBadge(status: s)
                                        }
                                    }
                                    .padding(12)
                                    .background(Color(.secondarySystemGroupedBackground))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .padding(.horizontal)
                                }
                            }
                        }

                        // Notes
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Notas Internas")
                                .font(.headline)
                            Text("(solo visibles para tu inmobiliaria)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)

                            TextEditor(text: $notes)
                                .frame(minHeight: 80)
                                .padding(8)
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator), lineWidth: 0.5))

                            HStack {
                                if notesSaved {
                                    Label("Guardado", systemImage: "checkmark.circle.fill")
                                        .font(.caption).foregroundStyle(.green)
                                }
                                Spacer()
                                Button {
                                    Task { await saveNotes() }
                                } label: {
                                    if savingNotes {
                                        ProgressView().tint(.white)
                                    } else {
                                        Text("Guardar Notas")
                                    }
                                }
                                .font(.caption).bold()
                                .padding(.horizontal, 16).padding(.vertical, 8)
                                .background(purpleColor)
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                                .disabled(savingNotes)
                            }
                        }
                        .padding(.horizontal)

                        if let msg = actionMessage {
                            Text(msg)
                                .font(.caption)
                                .foregroundStyle(.green)
                                .padding(.horizontal)
                        }

                        // Action buttons
                        VStack(spacing: 10) {
                            Button {
                                showResetAlert = true
                            } label: {
                                HStack {
                                    Image(systemName: "lock.rotation")
                                    Text("Resetear Contraseña")
                                }
                                .font(.subheadline)
                                .frame(maxWidth: .infinity)
                                .padding(12)
                                .background(Color(.secondarySystemGroupedBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)

                            Button {
                                showRemoveAlert = true
                            } label: {
                                HStack {
                                    Image(systemName: "person.badge.minus")
                                    Text("Desvincular Agente")
                                }
                                .font(.subheadline).bold()
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity)
                                .padding(12)
                                .background(Color.red.opacity(0.08))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 30)
                    }
                    .padding(.top)
                }
            }
            .navigationTitle("Detalles del Agente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .alert("Desvincular Agente", isPresented: $showRemoveAlert) {
                Button("Cancelar", role: .cancel) {}
                Button("Desvincular", role: .destructive) {
                    Task { await removeBroker() }
                }
            } message: {
                Text("¿Estás seguro de que deseas desvincular a \(broker.name) de tu inmobiliaria? Podrá solicitar unirse nuevamente.")
            }
            .alert("Resetear Contraseña", isPresented: $showResetAlert) {
                Button("Cancelar", role: .cancel) {}
                Button("Enviar Reset") {
                    Task { await resetPassword() }
                }
            } message: {
                Text("Se enviará un enlace de restablecimiento de contraseña al correo de \(broker.name).")
            }
        }
        .task { await loadDetail() }
    }

    private func infoItem(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func formatDate(_ s: String?) -> String {
        guard let s else { return "—" }
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: s) else { return s }
        let df = DateFormatter()
        df.dateStyle = .medium
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: date)
    }

    private func loadDetail() async {
        loading = true
        errorMsg = nil
        do {
            detail = try await api.getBrokerDetail(brokerId: broker.id)
            notes = detail?.notes ?? ""
            editAccessLevel = detail?.accessLevel ?? broker.accessLevel
            editTeamTitle = detail?.teamTitle ?? broker.teamTitle ?? ""
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func saveNotes() async {
        savingNotes = true; notesSaved = false
        try? await api.saveBrokerNotes(brokerId: broker.id, notes: notes)
        savingNotes = false; notesSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { notesSaved = false }
    }

    private func saveRole() async {
        savingRole = true; roleSaved = false
        try? await api.updateTeamMemberRole(userId: broker.id, accessLevel: editAccessLevel, teamTitle: editTeamTitle)
        savingRole = false; roleSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { roleSaved = false }
    }

    private func resetPassword() async {
        try? await api.sendBrokerPasswordReset(brokerId: broker.id)
        actionMessage = "Enlace de reset enviado a \(broker.email)"
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { actionMessage = nil }
    }

    private func removeBroker() async {
        try? await api.removeBroker(brokerId: broker.id)
        dismiss()
        onRemove()
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 8: Solicitudes (Join Requests)
// ────────────────────────────────────────────────────────────────────

struct TeamRequestsTab: View {
    @EnvironmentObject var api: APIService
    @State private var requests: [JoinRequest] = []
    @State private var loading = true
    @State private var processingIds: Set<String> = []

    private var pending: [JoinRequest] {
        requests.filter { $0.status == "pending" }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Header
                VStack(alignment: .leading, spacing: 4) {
                    Text("Solicitudes de Afiliación")
                        .font(.headline)
                    Text("Revisa y aprueba solicitudes de agentes que quieren unirse a tu inmobiliaria")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)

                if loading {
                    ProgressView().padding(.top, 40)
                } else if pending.isEmpty {
                    emptyTeamState(icon: "person.badge.plus", title: "Sin solicitudes pendientes", subtitle: "Las solicitudes de afiliación de agentes aparecerán aquí.")
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(pending) { request in
                            JoinRequestCard(
                                request: request,
                                processing: processingIds.contains(request.brokerId),
                                onApprove: { await approve(request) },
                                onReject: { await reject(request) }
                            )
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .task { await load(initial: true) }
        .refreshable { await load(initial: false) }
    }

    private func load(initial: Bool = true) async {
        if initial { loading = true }
        if let team = try? await api.getTeamBrokers() {
            requests = team.pendingRequests
        }
        loading = false
    }

    private func approve(_ request: JoinRequest) async {
        processingIds.insert(request.brokerId)
        try? await api.approveBroker(brokerId: request.brokerId)
        requests.removeAll { $0.id == request.id }
        processingIds.remove(request.brokerId)
    }

    private func reject(_ request: JoinRequest) async {
        processingIds.insert(request.brokerId)
        try? await api.rejectBroker(brokerId: request.brokerId)
        requests.removeAll { $0.id == request.id }
        processingIds.remove(request.brokerId)
    }
}

struct JoinRequestCard: View {
    let request: JoinRequest
    let processing: Bool
    var onApprove: () async -> Void
    var onReject: () async -> Void

    var body: some View {
        HStack(spacing: 14) {
            // Orange left accent
            RoundedRectangle(cornerRadius: 2)
                .fill(Color.orange)
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 8) {
                Text(request.brokerName)
                    .font(.subheadline).bold()

                VStack(alignment: .leading, spacing: 3) {
                    Label(request.brokerEmail, systemImage: "envelope")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let lic = request.brokerLicense, !lic.isEmpty {
                        Label("Lic. \(lic)", systemImage: "creditcard")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let date = request.requestedAt {
                        Label("Solicitado: \(formatDate(date))", systemImage: "calendar")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                if processing {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                } else {
                    HStack(spacing: 8) {
                        Button {
                            Task { await onApprove() }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark")
                                Text("Aprobar")
                            }
                            .font(.caption).bold()
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Color.green)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)

                        Button {
                            Task { await onReject() }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "xmark")
                                Text("Rechazar")
                            }
                            .font(.caption).bold()
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Color.red)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)

                        Spacer()
                    }
                }
            }

            Spacer()
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func formatDate(_ s: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: s) else { return s }
        let rel = RelativeDateTimeFormatter()
        rel.locale = Locale(identifier: "es_DO")
        return rel.localizedString(for: date, relativeTo: Date())
    }
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 9: Rendimiento (Team Performance)
// ────────────────────────────────────────────────────────────────────

struct TeamPerformanceTab: View {
    @EnvironmentObject var api: APIService
    @State private var brokers: [TeamBroker] = []
    @State private var loading = true

    private let purpleColor = Color(red: 0.55, green: 0.27, blue: 0.68)

    private var ranked: [TeamBroker] {
        brokers.sorted { $0.appCount > $1.appCount }
    }

    private var maxApps: Int {
        brokers.map(\.appCount).max() ?? 1
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Header
                VStack(alignment: .leading, spacing: 4) {
                    Text("Rendimiento del Equipo")
                        .font(.headline)
                    Text("Ranking de actividad por agente basado en aplicaciones gestionadas")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)

                if loading {
                    ProgressView().padding(.top, 40)
                } else if ranked.isEmpty {
                    emptyTeamState(icon: "chart.bar.xaxis", title: "Sin agentes", subtitle: "No hay agentes afiliados aún.")
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(Array(ranked.enumerated()), id: \.element.id) { index, broker in
                            PerformanceRow(broker: broker, rank: index + 1, maxApps: maxApps, color: purpleColor)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .task { await load(initial: true) }
        .refreshable { await load(initial: false) }
    }

    private func load(initial: Bool = true) async {
        if initial { loading = true }
        if let team = try? await api.getTeamBrokers() {
            brokers = team.brokers
        }
        loading = false
    }
}

struct PerformanceRow: View {
    let broker: TeamBroker
    let rank: Int
    let maxApps: Int
    let color: Color

    private var medal: String? {
        switch rank {
        case 1: return "🥇"
        case 2: return "🥈"
        case 3: return "🥉"
        default: return nil
        }
    }

    var body: some View {
        HStack(spacing: 14) {
            // Rank
            if let medal {
                Text(medal)
                    .font(.title2)
                    .frame(width: 32)
            } else {
                Text("\(rank)")
                    .font(.subheadline).bold()
                    .foregroundStyle(.secondary)
                    .frame(width: 32)
            }

            // Avatar
            ZStack {
                Circle()
                    .fill(color)
                    .frame(width: 38, height: 38)
                Text(broker.initials)
                    .font(.caption).bold()
                    .foregroundStyle(.white)
            }

            // Info + bar
            VStack(alignment: .leading, spacing: 6) {
                Text(broker.name)
                    .font(.subheadline).bold()
                    .lineLimit(1)
                Text(broker.email)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                // Progress bar
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color(.secondarySystemFill))
                            .frame(height: 6)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(color)
                            .frame(width: maxApps > 0 ? geo.size.width * CGFloat(broker.appCount) / CGFloat(maxApps) : 0, height: 6)
                    }
                }
                .frame(height: 6)
            }

            // Count
            VStack(spacing: 2) {
                Text("\(broker.appCount)")
                    .font(.title3).bold()
                    .foregroundStyle(color)
                Text("apps")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Standalone Wrappers (for ProfileMenuView navigation)

struct InmobiliariaTeamListView: View {
    @EnvironmentObject var api: APIService
    var body: some View {
        TeamMembersTab()
            .environmentObject(api)
            .navigationTitle("Mis Agentes")
            .navigationBarTitleDisplayMode(.inline)
    }
}

struct InmobiliariaRequestsListView: View {
    @EnvironmentObject var api: APIService
    var body: some View {
        TeamRequestsTab()
            .environmentObject(api)
            .navigationTitle("Solicitudes")
            .navigationBarTitleDisplayMode(.inline)
    }
}

struct InmobiliariaPerformanceListView: View {
    @EnvironmentObject var api: APIService
    var body: some View {
        TeamPerformanceTab()
            .environmentObject(api)
            .navigationTitle("Rendimiento")
            .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Helper

private func emptyTeamState(icon: String, title: String, subtitle: String) -> some View {
    VStack(spacing: 14) {
        Image(systemName: icon)
            .font(.system(size: 44))
            .foregroundStyle(Color(.tertiaryLabel))
        Text(title)
            .font(.headline)
            .foregroundStyle(.secondary)
        Text(subtitle)
            .font(.caption)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 40)
}

// ────────────────────────────────────────────────────────────────────
// MARK: - Tab 10: Secretarias Management
// ────────────────────────────────────────────────────────────────────

struct TeamSecretariesTab: View {
    @EnvironmentObject var api: APIService
    @State private var secretaries: [APIService.SecretaryItem] = []
    @State private var loading = true
    @State private var inviteEmail = ""
    @State private var inviting = false
    @State private var successMsg: String?
    @State private var errorMsg: String?
    @State private var secToRemove: APIService.SecretaryItem?
    @State private var showRemoveAlert = false

    private let greenAccent = Color(red: 0.09, green: 0.63, blue: 0.21)

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Invite card
                VStack(alignment: .leading, spacing: 10) {
                    Text("INVITAR SECRETARIA")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .tracking(0.5)

                    HStack(spacing: 10) {
                        TextField("correo@ejemplo.com", text: $inviteEmail)
                            .font(.subheadline)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .autocapitalization(.none)
                            .padding(10)
                            .background(Color(.tertiarySystemFill))
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        Button {
                            Task { await invite() }
                        } label: {
                            HStack(spacing: 4) {
                                if inviting {
                                    ProgressView().tint(.white)
                                } else {
                                    Image(systemName: "paperplane.fill")
                                        .font(.caption)
                                }
                                Text("Invitar")
                                    .font(.caption).bold()
                            }
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .background(greenAccent)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .disabled(inviting || inviteEmail.isEmpty)
                    }

                    Text("Se enviará un correo con un enlace de registro. La secretaria podrá gestionar aplicaciones y pagos, pero no tendrá acceso a ventas, contabilidad ni gestión de equipo.")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .padding(16)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal)

                // Messages
                if let msg = successMsg {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        Text(msg).font(.caption).bold()
                        Spacer()
                    }
                    .padding(12)
                    .background(Color.green.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                if let msg = errorMsg {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
                        Text(msg).font(.caption).bold()
                        Spacer()
                    }
                    .padding(12)
                    .background(Color.red.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                // List
                if loading {
                    ProgressView().padding(.top, 40)
                } else if secretaries.isEmpty {
                    emptyTeamState(
                        icon: "person.crop.circle.badge.plus",
                        title: "Sin secretarias",
                        subtitle: "Invita secretarias para que gestionen aplicaciones y pagos de tu inmobiliaria."
                    )
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("SECRETARIAS ACTIVAS (\(secretaries.count))")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.secondary)
                            .tracking(0.5)
                            .padding(.horizontal)

                        ForEach(secretaries) { sec in
                            SecretaryCard(secretary: sec, onRemove: {
                                secToRemove = sec
                                showRemoveAlert = true
                            })
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .background(Color(.systemGroupedBackground))
        .task { await load(initial: true) }
        .refreshable { await load(initial: false) }
        .alert("Remover Secretaria", isPresented: $showRemoveAlert) {
            Button("Cancelar", role: .cancel) { secToRemove = nil }
            Button("Remover", role: .destructive) {
                if let sec = secToRemove {
                    Task { await remove(sec) }
                }
            }
        } message: {
            if let sec = secToRemove {
                Text("¿Estás seguro de remover a \(sec.name)? Ya no tendrá acceso al panel de la inmobiliaria.")
            }
        }
    }

    private func load(initial: Bool = true) async {
        if initial { loading = true }
        secretaries = (try? await api.getSecretaries()) ?? []
        loading = false
    }

    private func invite() async {
        inviting = true
        errorMsg = nil
        successMsg = nil
        do {
            try await api.inviteSecretary(email: inviteEmail)
            withAnimation {
                successMsg = "Invitación enviada a \(inviteEmail)"
            }
            inviteEmail = ""
            let impact = UINotificationFeedbackGenerator()
            impact.notificationOccurred(.success)
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                withAnimation { successMsg = nil }
            }
        } catch {
            withAnimation {
                errorMsg = error.localizedDescription
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                withAnimation { errorMsg = nil }
            }
        }
        inviting = false
    }

    private func remove(_ sec: APIService.SecretaryItem) async {
        do {
            try await api.removeSecretary(id: sec.id)
            withAnimation {
                secretaries.removeAll { $0.id == sec.id }
                successMsg = "\(sec.name) ha sido removida."
            }
            let impact = UINotificationFeedbackGenerator()
            impact.notificationOccurred(.success)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                withAnimation { successMsg = nil }
            }
        } catch {
            withAnimation {
                errorMsg = error.localizedDescription
            }
        }
        secToRemove = nil
    }
}

struct SecretaryCard: View {
    let secretary: APIService.SecretaryItem
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            let initials = secretary.name.split(separator: " ").prefix(2).map { String($0.prefix(1)) }.joined().uppercased()
            ZStack {
                Circle()
                    .fill(Color(red: 0.09, green: 0.63, blue: 0.21))
                    .frame(width: 40, height: 40)
                Text(initials)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(secretary.name)
                    .font(.subheadline).bold()
                Text(secretary.email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let phone = secretary.phone, !phone.isEmpty {
                    Text(phone)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            Button(role: .destructive) {
                onRemove()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.red.opacity(0.6))
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}
