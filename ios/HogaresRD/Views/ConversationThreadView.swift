import SwiftUI

// MARK: - Thread

struct ConversationThreadView: View {
    let conversation: Conversation
    @EnvironmentObject var api: APIService

    @State private var messages:       [ConvMessage] = []
    @State private var input:          String = ""
    @State private var sending:        Bool   = false
    @State private var lastTimestamp:  String?

    private var myId: String { api.currentUser?.id ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            // ── Message list ─────────────────────────────────────────────
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(messages) { msg in
                            MessageBubble(msg: msg, isMe: msg.senderId == myId)
                                .id(msg.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                }
                .onChange(of: messages.count) { _, _ in scrollToBottom(proxy) }
                .onAppear                      { scrollToBottom(proxy) }
            }

            Divider()

            // ── Input bar ────────────────────────────────────────────────
            HStack(spacing: 10) {
                TextField("Escribe un mensaje…", text: $input, axis: .vertical)
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
        .navigationTitle(conversation.propertyTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadMessages()
            await markRead()
            // Long-polling loop — cancelled automatically when view disappears
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await pollNew()
            }
        }
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
        // Append only truly new messages (avoid duplicates)
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

// MARK: - Bubble

struct MessageBubble: View {
    let msg:  ConvMessage
    let isMe: Bool

    var body: some View {
        HStack(alignment: .bottom) {
            if isMe { Spacer(minLength: 60) }

            VStack(alignment: isMe ? .trailing : .leading, spacing: 3) {
                if !isMe {
                    Text(msg.senderName)
                        .font(.caption2).bold()
                        .foregroundStyle(Color.rdBlue)
                        .padding(.leading, 4)
                }

                Text(msg.text)
                    .font(.subheadline)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(isMe ? Color.rdBlue : Color(.systemGray5))
                    .foregroundStyle(isMe ? .white : .primary)
                    .clipShape(
                        RoundedRectangle(cornerRadius: 18)
                    )

                Text(timeLabel(msg.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }

            if !isMe { Spacer(minLength: 60) }
        }
    }

    private func timeLabel(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: iso) else { return "" }
        if Calendar.current.isDateInToday(date) {
            let f = DateFormatter(); f.dateFormat = "h:mm a"
            return f.string(from: date)
        }
        let f = DateFormatter(); f.dateFormat = "MMM d"
        return f.string(from: date)
    }
}
