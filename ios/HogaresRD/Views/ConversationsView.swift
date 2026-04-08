import SwiftUI

// MARK: - Conversations List

struct ConversationsView: View {
    @EnvironmentObject var api: APIService
    @State private var conversations: [Conversation] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var locallyRead: Set<String> = []
    @State private var showArchived = false

    var body: some View {
        VStack(spacing: 0) {
            // Activas / Archivadas tab bar
            HStack(spacing: 6) {
                convTabButton("Activas", active: !showArchived) { showArchived = false }
                convTabButton("Archivadas", active: showArchived) { showArchived = true }
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Group {
                if loading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = errorMsg, conversations.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 48))
                            .foregroundStyle(.secondary)
                        Text(err)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.rdBlue)
                    }
                    .padding()
                } else if conversations.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: showArchived ? "archivebox" : "bubble.left.and.bubble.right")
                            .font(.system(size: 60))
                            .foregroundStyle(Color.rdBlue.opacity(0.35))
                        Text(showArchived ? "Sin conversaciones archivadas" : "Sin mensajes aún")
                            .font(.title2).bold()
                        if !showArchived {
                            Text("Cuando contactes a un agente sobre una propiedad, la conversación aparecerá aquí.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 32)
                        }
                    }
                    .frame(maxHeight: .infinity)
                } else {
                    List(conversations) { conv in
                        NavigationLink {
                            ConversationThreadView(conversation: conv)
                                .environmentObject(api)
                                .onAppear { locallyRead.insert(conv.id) }
                        } label: {
                            ConversationRow(
                                conv: conv,
                                myId: api.currentUser?.id ?? "",
                                readOverride: locallyRead.contains(conv.id)
                            )
                        }
                        .swipeActions(edge: .trailing) {
                            if conv.closed == true && conv.archived != true {
                                Button {
                                    Task { await archiveConv(conv) }
                                } label: {
                                    Label("Archivar", systemImage: "archivebox")
                                }
                                .tint(.indigo)
                            }
                            if conv.archived == true {
                                Button {
                                    Task { await unarchiveConv(conv) }
                                } label: {
                                    Label("Restaurar", systemImage: "arrow.uturn.backward")
                                }
                                .tint(.orange)
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
        }
        .navigationTitle("Mis Mensajes")
        .task { await load() }
        .refreshable { await load() }
        .onAppear { Task { await load() } }
        .onChange(of: showArchived) { _, _ in Task { await load() } }
    }

    @ViewBuilder
    private func convTabButton(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption).bold()
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(active ? Color(.label) : Color(.secondarySystemFill))
                .foregroundStyle(active ? Color(.systemBackground) : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        if conversations.isEmpty { loading = true }
        errorMsg = nil
        do {
            conversations = try await api.getConversations(archived: showArchived)
            conversations.sort { $0.updatedAt > $1.updatedAt }
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func archiveConv(_ conv: Conversation) async {
        do {
            try await api.archiveConversation(id: conv.id)
            conversations.removeAll { $0.id == conv.id }
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func unarchiveConv(_ conv: Conversation) async {
        do {
            try await api.unarchiveConversation(id: conv.id)
            conversations.removeAll { $0.id == conv.id }
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Row

struct ConversationRow: View {
    let conv: Conversation
    let myId: String
    var readOverride: Bool = false

    private var unread: Int {
        if readOverride { return 0 }
        // Show unread based on role
        let isClient = conv.clientId == myId
        return isClient ? (conv.unreadClient ?? 0) : (conv.unreadBroker ?? 0)
    }

    private var otherName: String {
        let isClient = conv.clientId == myId
        if isClient {
            return conv.brokerName ?? "Agente pendiente"
        } else {
            return conv.clientName
        }
    }

    private var otherRole: String {
        let isClient = conv.clientId == myId
        return isClient ? "Agente" : "Cliente"
    }

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            ZStack {
                Circle()
                    .fill(conv.clientId == myId
                          ? Color.rdBlue.opacity(0.12)
                          : Color.rdGreen.opacity(0.12))
                    .frame(width: 50, height: 50)
                Image(systemName: conv.clientId == myId
                      ? "person.fill"
                      : "building.2.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(conv.clientId == myId ? Color.rdBlue : Color.rdGreen)
            }
            .overlay(alignment: .topTrailing) {
                if unread > 0 {
                    Text("\(unread)")
                        .font(.caption2).bold()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Color.rdRed)
                        .clipShape(Capsule())
                        .offset(x: 4, y: -4)
                }
            }

            // Info
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(otherName)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                    if conv.claimRequired == true {
                        Text("Pendiente")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.rdBlue)
                            .clipShape(Capsule())
                    } else {
                        Text(otherRole)
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(conv.clientId == myId ? Color.rdBlue : Color.rdGreen)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background((conv.clientId == myId ? Color.rdBlue : Color.rdGreen).opacity(0.1))
                            .clipShape(Capsule())
                    }
                    Spacer()
                    Text(timeLabel(conv.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(unread > 0 ? Color.rdBlue : .secondary)
                }
                HStack(spacing: 4) {
                    if conv.closed == true {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                    Text(conv.propertyTitle)
                        .font(.caption)
                        .foregroundStyle(Color.rdBlue)
                        .lineLimit(1)
                }
                if let last = conv.lastMessage, !last.isEmpty {
                    Text(last)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fontWeight(unread > 0 ? .semibold : .regular)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func timeLabel(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: iso) else { return "" }
        if Calendar.current.isDateInToday(date) {
            let df = DateFormatter()
            df.dateFormat = "h:mm a"
            df.locale = Locale(identifier: "es_DO")
            return df.string(from: date)
        }
        if Calendar.current.isDateInYesterday(date) { return "Ayer" }
        let d = Calendar.current.dateComponents([.day], from: date, to: Date()).day ?? 0
        if d < 7 {
            let df = DateFormatter()
            df.dateFormat = "EEEE"
            df.locale = Locale(identifier: "es_DO")
            return df.string(from: date).capitalized
        }
        let df = DateFormatter()
        df.dateFormat = "d/M/yy"
        return df.string(from: date)
    }
}
