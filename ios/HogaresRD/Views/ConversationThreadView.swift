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

    private var myId: String { api.currentUser?.id ?? "" }
    private var myRole: String { api.currentUser?.role ?? "user" }

    /// Determine if a message is "mine" based on senderId AND senderRole.
    /// If the same user sent messages as both "client" and "broker" (testing),
    /// use senderRole to distinguish sides: client role = left, broker role = right for agents.
    private func isMyMessage(_ msg: ConvMessage) -> Bool {
        // Different user → simple check
        if msg.senderId != myId { return false }
        // Same user but different roles → match by role
        let iAmBroker = ["agency", "broker", "inmobiliaria"].contains(myRole)
        if iAmBroker {
            return msg.senderRole != "client"
        } else {
            return msg.senderRole == "client"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // ── Message list ────────────────────────────────────────
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
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
                                MessageBubble(
                                    msg: msg,
                                    isMe: isMyMessage(msg),
                                    showSender: shouldShowSender(msg, in: group.messages)
                                )
                                .id(msg.id)
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

            // ── Input bar ───────────────────────────────────────────
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
        }
        .task {
            await loadMessages()
            await markRead()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
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

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if let last = messages.last {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) }
        }
    }

    // MARK: - Network

    private func loadMessages() async {
        guard let conv = try? await api.getConversation(id: conversation.id) else { return }
        messages      = conv.messages ?? []
        lastTimestamp = messages.last?.timestamp
    }

    private func pollNew() async {
        guard let conv = try? await api.getConversation(id: conversation.id, since: lastTimestamp) else { return }
        let fresh = conv.messages ?? []
        guard !fresh.isEmpty else { return }
        let existingIDs = Set(messages.map { $0.id })
        let toAdd = fresh.filter { !existingIDs.contains($0.id) }
        if !toAdd.isEmpty {
            messages.append(contentsOf: toAdd)
            lastTimestamp = toAdd.last?.timestamp
        }
    }

    private func markRead() async {
        try? await api.markConversationRead(id: conversation.id)
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        input   = ""
        sending = true
        if let msg = try? await api.sendMessage(conversationId: conversation.id, text: text) {
            messages.append(msg)
            lastTimestamp = msg.timestamp
        }
        sending = false
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

private func parseISO(_ s: String) -> Date? {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fmt.date(from: s) { return d }
    fmt.formatOptions = [.withInternetDateTime]
    return fmt.date(from: s)
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
