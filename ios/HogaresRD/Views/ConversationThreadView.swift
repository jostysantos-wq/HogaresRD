import SwiftUI

// MARK: - Thread

struct ConversationThreadView: View {
    let conversation: Conversation
    @EnvironmentObject var api: APIService

    @Environment(\.dismiss) var dismiss
    @State private var messages:       [ConvMessage] = []
    @State private var input:          String = ""
    @State private var sending:        Bool   = false
    @State private var lastTimestamp:  String?
    @State private var isClosed:       Bool   = false
    @State private var closedByName:   String?
    @State private var closedAt:       String?
    @State private var closedReason:   String?
    @State private var showCloseSheet: Bool   = false
    @State private var closeReasonInput: String = ""
    @State private var toggling:       Bool   = false
    @State private var toggleError:    String?
    @State private var claiming:       Bool   = false
    @State private var claimed:        Bool   = false
    @State private var loadError:      String?
    @State private var messagesLoaded: Bool   = false

    // Transfer state
    @State private var showTransferSheet: Bool = false
    @State private var transferTargets:   [TransferTarget] = []
    @State private var transferLoading:   Bool = false
    @State private var transferSelected:  TransferTarget?
    @State private var transferReason:    String = ""
    @State private var transferSending:   Bool = false
    @State private var transferError:     String?
    @State private var transferred:       Bool = false
    @State private var emptyPolls:        Int  = 0

    private var myId: String { api.currentUser?.id ?? "" }
    private var myRole: String { api.currentUser?.role ?? "user" }
    private var isPro: Bool {
        ["agency", "broker", "inmobiliaria", "constructora"].contains(myRole)
    }
    private var canToggleClose: Bool {
        // Only pros can close/reopen, and only if they're the assigned broker or none assigned.
        guard isPro else { return false }
        if let bId = conversation.brokerId, !bId.isEmpty { return bId == myId }
        return true
    }

    /// Pro users can transfer the conversation only if they currently
    /// own its broker side. The backend double-checks both "ownership"
    /// and "same inmobiliaria" rules — this is just the UI gate.
    private var canTransfer: Bool {
        guard isPro else { return false }
        if let bId = conversation.brokerId, !bId.isEmpty { return bId == myId }
        return false
    }

    /// Determine if a message is "mine" based on senderId AND senderRole.
    /// If the same user sent messages as both "client" and "broker" (testing),
    /// use senderRole to distinguish sides: client role = left, broker role = right for agents.
    private func isMyMessage(_ msg: ConvMessage) -> Bool {
        // Different user → simple check
        if msg.senderId != myId { return false }
        // Same user but different roles → match by role
        let iAmBroker = ["agency", "broker", "inmobiliaria", "constructora"].contains(myRole)
        if iAmBroker {
            return msg.senderRole != "client"
        } else {
            return msg.senderRole == "client"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // ── Closed banner ───────────────────────────────────────
            if isClosed {
                HStack(spacing: 8) {
                    Image(systemName: "lock.fill")
                        .font(.caption).foregroundStyle(Color(red: 0.57, green: 0.26, blue: 0.05))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Conversación cerrada")
                            .font(.caption).bold()
                            .foregroundStyle(Color(red: 0.57, green: 0.26, blue: 0.05))
                        if let name = closedByName {
                            Text("Cerrada por \(name)" + (closedReason.map { " — \($0)" } ?? ""))
                                .font(.system(size: 11))
                                .foregroundStyle(Color(red: 0.57, green: 0.26, blue: 0.05).opacity(0.85))
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Color(red: 1.0, green: 0.95, blue: 0.78))
                .overlay(Rectangle().frame(height: 1).foregroundStyle(Color(red: 0.99, green: 0.90, blue: 0.61)), alignment: .bottom)
            }

            // ── Claim required prompt ──────────────────────────────
            if conversation.claimRequired == true && !claimed {
                VStack(spacing: 16) {
                    Spacer()
                    Image(systemName: "shield.lefthalf.filled")
                        .font(.system(size: 44))
                        .foregroundStyle(Color.rdBlue)
                    Text("Conversación pendiente")
                        .font(.title3).bold()
                    Text("\(conversation.clientName) envió \(conversation.messageCount ?? 0) mensaje(s) sobre \(conversation.propertyTitle). Reclama esta conversación para ver los mensajes y responder.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Button {
                        Task { await claimConv() }
                    } label: {
                        if claiming {
                            ProgressView().tint(.white)
                        } else {
                            Text("Reclamar conversación")
                                .font(.subheadline).bold()
                        }
                    }
                    .frame(width: 220)
                    .padding(.vertical, 12)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(.white)
                    .disabled(claiming)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {

            // ── Error banner (visible to user) ──────────────────────
            if let err = loadError {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Spacer()
                    Button("Reintentar") { Task { await loadMessages() } }
                        .font(.caption2).bold()
                }
                .padding(10)
                .background(Color.orange.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 10)
            }

            // ── Message list ────────────────────────────────────────
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if messagesLoaded && messages.isEmpty {
                            Text("No hay mensajes aún")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 40)
                        }
                        // Date-grouped messages
                        ForEach(groupedMessages, id: \.date) { group in
                            // Date separator
                            Text(group.dateLabel)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 14).padding(.vertical, 5)
                                .background(Color(.systemGray6))
                                .clipShape(Capsule())
                                .padding(.vertical, 10)

                            ForEach(group.messages) { msg in
                                if msg.senderRole == "system" {
                                    SystemMessagePill(text: msg.text)
                                        .id(msg.id)
                                } else {
                                    MessageBubble(
                                        msg: msg,
                                        isMe: isMyMessage(msg),
                                        showSender: shouldShowSender(msg, in: group.messages)
                                    )
                                    .id(msg.id)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                }
                .onChange(of: messages.count) { _, _ in scrollToBottom(proxy) }
                .onAppear { scrollToBottom(proxy) }
            }

            Divider()

            // ── Input bar (hidden when closed) ───────────────────────
            if isClosed {
                HStack {
                    Spacer()
                    Text("No puedes enviar mensajes en una conversación cerrada.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 14)
                .background(Color(.systemBackground))
            } else {
                VStack(spacing: 0) {
                    // Quick reply chips — shown when input is empty and few messages
                    if input.isEmpty && messages.count < 6 {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(quickReplies, id: \.self) { reply in
                                    Button {
                                        input = reply
                                    } label: {
                                        Text(reply)
                                            .font(.caption)
                                            .foregroundStyle(Color.rdBlue)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 7)
                                            .background(Color.rdBlue.opacity(0.08))
                                            .clipShape(Capsule())
                                            .overlay(Capsule().stroke(Color.rdBlue.opacity(0.2), lineWidth: 0.5))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                        }
                        .background(Color(.systemBackground))
                    }

                    HStack(spacing: 10) {
                        TextField("Escribe un mensaje...", text: $input, axis: .vertical)
                            .lineLimit(1...4)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 20))

                        Button {
                            Task { await send() }
                        } label: {
                            Image(systemName: sending ? "clock" : "paperplane.fill")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 40, height: 40)
                                .background(canSend ? Color.rdBlue : Color(.systemGray4))
                                .clipShape(Circle())
                        }
                        .disabled(!canSend)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(.systemBackground))
                }
            }
            } // end else (claim required check)
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(conversation.propertyTitle)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                    Text(conversation.brokerName ?? conversation.clientName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if canToggleClose || canTransfer {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if canTransfer && !isClosed {
                            Button {
                                openTransferSheet()
                            } label: {
                                Label("Transferir a otro agente", systemImage: "person.crop.circle.badge.arrow.right")
                            }
                        }
                        if canToggleClose {
                            if isClosed {
                                Button {
                                    Task { await toggleClose() }
                                } label: {
                                    Label("Reabrir conversación", systemImage: "lock.open")
                                }
                            } else {
                                Button(role: .destructive) {
                                    closeReasonInput = ""
                                    showCloseSheet = true
                                } label: {
                                    Label("Cerrar conversación", systemImage: "lock")
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .disabled(toggling)
                }
            }
        }
        .sheet(isPresented: $showCloseSheet) {
            closeReasonSheet
        }
        .sheet(isPresented: $showTransferSheet) {
            transferSheet
        }
        .alert("Error", isPresented: .constant(toggleError != nil), actions: {
            Button("OK") { toggleError = nil }
        }, message: { Text(toggleError ?? "") })
        .task {
            await loadMessages()
            await markRead()
            while !Task.isCancelled {
                // Adaptive backoff: 5s → 10s → 20s → 30s max based on idle polls
                let interval: Int = emptyPolls < 3 ? 5 : emptyPolls < 6 ? 10 : emptyPolls < 10 ? 20 : 30
                try? await Task.sleep(for: .seconds(interval))
                await pollNew()
            }
        }
    }

    // MARK: - Date Grouping

    private struct MessageGroup {
        let date: String
        let dateLabel: String
        let messages: [ConvMessage]
    }

    private var groupedMessages: [MessageGroup] {
        let dayFmt = DateFormatter()
        dayFmt.locale = Locale(identifier: "es_DO")

        var groups: [String: [ConvMessage]] = [:]
        var order: [String] = []

        for msg in messages {
            let dateKey: String
            if let d = parseISO(msg.timestamp) {
                dayFmt.dateFormat = "yyyy-MM-dd"
                dateKey = dayFmt.string(from: d)
            } else {
                dateKey = "unknown"
            }
            if groups[dateKey] == nil { order.append(dateKey) }
            groups[dateKey, default: []].append(msg)
        }

        return order.compactMap { key in
            guard let msgs = groups[key] else { return nil }
            let label: String
            if key == "unknown" {
                label = ""
            } else {
                dayFmt.dateFormat = "yyyy-MM-dd"
                if let d = dayFmt.date(from: key) {
                    if Calendar.current.isDateInToday(d) {
                        label = "Hoy"
                    } else if Calendar.current.isDateInYesterday(d) {
                        label = "Ayer"
                    } else {
                        dayFmt.dateFormat = "d 'de' MMMM, yyyy"
                        label = dayFmt.string(from: d)
                    }
                } else {
                    label = key
                }
            }
            return MessageGroup(date: key, dateLabel: label, messages: msgs)
        }
    }

    /// Only show sender name if the role changes from the previous message
    private func shouldShowSender(_ msg: ConvMessage, in group: [ConvMessage]) -> Bool {
        guard let idx = group.firstIndex(where: { $0.id == msg.id }), idx > 0 else { return true }
        let prev = group[idx - 1]
        return prev.senderRole != msg.senderRole || prev.senderId != msg.senderId
    }

    // MARK: - Helpers

    private var canSend: Bool {
        !sending && !input.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Context-aware quick reply suggestions
    private var quickReplies: [String] {
        if isPro {
            return [
                "¡Hola! ¿En qué puedo ayudarte?",
                "¿Quieres agendar una visita?",
                "Te comparto más detalles",
                "¿Cuál es tu presupuesto?",
            ]
        } else {
            return [
                "¿Está disponible?",
                "¿Cuál es el precio?",
                "Me gustaría agendar una visita",
                "¿Acepta financiamiento?",
            ]
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if let last = messages.last {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) }
        }
    }

    // MARK: - Network

    private func loadMessages() async {
        do {
            let conv = try await api.getConversation(id: conversation.id)
            messages      = conv.messages ?? []
            lastTimestamp = messages.last?.timestamp
            messagesLoaded = true
            loadError = nil
            syncClosedState(conv)
            print("[ConvThread] loadMessages OK: \(messages.count) messages for \(conversation.id)")
        } catch is CancellationError {
            print("[ConvThread] loadMessages CANCELLED")
        } catch {
            loadError = "\(error)"
            print("[ConvThread] loadMessages FAILED: \(error)")
            ErrorReporter.shared.reportAPIError(error, endpoint: "GET /api/conversations/\(conversation.id)", context: "loadMessages")
        }
    }

    private func claimConv() async {
        claiming = true
        do {
            let conv = try await api.claimConversation(id: conversation.id)
            claimed = true
            // Reload messages now that we have access
            messages = conv.messages ?? []
            if let last = messages.last { lastTimestamp = last.timestamp }
            isClosed = conv.closed ?? false
        } catch {
            toggleError = error.localizedDescription
        }
        claiming = false
    }

    private func pollNew() async {
        do {
            let conv = try await api.getConversation(id: conversation.id, since: lastTimestamp)
            let fresh = conv.messages ?? []
            syncClosedState(conv)
            guard !fresh.isEmpty else { emptyPolls += 1; return }
            let existingIDs = Set(messages.map { $0.id })
            let toAdd = fresh.filter { !existingIDs.contains($0.id) }
            if !toAdd.isEmpty {
                emptyPolls = 0 // Reset backoff on new messages
                messages.append(contentsOf: toAdd)
                lastTimestamp = toAdd.last?.timestamp
                await markRead()
            } else {
                emptyPolls += 1
            }
        } catch {
            print("[ConvThread] pollNew FAILED: \(error)")
            ErrorReporter.shared.reportAPIError(error, endpoint: "GET /api/conversations/\(conversation.id)?since=", context: "pollNew")
        }
    }

    private func syncClosedState(_ conv: Conversation) {
        isClosed     = conv.closed ?? false
        closedByName = conv.closedByName
        closedAt     = conv.closedAt
        closedReason = conv.closedReason
    }

    private func toggleClose(reason: String = "") async {
        toggling = true
        defer { toggling = false }
        do {
            let updated: Conversation
            if isClosed {
                updated = try await api.reopenConversation(id: conversation.id)
            } else {
                updated = try await api.closeConversation(id: conversation.id, reason: reason)
            }
            syncClosedState(updated)
            // Append the new system message the server added
            let fresh = updated.messages ?? []
            let existingIDs = Set(messages.map { $0.id })
            let toAdd = fresh.filter { !existingIDs.contains($0.id) }
            messages.append(contentsOf: toAdd)
            if let last = toAdd.last { lastTimestamp = last.timestamp }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            toggleError = error.localizedDescription
        }
    }

    // MARK: - Close Reason Sheet

    // MARK: - Transfer sheet

    private var transferSheet: some View {
        NavigationStack {
            Form {
                if transferred {
                    Section {
                        HStack(spacing: 10) {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.title2)
                                .foregroundStyle(Color.rdGreen)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Conversación transferida")
                                    .font(.subheadline.bold())
                                Text("El nuevo agente ya fue notificado.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } else {
                    Section {
                        Text("Al transferir, el nuevo agente verá toda la conversación y pasarás a no recibir más mensajes de esta hilo. Solo puedes transferir a agentes de tu misma inmobiliaria.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if transferLoading {
                        Section {
                            HStack {
                                Spacer()
                                ProgressView()
                                Spacer()
                            }
                        }
                    } else if transferTargets.isEmpty {
                        Section {
                            Text("No hay otros agentes en tu inmobiliaria disponibles para transferir.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 8)
                        }
                    } else {
                        Section("Transferir a") {
                            ForEach(transferTargets) { t in
                                Button {
                                    transferSelected = t
                                    transferError = nil
                                } label: {
                                    HStack(spacing: 10) {
                                        ZStack {
                                            Circle().fill(Color.rdBlue.opacity(0.12)).frame(width: 36, height: 36)
                                            Text(String((t.name.first ?? Character("?"))).uppercased())
                                                .font(.subheadline.bold())
                                                .foregroundStyle(Color.rdBlue)
                                        }
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(t.name.isEmpty ? "(sin nombre)" : t.name)
                                                .font(.subheadline.bold())
                                                .foregroundStyle(.primary)
                                            Text(teammateRoleLabel(t.role)
                                                 + (t.agencyName?.isEmpty == false ? " · \(t.agencyName!)" : ""))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        if transferSelected?.id == t.id {
                                            Image(systemName: "checkmark.circle.fill")
                                                .foregroundStyle(Color.rdGreen)
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        Section("Motivo (opcional)") {
                            TextField("Ej: me voy de vacaciones, cliente prefiere otro agente…",
                                      text: $transferReason, axis: .vertical)
                                .lineLimit(2...4)
                        }
                        if let err = transferError {
                            Section {
                                Text(err)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        Section {
                            Button {
                                Task { await performTransfer() }
                            } label: {
                                HStack {
                                    Spacer()
                                    if transferSending {
                                        ProgressView().tint(.white)
                                    } else {
                                        Text("Transferir conversación").bold()
                                    }
                                    Spacer()
                                }
                            }
                            .disabled(transferSelected == nil || transferSending)
                            .listRowBackground(transferSelected == nil ? Color(.systemGray5) : Color.rdBlue)
                            .foregroundStyle(.white)
                        }
                    }
                }
            }
            .navigationTitle("Transferir conversación")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(transferred ? "Cerrar" : "Cancelar") {
                        showTransferSheet = false
                        if transferred { dismiss() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            if !transferred && transferTargets.isEmpty {
                await loadTransferTargets()
            }
        }
    }

    private func teammateRoleLabel(_ role: String) -> String {
        switch role {
        case "broker":       return "Agente Broker"
        case "agency":       return "Agente"
        case "inmobiliaria": return "Inmobiliaria"
        case "constructora": return "Constructora"
        default:             return role.capitalized
        }
    }

    private func openTransferSheet() {
        transferSelected = nil
        transferReason   = ""
        transferError    = nil
        transferred      = false
        transferTargets  = []
        showTransferSheet = true
    }

    private func loadTransferTargets() async {
        transferLoading = true
        defer { transferLoading = false }
        do {
            let list = try await api.fetchTransferTargets(conversationId: conversation.id)
            await MainActor.run { transferTargets = list }
        } catch {
            let msg = (error as? APIError).flatMap { err -> String? in
                if case .server(let s) = err { return s }
                return nil
            } ?? "Error al cargar compañeros"
            await MainActor.run { transferError = msg }
        }
    }

    private func performTransfer() async {
        guard let target = transferSelected else { return }
        transferSending = true
        transferError   = nil
        defer { transferSending = false }
        do {
            _ = try await api.transferConversation(
                id: conversation.id,
                targetUserId: target.id,
                reason: transferReason
            )
            await MainActor.run {
                transferred = true
            }
            // Wait briefly so the user sees the success, then close the
            // sheet AND this thread view (the conversation no longer
            // belongs to this broker).
            try? await Task.sleep(for: .seconds(1.5))
            await MainActor.run {
                showTransferSheet = false
                dismiss()
            }
        } catch {
            let msg = (error as? APIError).flatMap { err -> String? in
                if case .server(let s) = err { return s }
                return nil
            } ?? "Error al transferir"
            await MainActor.run { transferError = msg }
        }
    }

    private var closeReasonSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Una vez cerrada, ni tú ni el cliente podrán enviar mensajes hasta que la reabras.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Razón (opcional)") {
                    TextField("Ej: Cliente no interesado, propiedad vendida…", text: $closeReasonInput, axis: .vertical)
                        .lineLimit(2...4)
                }
                Section {
                    Button(role: .destructive) {
                        let reason = closeReasonInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        showCloseSheet = false
                        Task { await toggleClose(reason: String(reason.prefix(200))) }
                    } label: {
                        HStack {
                            Spacer()
                            Text("Cerrar conversación").bold()
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle("Cerrar conversación")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { showCloseSheet = false }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func markRead() async {
        // Detach so the request survives view dismissal. Otherwise swiping
        // back too quickly cancels the request and the badge stays set.
        let id = conversation.id
        let api = self.api
        Task.detached {
            try? await api.markConversationRead(id: id)
        }
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        input   = ""
        sending = true
        do {
            let msg = try await api.sendMessage(conversationId: conversation.id, text: text)
            messages.append(msg)
            lastTimestamp = msg.timestamp
            emptyPolls = 0 // Reset backoff after sending
        } catch {
            print("[ConvThread] send FAILED: \(error)")
            ErrorReporter.shared.reportAPIError(error, endpoint: "POST /api/conversations/\(conversation.id)/messages", context: "sendMessage")
            // Reload the full thread to pick up the message the server saved
            await loadMessages()
        }
        sending = false
    }
}

// MARK: - System Message Pill

struct SystemMessagePill: View {
    let text: String
    var body: some View {
        HStack {
            Spacer()
            Text(text)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Color(.systemGray6))
                .overlay(
                    Capsule().stroke(Color(.systemGray4), style: StrokeStyle(lineWidth: 0.5, dash: [3,3]))
                )
                .clipShape(Capsule())
            Spacer()
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Message Bubble

struct MessageBubble: View {
    let msg:        ConvMessage
    let isMe:       Bool
    var showSender: Bool = true

    var body: some View {
        HStack(alignment: .bottom) {
            if isMe { Spacer(minLength: 60) }

            VStack(alignment: isMe ? .trailing : .leading, spacing: 2) {
                // Sender name + role badge (only for other party, and only when sender changes)
                if !isMe && showSender {
                    HStack(spacing: 6) {
                        Text(msg.senderName)
                            .font(.caption2).bold()
                            .foregroundStyle(roleColor)
                        Text(roleLabel)
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(roleColor)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(roleColor.opacity(0.12))
                            .clipShape(Capsule())
                    }
                    .padding(.leading, 6)
                    .padding(.top, showSender ? 6 : 0)
                }

                // Bubble
                HStack(alignment: .bottom, spacing: 6) {
                    Text(msg.text)
                        .font(.subheadline)
                        .foregroundStyle(isMe ? .white : .primary)

                    Text(timeString)
                        .font(.system(size: 9))
                        .foregroundStyle(isMe ? .white.opacity(0.6) : .secondary)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(isMe ? Color.rdBlue : Color(.systemGray6))
                .clipShape(ChatBubbleShape(isMe: isMe))
            }

            if !isMe { Spacer(minLength: 60) }
        }
        .padding(.vertical, showSender ? 2 : 1)
    }

    private var roleColor: Color {
        switch msg.senderRole {
        case "broker":  return Color.rdBlue
        case "client":  return Color.rdGreen
        default:        return .secondary
        }
    }

    private var roleLabel: String {
        switch msg.senderRole {
        case "broker":  return "Agente"
        case "client":  return "Cliente"
        default:        return msg.senderRole
        }
    }

    private var timeString: String {
        guard let date = parseISO(msg.timestamp) else { return "" }
        let df = DateFormatter()
        df.dateFormat = "h:mm a"
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: date)
    }
}

// MARK: - ISO 8601 parser (handles with and without fractional seconds)

private let _iso8601Frac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let _iso8601NoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private func parseISO(_ s: String) -> Date? {
    _iso8601Frac.date(from: s) ?? _iso8601NoFrac.date(from: s)
}

// MARK: - Chat Bubble Shape (tail on one side)

struct ChatBubbleShape: Shape {
    let isMe: Bool
    private let cornerRadius: CGFloat = 16
    private let tailSize: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        var path = Path()

        if isMe {
            // Rounded rect with small tail on bottom-right
            path.addRoundedRect(
                in: CGRect(x: rect.minX, y: rect.minY, width: rect.width - tailSize, height: rect.height),
                cornerSize: CGSize(width: cornerRadius, height: cornerRadius)
            )
            // Tail
            path.move(to: CGPoint(x: rect.maxX - tailSize, y: rect.maxY - 8))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.maxX - tailSize - 4, y: rect.maxY))
        } else {
            // Rounded rect with small tail on bottom-left
            path.addRoundedRect(
                in: CGRect(x: rect.minX + tailSize, y: rect.minY, width: rect.width - tailSize, height: rect.height),
                cornerSize: CGSize(width: cornerRadius, height: cornerRadius)
            )
            // Tail
            path.move(to: CGPoint(x: rect.minX + tailSize, y: rect.maxY - 8))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX + tailSize + 4, y: rect.maxY))
        }

        return path
    }
}
