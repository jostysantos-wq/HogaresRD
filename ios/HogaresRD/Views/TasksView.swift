import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// MARK: - Tasks list
//
// Dashboard-style layout:
//   • Top stat grid (2×2) — high-priority / overdue / upcoming / pending,
//     each card tappable to filter the list below
//   • Donut "progress" card — completed vs in-progress vs not-started
//   • Filter chip row + grouped task list with swipe actions
//
// The stat tiles act as filter shortcuts: tapping one scrolls to the list
// and applies the matching filter, so the dashboard doubles as navigation.

struct TasksView: View {
    @EnvironmentObject var api: APIService

    @State private var tasks: [TaskItem] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var filter: TaskFilter = .pendientes
    @State private var showCreate = false
    @State private var selectedTask: TaskItem? = nil

    enum TaskFilter: String, CaseIterable, Identifiable {
        case todas        = "Todas"
        case pendientes   = "Pendientes"
        case enProgreso   = "En Progreso"
        case porRevisar   = "Por Revisar"
        case completadas  = "Completadas"
        case vencidas     = "Vencidas"
        var id: String { rawValue }
    }

    private var currentUserId: String { api.currentUser?.id ?? "" }

    private static let finishedStatuses: Set<String> = ["completada", "no_aplica"]

    /// Tasks with a due date in the next 7 days that aren't finished.
    private var upcomingTasks: [TaskItem] {
        let now = Date()
        let weekOut = now.addingTimeInterval(7 * 86400)
        return tasks.filter { task in
            guard !Self.finishedStatuses.contains(task.status),
                  let due = parseISO(task.dueDate) else { return false }
            return due > now && due <= weekOut
        }
    }

    private var filteredTasks: [TaskItem] {
        switch filter {
        case .todas:        return tasks
        case .pendientes:   return tasks.filter { $0.status == "pendiente" }
        case .enProgreso:   return tasks.filter { $0.status == "en_progreso" }
        case .porRevisar:   return tasks.filter { $0.status == "pending_review" }
        case .completadas:  return tasks.filter { Self.finishedStatuses.contains($0.status) }
        case .vencidas:     return tasks.filter { $0.isOverdue }
        }
    }

    private var canCreate: Bool {
        api.currentUser?.isTeamLead == true
    }

    // Headline stats
    private var statTotal: Int { tasks.count }
    private var statHighPriority: Int {
        tasks.filter { $0.priority == "alta" && !Self.finishedStatuses.contains($0.status) }.count
    }
    private var statOverdue: Int  { tasks.filter { $0.isOverdue }.count }
    private var statUpcoming: Int { upcomingTasks.count }
    private var statPending: Int  { tasks.filter { $0.status == "pendiente" }.count }
    private var statProgress: Int { tasks.filter { $0.status == "en_progreso" }.count }
    private var statReview: Int   { tasks.filter { $0.status == "pending_review" }.count }
    private var statDone: Int     { tasks.filter { $0.status == "completada" }.count }
    private var statNotStarted: Int { statPending }

    var body: some View {
        Group {
            if loading && tasks.isEmpty {
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
                List {
                    Section {
                        statsGrid
                            .padding(.bottom, 4)
                        progressCard
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 8, trailing: 16))
                    .listRowSeparator(.hidden)

                    Section {
                        filterChips
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)

                    let active = filteredTasks.filter { !Self.finishedStatuses.contains($0.status) }
                    let done   = filteredTasks.filter {  Self.finishedStatuses.contains($0.status) }

                    if !active.isEmpty {
                        Section {
                            ForEach(active) { task in
                                taskCardRow(task)
                            }
                        } header: {
                            taskSectionHeader(filter == .completadas ? "Tareas" : "Próximos vencimientos",
                                              count: active.count)
                        }
                    }

                    if !done.isEmpty {
                        Section {
                            ForEach(done) { task in
                                taskCardRow(task)
                            }
                        } header: {
                            taskSectionHeader("Finalizadas", count: done.count)
                        }
                    }

                    if active.isEmpty && done.isEmpty {
                        Section {
                            VStack(spacing: 12) {
                                Image(systemName: "checklist")
                                    .font(.system(size: 44))
                                    .foregroundStyle(Color(.tertiaryLabel))
                                Text("No hay tareas en esta vista")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 36)
                        }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(Color(.systemGroupedBackground))
                .refreshable { await load() }
            }
        }
        .navigationTitle("Tareas")
        .toolbar {
            if canCreate {
                ToolbarItem(placement: .primaryAction) {
                    Button { showCreate = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                                .font(.caption.bold())
                            Text("Nueva")
                                .font(.subheadline.bold())
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Color.rdBlue, in: Capsule())
                        .foregroundStyle(.white)
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

    // MARK: - Stats grid (2 × 2)

    private var statsGrid: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                statTile(
                    icon: "flag.fill",
                    iconColor: Color.rdRed,
                    title: "Prioridad",
                    value: statHighPriority,
                    total: statTotal,
                    onTap: { filter = .todas }
                )
                statTile(
                    icon: "exclamationmark.triangle.fill",
                    iconColor: .orange,
                    title: "Vencidas",
                    value: statOverdue,
                    total: statTotal,
                    onTap: { filter = .vencidas }
                )
            }
            HStack(spacing: 10) {
                statTile(
                    icon: "calendar.badge.clock",
                    iconColor: Color.rdBlue,
                    title: "Próximas",
                    value: statUpcoming,
                    total: statTotal,
                    onTap: { filter = .todas }
                )
                statTile(
                    icon: "clock.fill",
                    iconColor: .purple,
                    title: "Pendientes",
                    value: statPending,
                    total: statTotal,
                    onTap: { filter = .pendientes }
                )
            }
        }
    }

    private func statTile(icon: String,
                          iconColor: Color,
                          title: String,
                          value: Int,
                          total: Int,
                          onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(iconColor.opacity(0.13))
                            .frame(width: 30, height: 30)
                        Image(systemName: icon)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(iconColor)
                    }
                    Text(title)
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    Text("\(value)")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(.primary)
                    if total > 0 {
                        Text("/\(total)")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Progress donut card

    private var progressCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Progreso de tareas")
                        .font(.subheadline.bold())
                    Text("Distribución por estado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Menu {
                    Button("Ver completadas") { filter = .completadas }
                    Button("Ver en progreso") { filter = .enProgreso }
                    Button("Ver pendientes")  { filter = .pendientes }
                    if statReview > 0 {
                        Button("Ver por revisar") { filter = .porRevisar }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .background(Color(.tertiarySystemFill), in: Circle())
                }
            }

            HStack(spacing: 18) {
                ZStack {
                    DonutChart(
                        segments: [
                            .init(value: statDone,        color: Color.rdGreen),
                            .init(value: statProgress,    color: Color.rdBlue),
                            .init(value: statNotStarted,  color: .orange),
                        ],
                        lineWidth: 18
                    )
                    .frame(width: 112, height: 112)

                    VStack(spacing: 0) {
                        Text("\(statTotal)")
                            .font(.title3.bold())
                        Text("Total")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    legendRow(color: Color.rdGreen, label: "Completadas", value: statDone)
                    legendRow(color: Color.rdBlue,  label: "En progreso", value: statProgress)
                    legendRow(color: .orange,       label: "Pendientes",  value: statNotStarted)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func legendRow(color: Color, label: String, value: Int) -> some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(label)
                .font(.caption)
                .foregroundStyle(.primary)
            Spacer()
            Text("\(value)")
                .font(.caption.bold())
                .foregroundStyle(.primary)
        }
    }

    // MARK: - Filter chips

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TaskFilter.allCases) { f in
                    let count = filterCount(for: f)
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { filter = f }
                    } label: {
                        HStack(spacing: 6) {
                            Text(f.rawValue)
                                .font(.caption.bold())
                            if count > 0 {
                                Text("\(count)")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 6).padding(.vertical, 1)
                                    .background(filter == f ? Color.white.opacity(0.25) : Color(.tertiarySystemFill))
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(filter == f ? Color.rdBlue : Color(.secondarySystemGroupedBackground))
                        .foregroundStyle(filter == f ? Color.white : Color.primary)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func filterCount(for f: TaskFilter) -> Int {
        switch f {
        case .todas:        return tasks.count
        case .pendientes:   return statPending
        case .enProgreso:   return statProgress
        case .porRevisar:   return statReview
        case .completadas:  return tasks.filter { Self.finishedStatuses.contains($0.status) }.count
        case .vencidas:     return statOverdue
        }
    }

    // MARK: - Task row card

    private func taskSectionHeader(_ title: String, count: Int) -> some View {
        HStack {
            Text(title)
                .font(.subheadline.bold())
                .foregroundStyle(.primary)
            Text("(\(count))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .textCase(nil)
        .padding(.top, 8)
    }

    @ViewBuilder
    private func taskCardRow(_ task: TaskItem) -> some View {
        Button { selectedTask = task } label: {
            TaskRow(task: task, currentUserId: currentUserId)
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
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

    // MARK: - Helpers

    private func parseISO(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
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

// MARK: - Donut chart
//
// Lightweight ring chart drawn with Canvas so we don't pull in the
// Charts framework just for one screen. Empty state (all-zero)
// renders a faint outline instead of nothing, so the card never
// looks broken on a fresh account.

struct DonutChart: View {
    struct Segment: Identifiable {
        let id = UUID()
        let value: Int
        let color: Color
    }

    let segments: [Segment]
    var lineWidth: CGFloat = 16

    private var total: Double {
        Double(segments.reduce(0) { $0 + $1.value })
    }

    var body: some View {
        Canvas { ctx, size in
            let radius = min(size.width, size.height) / 2 - lineWidth / 2
            let center = CGPoint(x: size.width / 2, y: size.height / 2)

            // Empty state — faint background ring
            if total <= 0 {
                let path = Path { p in
                    p.addArc(center: center,
                             radius: radius,
                             startAngle: .degrees(0),
                             endAngle:   .degrees(360),
                             clockwise: false)
                }
                ctx.stroke(path,
                           with: .color(Color.gray.opacity(0.15)),
                           style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                return
            }

            // Start at 12 o'clock and go clockwise.
            var start = -CGFloat.pi / 2
            for seg in segments where seg.value > 0 {
                let sweep = CGFloat(Double(seg.value) / total) * 2 * .pi
                let path = Path { p in
                    p.addArc(center: center,
                             radius: radius,
                             startAngle: .radians(Double(start)),
                             endAngle:   .radians(Double(start + sweep)),
                             clockwise: false)
                }
                ctx.stroke(path,
                           with: .color(seg.color),
                           style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                start += sweep
            }
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
    @State private var task: TaskItem
    var onComplete: () -> Void

    init(task: TaskItem, onComplete: @escaping () -> Void) {
        // Seed from the list-view payload; the .task modifier below
        // immediately refetches via GET /api/tasks/:id so the banners
        // can rely on subtask_progress + unfulfilled_dependencies +
        // recurrence (none of which the list endpoint returns).
        self._task = State(initialValue: task)
        self.onComplete = onComplete
    }

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
    @State private var showFileImporter = false
    @State private var showRecurrenceSheet = false

    // The current user, for action-gating
    private var currentUserId: String { api.currentUser?.id ?? "" }
    private var isAssignee: Bool { task.assignedTo == currentUserId }
    private var isApprover: Bool { (task.approverId ?? "") == currentUserId && !isAssignee }
    private var canReview: Bool { isApprover && task.status == "pending_review" }
    /// Only the creator can change recurrence (server enforces this).
    private var canEditRecurrence: Bool { task.assignedBy == currentUserId }

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

                    // ── Detail-only banners ────────────────────────
                    // These three live above the action buttons so the
                    // user sees blockers and recurrence cadence before
                    // deciding to Complete / Submit / Approve.
                    blockingDependenciesBanner
                    subtaskProgressBanner
                    recurrenceSummaryBanner

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

                    // Collaboration: comments + attachments. Mirrors the
                    // web's task-sheet "Actividad" + "Archivos" tabs.
                    NavigationLink {
                        TaskCollabView(task: task).environmentObject(api)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(Color.rdBlue)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Comentarios y archivos")
                                    .font(.subheadline).bold()
                                    .foregroundStyle(.primary)
                                Text("Conversación, documentos y soporte de esta tarea")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(14)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)

                    // Recurrence — creator only. Mirrors the web's
                    // "Repite" dropdown on the task sheet.
                    if canEditRecurrence {
                        Button {
                            showRecurrenceSheet = true
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "arrow.clockwise.circle.fill")
                                    .font(.system(size: 18))
                                    .foregroundStyle(.purple)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Recurrencia")
                                        .font(.subheadline).bold()
                                        .foregroundStyle(.primary)
                                    Text("Repetir esta tarea automáticamente")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(14)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                    }

                    // Subtasks + dependencies — mirrors the web's
                    // task-sheet sections. Server runs cycle detection
                    // on every write; the UI just lists + offers a
                    // picker.
                    NavigationLink {
                        TaskRelationsView(task: task) { onComplete() }
                            .environmentObject(api)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "rectangle.stack.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(.teal)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Subtareas y dependencias")
                                    .font(.subheadline).bold()
                                    .foregroundStyle(.primary)
                                Text("Estructura jerárquica y precedencia")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(14)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)

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

                            if uploadSuccess {
                                Label("Documento subido correctamente", systemImage: "checkmark.circle.fill")
                                    .font(.subheadline.bold())
                                    .foregroundStyle(Color.rdGreen)
                            } else {
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
                                    .background(taskColor, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(uploading)

                                Button { showFileImporter = true } label: {
                                    HStack {
                                        Image(systemName: "doc.fill")
                                        Text("Seleccionar PDF")
                                            .font(.subheadline.bold())
                                    }
                                    .foregroundStyle(taskColor)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(taskColor, lineWidth: 1.5))
                                }
                                .buttonStyle(.plain)
                                .disabled(uploading)
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
            .task { await refreshTask() }
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
            .sheet(isPresented: $showRecurrenceSheet) {
                // Server requires creator role; canEditRecurrence
                // already gates the entry button.
                TaskRecurrenceSheet(
                    taskId: task.id,
                    existing: nil,                       // model doesn't carry recurrence yet
                    onSaved: { _ in onComplete() }
                ).environmentObject(api)
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

    // MARK: - Detail-only banners

    /// Lists the predecessor tasks that haven't been completada/no_aplica
    /// yet. The server still allows the user to hit Complete (the actual
    /// blocking happens on Submit), but surfacing the list inline saves
    /// a round-trip through the rejection flow.
    @ViewBuilder
    private var blockingDependenciesBanner: some View {
        if let deps = task.unfulfilledDependencies, !deps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(.orange)
                    Text("Bloqueada por \(deps.count) tarea\(deps.count == 1 ? "" : "s")")
                        .font(.caption.bold())
                        .foregroundStyle(.orange)
                    Spacer()
                }
                ForEach(deps) { dep in
                    HStack(spacing: 8) {
                        Image(systemName: "circle.dotted")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(dep.title)
                            .font(.caption)
                            .lineLimit(1)
                        Spacer()
                        Text(statusLabelFor(dep.status))
                            .font(.system(size: 9, weight: .heavy))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.orange.opacity(0.08))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.orange.opacity(0.25), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    /// "X de Y subtareas completadas" with a thin progress bar. Hidden
    /// when the task has no children (server returns nil for that case).
    @ViewBuilder
    private var subtaskProgressBanner: some View {
        if let progress = task.subtaskProgress, progress.total > 0 {
            let pct = Double(progress.done) / Double(progress.total)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "rectangle.stack.fill")
                        .foregroundStyle(Color.rdBlue)
                    Text("\(progress.done) de \(progress.total) subtareas completadas")
                        .font(.caption.bold())
                        .foregroundStyle(.primary)
                    Spacer()
                    Text("\(Int(pct * 100))%")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(.systemGray5)).frame(height: 6)
                        Capsule().fill(Color.rdBlue)
                            .frame(width: geo.size.width * CGFloat(pct), height: 6)
                    }
                }
                .frame(height: 6)
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    /// Single-line "Repite cada N días/semanas/meses [hasta …]" summary.
    /// Only rendered when the task has a recurrence rule.
    @ViewBuilder
    private var recurrenceSummaryBanner: some View {
        if let summary = task.recurrenceSummary {
            HStack(spacing: 8) {
                Image(systemName: "arrow.clockwise.circle.fill")
                    .foregroundStyle(.purple)
                Text(summary)
                    .font(.caption.bold())
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Spacer()
            }
            .padding(10)
            .background(Color.purple.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func statusLabelFor(_ status: String) -> String {
        switch status {
        case "en_progreso":    return "EN CURSO"
        case "pending_review": return "REVISIÓN"
        case "completada":     return "DONE"
        case "no_aplica":      return "N/A"
        default:               return "PENDIENTE"
        }
    }

    /// Refresh the task from the detail endpoint so the inline banners
    /// have subtask_progress / unfulfilled_dependencies / recurrence.
    /// The list endpoint omits these to keep the index cheap.
    private func refreshTask() async {
        do {
            let fresh = try await api.getTask(id: task.id)
            task = fresh
        } catch {
            // Silent — the seeded task already covers the core fields,
            // and any user-visible failures will surface when they hit
            // an action button that uses the live state.
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
                // Client uploading proof of an installment payment.
                // Resolve the first installment that still needs a proof —
                // the legacy /payment/upload endpoint refuses uploads
                // whenever a payment plan exists, which is exactly when
                // payment_plan_created tasks are created.
                let installments = try await api.fetchInstallments(applicationId: appId)
                guard let next = installments.first(where: { i in
                    let s = i.status ?? ""
                    return s != "approved" && s != "proof_uploaded"
                }) else {
                    throw APIError.server("Todas las cuotas ya fueron pagadas o están en revisión")
                }
                try await api.uploadInstallmentProof(
                    applicationId: appId, installmentId: next.id,
                    fileData: data, filename: filename, notes: task.title
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
