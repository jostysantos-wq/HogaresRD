import SwiftUI

// MARK: - Conversations List

struct ConversationsView: View {
    @EnvironmentObject var api: APIService
    @State private var conversations: [Conversation] = []
    @State private var loading = true
    @State private var errorMsg: String?

    var body: some View {
        Group {
            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg {
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
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 60))
                        .foregroundStyle(Color.rdBlue.opacity(0.35))
                    Text("Sin mensajes aun")
                        .font(.title2).bold()
                    Text("Cuando contactes a un agente sobre una propiedad, la conversacion aparecera aqui.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
            } else {
                List(conversations) { conv in
                    NavigationLink {
                        ConversationThreadView(conversation: conv)
                            .environmentObject(api)
                    } label: {
                        ConversationRow(conv: conv, myId: api.currentUser?.id ?? "")
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Mis Mensajes")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        if conversations.isEmpty { loading = true }
        errorMsg = nil
        do {
            conversations = try await api.getConversations()
            conversations.sort { $0.updatedAt > $1.updatedAt }
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

// MARK: - Row

struct ConversationRow: View {
    let conv: Conversation
    let myId: String

    private var unread: Int {
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
                    Text(otherRole)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(conv.clientId == myId ? Color.rdBlue : Color.rdGreen)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background((conv.clientId == myId ? Color.rdBlue : Color.rdGreen).opacity(0.1))
                        .clipShape(Capsule())
                    Spacer()
                    Text(timeLabel(conv.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(unread > 0 ? Color.rdBlue : .secondary)
                }
                Text(conv.propertyTitle)
                    .font(.caption)
                    .foregroundStyle(Color.rdBlue)
                    .lineLimit(1)
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
