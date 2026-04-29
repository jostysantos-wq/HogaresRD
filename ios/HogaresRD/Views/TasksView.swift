import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// MARK: - Tasks list

struct TasksView: View {
    @EnvironmentObject var api: APIService

    @State private var tasks: [TaskItem] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var filter = 1 // Start on Pendientes: 0=Todas, 1=Pendientes, 2=En Progreso, 3=Por Revisar, 4=Completadas
    @State private var showCreate = false
    @State private var selectedTask: TaskItem? = nil

    private var currentUserId: String { api.currentUser?.id ?? "" }

    private static let finishedStatuses: Set<String> = ["completada", "no_aplica"]

    private var filteredTasks: [TaskItem] {
        switch filter {
        case 1:  return tasks.filter { $0.status == "pendiente" }
        case 2:  return tasks.filter { $0.status == "en_progreso" }
        case 3:  return tasks.filter { $0.status == "pending_review" }
        case 4:  return tasks.filter { $0.status == "completada" }
        case 5:  return tasks.filter { $0.isOverdue }
        case 6:  return tasks.filter { $0.status == "no_aplica" }
        default: return tasks
        }
    }

    private var activeTasks: [TaskItem] {
        filteredTasks.filter { !Self.finishedStatuses.contains($0.status) }
    }

    private var completedTasks: [TaskItem] {
        filteredTasks.filter { Self.finishedStatuses.contains($0.status) }
    }

    private var canCreate: Bool {
        api.currentUser?.isTeamLead == true
    }

    // Stats
    private var statTotal: Int { tasks.count }
    private var statPending: Int { tasks.filter { $0.status == "pendiente" }.count }
    private var statProgress: Int { tasks.filter { $0.status == "en_progreso" }.count }
    private var statReview: Int { tasks.filter { $0.status == "pending_review" && $0.approverId == currentUserId }.count }
    private var statDone: Int { tasks.filter { $0.status == "completada" }.count }
    private var statOverdue: Int { tasks.filter { $0.isOverdue }.count }
    private var statNA: Int { tasks.filter { $0.status == "no_aplica" }.count }

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg, tasks.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 40)).foregroundStyle(.secondary)
                    Text(err).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Reintentar") { Task { await load() } }
                        .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                }
                .padding()
            } else {
                VStack(spacing: 0) {
                    // Stats bar
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            statPill("Total", value: statTotal, color: .rdBlue)
                            statPill("Pendientes", value: statPending, color: .orange)
                            statPill("En Progreso", value: statProgress, color: .rdBlue)
                            if statReview > 0 {
                                statPill("Por Revisar", value: statReview, color: .purple)
                            }
                            statPill("Completadas", value: statDone, color: .rdGreen)
                            statPill("Vencidas", value: statOverdue, color: .rdRed)
                            if statNA > 0 {
                                statPill("No Aplica", value: statNA, color: .gray)
                            }
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 10)
                    }

                    // Swipeable filter tabs
                    HStack(spacing: 0) {
                        ForEach([
                            (0, "Todas"), (1, "Pendientes"), (2, "En Progreso"),
                            (3, "Por Revisar"), (4, "Completadas"),
                        ], id: \.0) { tag, label in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) { filter = tag }
                            } label: {
                                VStack(spacing: 6) {
                                    Text(label)
                                        .font(.caption.bold())
                                        .foregroundStyle(filter == tag ? Color.rdBlue : .secondary)
                                    Rectangle()
                                        .fill(filter == tag ? Color.rdBlue : .clear)
                                        .frame(height: 2.5)
                                        .clipShape(Capsule())
                                }
                            }
                            .buttonStyle(.plain)
                            .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.horizontal, 4)

                    // Swipeable content
                    TabView(selection: $filter) {
                        taskListPage(tasks).tag(0)
                        taskListPage(tasks.filter { $0.status == "pendiente" }).tag(1)
                        taskListPage(tasks.filter { $0.status == "en_progreso" }).tag(2)
                        taskListPage(tasks.filter { $0.status == "pending_review" }).tag(3)
                        taskListPage(tasks.filter { Self.finishedStatuses.contains($0.status) }).tag(4)
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .animation(.easeInOut(duration: 0.2), value: filter)
                }
            }
        }
        .navigationTitle("Tareas")
        .toolbar {
            if canCreate {
                ToolbarItem(placement: .primaryAction) {
                    Button { showCreate = true } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.title3).foregroundStyle(Color.rdBlue)
                    }
                }
            }
        }
        .sheet(isPresented: $showCreate) {
            CreateTaskSheet(onCreated: { _ in Task { await load() } }).environmentObject(api)
        }
        .sheet(item: $selectedTask) { task in
            NavigationStack {
                TaskDetailSheet(task: task, onComplete: { Task { await load() } }).environmentObject(api)
            }
        }
        .task { await load() }
    }

    // MARK: - Task List Page (for each swipeable tab)

    @ViewBuilder
    private func taskListPage(_ items: [TaskItem]) -> some View {
        if items.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "checklist")
                    .font(.system(size: 48))
                    .foregroundStyle(Color(.tertiaryLabel))
                Text("No hay tareas")
                    .font(.subheadline).foregroundStyle(.secondary)
                Spacer()
            }
        } else {
            let active = items.filter { !Self.finishedStatuses.contains($0.status) }
            let done = items.filter { Self.finishedStatuses.contains($0.status) }
            List {
                if !active.isEmpty {
                    Section("Activas (\(active.count))") {
                        ForEach(active) { task in
                            Button { selectedTask = task } label: {
                                TaskRow(task: task, currentUserId: currentUserId)
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .leading) {
                                if task.assignedTo == currentUserId
                                    && (task.status == "pendiente" || task.status == "en_progreso") {
                                    Button {
                                        Task { await completeTask(task) }
                                    } label: {
                                        Label(task.requiresApproval ? "Enviar" : "Completar",
                                              systemImage: "checkmark.circle.fill")
                                    }
                                    .tint(Color.rdGreen)
                                }
                            }
                            .swipeActions(edge: .trailing) {
                                if task.assignedTo == currentUserId
                                    && task.status != "completada"
                                    && task.status != "no_aplica" {
                                    Button {
                                        Task { await markTaskNA(task) }
                                    } label: {
                                        Label("No Aplica", systemImage: "minus.circle")
                                    }
                                    .tint(.gray)
                                }
                            }
                        }
                    }
                }
                if !done.isEmpty {
                    Section("Finalizadas (\(done.count))") {
                        ForEach(done) { task in
                            Button { selectedTask = task } label: {
                                TaskRow(task: task, currentUserId: currentUserId)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Subviews

    private func statPill(_ label: String, value: Int, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.title3).bold()
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 60)
        .padding(.vertical, 8).padding(.horizontal, 6)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Actions

    private func load() async {
        if tasks.isEmpty { loading = true }
        errorMsg = nil
        do {
            tasks = try await api.listTasks()
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func completeTask(_ task: TaskItem) async {
        do {
            _ = try await api.completeTask(id: task.id)
            await load()
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func markTaskNA(_ task: TaskItem) async {
        do {
            _ = try await api.markTaskNotApplicable(id: task.id)
            await load()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Task Row

struct TaskRow: View {
    let task: TaskItem
    var currentUserId: String = ""

    private var priorityColor: Color {
        switch task.priority {
        case "alta": return Color.rdRed
        case "baja": return Color.rdGreen
        default:     return .orange
        }
    }

    private var statusColor: Color {
        switch task.status {
        case "en_progreso":    return Color.rdBlue
        case "pending_review": return .purple
        case "completada":     return Color.rdGreen
        case "no_aplica":      return .gray
        default:               return .orange
        }
    }

    /// True when the current user is the approver AND the task is
    /// waiting for their review. Used to show a "ACTION NEEDED" banner.
    private var needsMyReview: Bool {
        task.status == "pending_review" &&
        (task.approverId ?? "") == currentUserId &&
        task.assignedTo != currentUserId
    }

    private var dueDateFormatted: String? {
        guard let due = task.dueDate else { return nil }
        let isoFmt = ISO8601DateFormatter()
        isoFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallback = ISO8601DateFormatter()
        guard let date = isoFmt.date(from: due) ?? fallback.date(from: due) else { return nil }
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .none
        fmt.locale = Locale(identifier: "es_DO")
        return fmt.string(from: date)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(priorityColor)
                .frame(width: 8, height: 8)
                .padding(.top, 6)

            // Listing thumbnail (when the task is tied to a listing).
            // Falls back to a placeholder icon when the listing has no
            // image or when the task isn't related to a listing.
            if let imgUrl = task.listingImage, let url = URL(string: imgUrl) {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().aspectRatio(contentMode: .fill)
                    case .failure:
                        ZStack {
                            Rectangle().fill(Color(.tertiarySystemFill))
                            Image(systemName: "photo")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    default:
                        Rectangle().fill(Color(.tertiarySystemFill))
                    }
                }
                .frame(width: 46, height: 46)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(task.title)
                    .font(.subheadline).bold()
                    .strikethrough(task.status == "completada" || task.status == "no_aplica")
                    .foregroundStyle(task.status == "completada" || task.status == "no_aplica" ? .secondary : .primary)
                    .lineLimit(2)

                // Listing title (when enriched) — helps the user spot
                // which property a task belongs to without opening it.
                if let lt = task.listingTitle, !lt.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "house.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                        Text(lt)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if let desc = task.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                // Rejection banner when the task was sent back for revision
                if task.wasRejected, let note = task.reviewNotes, !note.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "arrow.uturn.left.circle.fill")
                            .foregroundStyle(.red)
                        Text("Devuelta: \(note)")
                            .font(.caption2)
                            .foregroundStyle(.red)
                            .lineLimit(2)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .background(Color.red.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                HStack(spacing: 6) {
                    // Status badge
                    Text(task.statusLabel)
                        .font(.caption2).bold()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())

                    // "Tu revisión" chip for the approver
                    if needsMyReview {
                        Label("REVISAR", systemImage: "eye.fill")
                            .font(.system(size: 9, weight: .heavy))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.purple)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }

                    // Priority badge
                    Text(task.priorityLabel)
                        .font(.caption2).bold()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(priorityColor.opacity(0.15))
                        .foregroundStyle(priorityColor)
                        .clipShape(Capsule())

                    if task.source == "auto" {
                        Text("Auto")
                            .font(.caption2).bold()
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.indigo.opacity(0.15))
                            .foregroundStyle(.indigo)
                            .clipShape(Capsule())
                    }

                    Spacer()

                    if task.isOverdue {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.rdRed)
                    }

                    if let dueStr = dueDateFormatted {
                        Text(dueStr)
                            .font(.caption2)
                            .foregroundStyle(task.isOverdue ? Color.rdRed : .secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .opacity(task.status == "completada" || task.status == "no_aplica" ? 0.6 : 1)
    }
}

// MARK: - Task Detail Sheet (with upload capability)

struct TaskDetailSheet: View {
    let task: TaskItem
    var onComplete: () -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    @State private var showPicker = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var uploading = false
    @State private var completing = false
    @State private var uploadSuccess = false
    @State private var errorMsg: String?
    @State private var showRejectSheet = false
    @State private var rejectNote = ""
    @State private var reviewing = false
    @State private var showReassignSheet = false
    @State private var showNASheet = false
    @State private var naNote = ""
    @State private var markingNA = false
    @State private var paymentAmount = ""
    @State private var showFileImporter = false

    // The current user, for action-gating
    private var currentUserId: String { api.currentUser?.id ?? "" }
    private var isAssignee: Bool { task.assignedTo == currentUserId }
    private var isApprover: Bool { (task.approverId ?? "") == currentUserId && !isAssignee }
    private var canReview: Bool { isApprover && task.status == "pending_review" }

    /// Does this task require a file upload?
    private var needsUpload: Bool {
        guard task.status != "completada" else { return false }
        let uploadEvents = ["documents_requested", "documents_rejected", "payment_plan_created", "payment_uploaded"]
        return task.applicationId != nil && uploadEvents.contains(task.sourceEvent ?? "")
    }

    /// Is this a payment-related task? (client or broker side)
    private var isPaymentTask: Bool {
        ["payment_plan_created", "payment_uploaded"].contains(task.sourceEvent ?? "")
    }

    /// Is this a broker-side payment verification task?
    private var isBrokerPaymentTask: Bool {
        task.sourceEvent == "payment_uploaded"
    }

    private var uploadLabel: String {
        if isBrokerPaymentTask { return "Subir recibo procesado" }
        if isPaymentTask { return "Subir comprobante de pago" }
        return "Subir documento"
    }

    private var uploadIcon: String {
        if isPaymentTask { return "creditcard.fill" }
        return "doc.badge.arrow.up.fill"
    }

    private var taskIcon: String {
        switch task.sourceEvent {
        case "documents_requested", "documents_rejected": return "doc.text.fill"
        case "payment_plan_created": return "creditcard.fill"
        case "payment_uploaded": return "checkmark.seal.fill"
        case "receipt_ready": return "doc.badge.checkmark"
        case "tour_scheduled": return "calendar.badge.clock"
        default: return "checklist"
        }
    }

    private var taskColor: Color {
        switch task.sourceEvent {
        case "documents_requested", "documents_rejected": return .orange
        case "payment_plan_created": return Color.rdBlue
        case "payment_uploaded": return Color.rdGreen
        case "receipt_ready": return Color.rdGreen
        default: return Color.rdBlue
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    // Icon header
                    VStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(taskColor.opacity(0.12))
                                .frame(width: 72, height: 72)
                            Image(systemName: taskIcon)
                                .font(.system(size: 30))
                                .foregroundStyle(taskColor)
                        }

                        Text(task.title)
                            .font(.title3.bold())
                            .multilineTextAlignment(.center)

                        // Status + priority
                        HStack(spacing: 8) {
                            Text(task.statusLabel)
                                .font(.caption.bold())
                                .foregroundStyle(task.status == "completada" ? Color.rdGreen : task.status == "en_progreso" ? Color.rdBlue : .orange)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background((task.status == "completada" ? Color.rdGreen : task.status == "en_progreso" ? Color.rdBlue : Color.orange).opacity(0.1))
                                .clipShape(Capsule())

                            Text(task.priorityLabel)
                                .font(.caption.bold())
                                .foregroundStyle(task.priority == "alta" ? Color.rdRed : task.priority == "baja" ? Color.rdGreen : .orange)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background((task.priority == "alta" ? Color.rdRed : task.priority == "baja" ? Color.rdGreen : Color.orange).opacity(0.1))
                                .clipShape(Capsule())

                            if task.isOverdue {
                                Label("Vencida", systemImage: "exclamationmark.triangle.fill")
                                    .font(.caption.bold())
                                    .foregroundStyle(Color.rdRed)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(Color.rdRed.opacity(0.1))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    .padding(.top, 8)

                    // Listing preview card — shown for tasks tied to a
                    // listing (which is almost always the case for
                    // auto-generated tasks like "upload cedula" or
                    // "sube el comprobante").
                    if let lt = task.listingTitle, !lt.isEmpty {
                        HStack(spacing: 12) {
                            if let imgUrl = task.listingImage, let url = URL(string: imgUrl) {
                                CachedAsyncImage(url: url) { phase in
                                    switch phase {
                                    case .success(let img):
                                        img.resizable().aspectRatio(contentMode: .fill)
                                    default:
                                        Rectangle().fill(Color(.tertiarySystemFill))
                                    }
                                }
                                .frame(width: 72, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            } else {
                                ZStack {
                                    Rectangle().fill(Color(.tertiarySystemFill))
                                    Image(systemName: "house.fill")
                                        .foregroundStyle(.secondary)
                                }
                                .frame(width: 72, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Propiedad relacionada")
                                    .font(.caption2).bold()
                                    .foregroundStyle(.secondary)
                                    .textCase(.uppercase)
                                Text(lt)
                                    .font(.subheadline.bold())
                                    .lineLimit(2)
                                if let city = task.listingCity {
                                    Text(city)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                        }
                        .padding(12)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Rejection banner — shown when an approver sent this
                    // task back for revision. Persistent until the task is
                    // re-submitted (and the server clears review_notes).
                    if task.wasRejected, let note = task.reviewNotes, !note.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.uturn.left.circle.fill")
                                    .foregroundStyle(.red)
                                Text("Devuelta para revisión")
                                    .font(.caption.bold())
                                    .foregroundStyle(.red)
                            }
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(.primary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color.red.opacity(0.08))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.red.opacity(0.3), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Pending-review banner — shown when the current user
                    // has submitted this task and is waiting for approval.
                    if task.status == "pending_review" && isAssignee {
                        HStack(spacing: 8) {
                            Image(systemName: "hourglass")
                                .foregroundStyle(.purple)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Esperando aprobación")
                                    .font(.caption.bold())
                                    .foregroundStyle(.purple)
                                Text("Enviada para revisión · el aprobador recibirá una notificación")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding(12)
                        .background(Color.purple.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Description
                    if let desc = task.description, !desc.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Descripcion")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                            Text(desc)
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(14)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Details
                    VStack(spacing: 10) {
                        if let due = task.dueDate {
                            detailRow(icon: "calendar", label: "Vence", value: formatDate(due))
                        }
                        if task.source == "auto" {
                            detailRow(icon: "gear", label: "Origen", value: "Generada automaticamente")
                        }
                        if let created = task.createdAt {
                            detailRow(icon: "clock", label: "Creada", value: formatDate(created))
                        }
                    }
                    .padding(14)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                    // Upload section (for document/payment tasks)
                    if needsUpload {
                        VStack(spacing: 14) {
                            Divider()

                            Image(systemName: uploadIcon)
                                .font(.system(size: 32))
                                .foregroundStyle(taskColor)

                            Text(isBrokerPaymentTask
                                 ? "Sube el recibo procesado del pago"
                                 : isPaymentTask ? "Sube tu comprobante de pago" : "Sube los documentos solicitados")
                                .font(.subheadline.bold())
                                .multilineTextAlignment(.center)

                            Text(isBrokerPaymentTask
                                 ? "Sube el recibo oficial procesado para el cliente."
                                 : isPaymentTask
                                   ? "Toma una foto o selecciona el comprobante de tu galeria."
                                   : "Toma una foto de tu documento o selecciona de tu galeria. Formatos: JPG, PNG, PDF.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)

                            // Amount input for client payment tasks
                            if isPaymentTask && !isBrokerPaymentTask {
                                TextField("Monto del pago (ej: 150000)", text: $paymentAmount)
                                    .keyboardType(.decimalPad)
                                    .textFieldStyle(.roundedBorder)
                            }

                            if uploadSuccess {
                                Label("Documento subido correctamente", systemImage: "checkmark.circle.fill")
                                    .font(.subheadline.bold())
                                    .foregroundStyle(Color.rdGreen)
                            } else {
                                let amountText = paymentAmount.trimmingCharacters(in: .whitespaces)
                                let needsAmount = isPaymentTask && !isBrokerPaymentTask && (amountText.isEmpty || Double(amountText.replacingOccurrences(of: ",", with: ".")) == nil)
                                Button { showPicker = true } label: {
                                    HStack {
                                        if uploading {
                                            ProgressView().tint(.white)
                                        } else {
                                            Image(systemName: "camera.fill")
                                        }
                                        Text(uploading ? "Subiendo..." : "Foto desde galería")
                                            .font(.subheadline.bold())
                                    }
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(needsAmount ? Color.gray : taskColor, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(uploading || needsAmount)

                                Button { showFileImporter = true } label: {
                                    HStack {
                                        Image(systemName: "doc.fill")
                                        Text("Seleccionar PDF")
                                            .font(.subheadline.bold())
                                    }
                                    .foregroundStyle(needsAmount ? .gray : taskColor)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(needsAmount ? Color.gray : taskColor, lineWidth: 1.5))
                                }
                                .buttonStyle(.plain)
                                .disabled(uploading || needsAmount)

                                if needsAmount {
                                    Text("Ingresa el monto del pago para continuar")
                                        .font(.caption2)
                                        .foregroundStyle(.orange)
                                }
                            }
                        }
                        .padding(16)
                        .background(taskColor.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }

                    if let err = errorMsg {
                        Label(err, systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                    }

                    // ── Approver actions (separation of duties) ──
                    // Only rendered when the current user is the approver
                    // AND the task is sitting in pending_review. The
                    // assignee cannot approve their own work.
                    if canReview {
                        VStack(spacing: 10) {
                            HStack(spacing: 8) {
                                Image(systemName: "person.badge.shield.checkmark.fill")
                                    .foregroundStyle(.purple)
                                Text("Acción requerida · Tú eres el aprobador")
                                    .font(.caption.bold())
                                    .foregroundStyle(.purple)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)

                            HStack(spacing: 10) {
                                Button {
                                    Task { await approve() }
                                } label: {
                                    HStack {
                                        if reviewing { ProgressView().tint(.white) }
                                        Image(systemName: "checkmark.circle.fill")
                                        Text("Aprobar")
                                    }
                                    .font(.subheadline.bold())
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 13)
                                    .background(Color.rdGreen)
                                    .foregroundStyle(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(reviewing)

                                Button {
                                    showRejectSheet = true
                                } label: {
                                    HStack {
                                        Image(systemName: "arrow.uturn.left.circle.fill")
                                        Text("Enviar para revisión")
                                    }
                                    .font(.subheadline.bold())
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 13)
                                    .background(Color.red.opacity(0.12))
                                    .foregroundStyle(.red)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(reviewing)
                            }

                            Button {
                                showReassignSheet = true
                            } label: {
                                HStack {
                                    Image(systemName: "person.2.arrow.trianglehead.counterclockwise")
                                    Text("Reasignar revisor")
                                }
                                .font(.caption.bold())
                                .padding(.vertical, 10).padding(.horizontal, 14)
                                .foregroundStyle(Color.rdBlue)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(14)
                        .background(Color.purple.opacity(0.06))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.purple.opacity(0.2), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // ── Assignee "Submit" button ──
                    // Text changes based on whether the task requires
                    // approval: "Marcar completada" (direct) vs "Enviar
                    // para aprobación" (routes through the review loop).
                    // Hidden when the task is already waiting for review,
                    // completed, or the user isn't the assignee.
                    if isAssignee
                        && task.status != "completada"
                        && task.status != "pending_review"
                        && (!needsUpload || uploadSuccess) {
                        Button {
                            Task { await markComplete() }
                        } label: {
                            HStack {
                                if completing { ProgressView().tint(.white) }
                                Image(systemName: task.requiresApproval
                                      ? "paperplane.fill"
                                      : "checkmark.circle.fill")
                                Text(task.requiresApproval
                                     ? "Enviar para aprobación"
                                     : "Marcar como completada")
                                    .font(.subheadline.bold())
                            }
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(task.requiresApproval ? Color.rdBlue : Color.rdGreen,
                                        in: RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(completing)

                        if task.requiresApproval {
                            Text("Esta tarea requiere aprobación del creador antes de marcarse como completada.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                    }

                    // ── "No Aplica" button ──
                    // Shown for assignee or approver when the task is still
                    // active — lets them dismiss tasks that aren't relevant.
                    if (isAssignee || isApprover)
                        && task.status != "completada"
                        && task.status != "no_aplica" {
                        Button { showNASheet = true } label: {
                            HStack {
                                Image(systemName: "minus.circle")
                                Text("No Aplica")
                                    .font(.subheadline.bold())
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color(.secondarySystemFill),
                                        in: RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .navigationTitle("Detalle de Tarea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .photosPicker(isPresented: $showPicker, selection: $selectedPhotos, maxSelectionCount: 5, matching: .any(of: [.images]))
            .onChange(of: selectedPhotos) {
                guard let item = selectedPhotos.first else { return }
                Task { await handleUpload(item: item) }
                selectedPhotos = []
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf, .jpeg, .png]) { result in
                switch result {
                case .success(let url):
                    guard url.startAccessingSecurityScopedResource() else {
                        errorMsg = "No se pudo acceder al archivo. Intenta de nuevo."
                        return
                    }
                    defer { url.stopAccessingSecurityScopedResource() }
                    guard let data = try? Data(contentsOf: url) else {
                        errorMsg = "No se pudo leer el archivo."
                        return
                    }
                    guard let appId = task.applicationId else {
                        errorMsg = "Esta tarea no tiene una aplicación asociada."
                        return
                    }
                    let filename = url.lastPathComponent
                    Task { await handleFileUpload(data: data, filename: filename, appId: appId) }
                case .failure(let error):
                    errorMsg = error.localizedDescription
                }
            }
            .sheet(isPresented: $showRejectSheet) {
                RejectTaskSheet(
                    taskTitle: task.title,
                    note: $rejectNote,
                    submitting: reviewing,
                    onSubmit: { Task { await reject() } }
                )
            }
            .sheet(isPresented: $showReassignSheet) {
                ReassignApproverSheet(task: task, onReassigned: {
                    showReassignSheet = false
                    onComplete()
                    dismiss()
                })
                .environmentObject(api)
            }
            .sheet(isPresented: $showNASheet) {
                NavigationStack {
                    Form {
                        Section {
                            Text("¿Estás seguro de que esta tarea no aplica a tu situación?")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Section("Motivo (opcional)") {
                            TextField("Explica por qué no aplica...", text: $naNote, axis: .vertical)
                                .lineLimit(3...6)
                        }
                        Section {
                            Button {
                                Task { await markNotApplicable() }
                            } label: {
                                HStack {
                                    if markingNA { ProgressView() }
                                    Text("Confirmar — No Aplica")
                                        .font(.subheadline.bold())
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .disabled(markingNA)
                        }
                    }
                    .navigationTitle("No Aplica")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancelar") { showNASheet = false }
                        }
                    }
                }
                .presentationDetents([.medium])
            }
        }
    }

    // MARK: - Helpers

    private func detailRow(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            Text(label)
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.caption)
        }
    }

    private func formatDate(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: iso)
        if date == nil { fmt.formatOptions = [.withInternetDateTime]; date = fmt.date(from: iso) }
        guard let d = date else { return iso }
        let df = DateFormatter()
        df.locale = Locale(identifier: "es_DO")
        df.dateFormat = "d MMM yyyy"
        return df.string(from: d)
    }

    // MARK: - Actions

    private func handleUpload(item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            errorMsg = "No se pudo cargar la imagen seleccionada."
            return
        }
        guard let appId = task.applicationId else {
            errorMsg = "Esta tarea no tiene una aplicación asociada."
            return
        }
        let filename = "upload_\(Date().timeIntervalSince1970).jpg"
        await handleFileUpload(data: data, filename: filename, appId: appId)
    }

    private func handleFileUpload(data: Data, filename: String, appId: String) async {
        uploading = true
        errorMsg = nil
        do {
            if isBrokerPaymentTask {
                try await api.uploadProcessedReceipt(
                    applicationId: appId, fileData: data, filename: filename
                )
            } else if isPaymentTask {
                try await api.uploadPaymentReceipt(
                    applicationId: appId, amount: paymentAmount, notes: task.title,
                    fileData: data, filename: filename
                )
            } else {
                try await api.uploadDocument(
                    applicationId: appId, requestId: nil,
                    type: "other", fileData: data, filename: filename
                )
            }
            withAnimation { uploadSuccess = true }
        } catch {
            errorMsg = error.localizedDescription
        }
        uploading = false
    }

    private func markComplete() async {
        completing = true
        errorMsg = nil
        do {
            _ = try await api.completeTask(id: task.id)
            onComplete()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        completing = false
    }

    private func approve() async {
        reviewing = true
        errorMsg = nil
        do {
            _ = try await api.approveTask(id: task.id)
            onComplete()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        reviewing = false
    }

    private func markNotApplicable() async {
        markingNA = true
        errorMsg = nil
        do {
            _ = try await api.markTaskNotApplicable(id: task.id, note: naNote)
            showNASheet = false
            onComplete()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        markingNA = false
    }

    private func reject() async {
        let note = rejectNote.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty else {
            errorMsg = "El motivo es obligatorio"
            return
        }
        reviewing = true
        errorMsg = nil
        do {
            _ = try await api.rejectTask(id: task.id, note: note)
            showRejectSheet = false
            onComplete()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        reviewing = false
    }
}

// MARK: - Team member for picker

struct TeamMember: Identifiable, Decodable {
    let id: String
    let name: String
    let email: String?
}

struct TeamBrokersResponse: Decodable {
    let brokers: [TeamMember]
}

// MARK: - Create Task Sheet

struct CreateTaskSheet: View {
    var onCreated: (TaskItem) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var title = ""
    @State private var desc = ""
    @State private var priority = "media"
    @State private var hasDueDate = false
    @State private var dueDate = Calendar.current.date(byAdding: .day, value: 7, to: Date()) ?? Date()
    @State private var assignedTo = "" // "" = self
    @State private var teamMembers: [TeamMember] = []
    @State private var saving = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Tarea") {
                    TextField("Título de la tarea", text: $title)
                    TextEditor(text: $desc)
                        .frame(minHeight: 80)
                        .overlay(alignment: .topLeading) {
                            if desc.isEmpty {
                                Text("Descripción (opcional)")
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8)
                                    .padding(.leading, 4)
                                    .allowsHitTesting(false)
                            }
                        }
                }

                Section("Prioridad") {
                    Picker("Prioridad", selection: $priority) {
                        Text("Alta").tag("alta")
                        Text("Media").tag("media")
                        Text("Baja").tag("baja")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Fecha límite") {
                    Toggle("Establecer fecha límite", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Vence", selection: $dueDate, displayedComponents: .date)
                    }
                }

                Section {
                    Picker("Asignar a", selection: $assignedTo) {
                        Text("Yo mismo").tag("")
                        ForEach(teamMembers) { member in
                            Text("\(member.name)\(member.email.map { " (\($0))" } ?? "")")
                                .tag(member.id)
                        }
                    }
                } header: {
                    Text("Asignar a")
                } footer: {
                    if assignedTo.isEmpty {
                        Text("La tarea comenzará como Pendiente.")
                    } else {
                        Text("La tarea se asignará como En Progreso automáticamente.")
                    }
                }

                if let err = errorMsg {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Nueva tarea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Guardando…" : "Crear") {
                        Task { await save() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .presentationDetents([.large])
            .task { await loadTeam() }
        }
    }

    private func loadTeam() async {
        guard api.currentUser?.isTeamLead == true else { return }
        guard let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers") else { return }
        guard let req = try? api.authedRequest(url) else { return }
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return }
        if let resp = try? JSONDecoder().decode(TeamBrokersResponse.self, from: data) {
            teamMembers = resp.brokers
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        let dueDateStr: String? = hasDueDate ? ISO8601DateFormatter().string(from: dueDate) : nil
        let assignee: String? = assignedTo.isEmpty ? nil : assignedTo
        do {
            let task = try await api.createTask(
                title: title.trimmingCharacters(in: .whitespaces),
                description: desc.trimmingCharacters(in: .whitespaces),
                priority: priority,
                dueDate: dueDateStr,
                assignedTo: assignee
            )
            onCreated(task)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        saving = false
    }
}

// MARK: - Reject Task Sheet
//
// Presented when the approver clicks "Enviar para revisión". Requires a
// reason note — the server enforces non-empty body text. The sheet is a
// lightweight form with a big textarea, common quick-select phrases, and
// the destructive red "Enviar" primary action.

struct RejectTaskSheet: View {
    let taskTitle: String
    @Binding var note: String
    let submitting: Bool
    let onSubmit: () -> Void

    @Environment(\.dismiss) var dismiss

    private let quickReasons = [
        "Documentos faltantes",
        "Archivos ilegibles o borrosos",
        "Información incompleta",
        "Fecha o monto incorrecto",
        "No corresponde a lo solicitado",
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // Context
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Enviar para revisión")
                            .font(.title3.bold())
                        Text(taskTitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    // Quick-select chips
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Motivos comunes")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        FlowLayout(spacing: 8) {
                            ForEach(quickReasons, id: \.self) { reason in
                                Button {
                                    note = note.isEmpty ? reason : "\(note)\n\(reason)"
                                } label: {
                                    Text(reason)
                                        .font(.caption.bold())
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(Color(.tertiarySystemGroupedBackground))
                                        .foregroundStyle(.primary)
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    // Note field
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Motivo del rechazo")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                        TextEditor(text: $note)
                            .frame(minHeight: 140)
                            .padding(10)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(Color(.separator), lineWidth: 0.5)
                            )
                        Text("El asignado recibirá este mensaje y podrá corregir la tarea.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        onSubmit()
                    } label: {
                        HStack {
                            if submitting { ProgressView().tint(.white) }
                            Image(systemName: "paperplane.fill")
                            Text("Enviar para revisión")
                        }
                        .font(.subheadline.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.red)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(submitting || note.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(20)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Enviar para Revisión")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Reassign Approver Sheet
//
// The current approver can delegate review rights to another team member
// (e.g. a secretary). The server enforces that the new approver isn't the
// same person as the assignee.

struct ReassignApproverSheet: View {
    let task: TaskItem
    var onReassigned: () -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var teamMembers: [TeamMember] = []
    @State private var selectedId: String = ""
    @State private var saving = false
    @State private var errorMsg: String?

    private var eligible: [TeamMember] {
        teamMembers.filter { $0.id != task.assignedTo && $0.id != (api.currentUser?.id ?? "") }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Reasigna esta tarea a otra persona para que la revise y apruebe. El asignado no puede ser el aprobador.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Equipo") {
                    if eligible.isEmpty {
                        Text("No hay otros miembros disponibles.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(eligible) { member in
                            Button {
                                selectedId = member.id
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(member.name)
                                            .foregroundStyle(.primary)
                                        if let e = member.email {
                                            Text(e)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if selectedId == member.id {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(Color.rdBlue)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let e = errorMsg {
                    Section { Text(e).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Reasignar Revisor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "…" : "Reasignar") {
                        Task { await reassign() }
                    }
                    .disabled(selectedId.isEmpty || saving)
                }
            }
            .task { await loadTeam() }
        }
    }

    private func loadTeam() async {
        do {
            let resp = try await api.getTeamBrokers()
            teamMembers = resp.brokers.map { TeamMember(id: $0.id, name: $0.name, email: $0.email.isEmpty ? nil : $0.email) }
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func reassign() async {
        saving = true
        errorMsg = nil
        do {
            _ = try await api.reassignTaskApprover(id: task.id, newApproverId: selectedId)
            onReassigned()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        saving = false
    }
}

// FlowLayout is already defined in ListingDetailView.swift
