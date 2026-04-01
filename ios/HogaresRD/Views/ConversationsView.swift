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
                    Text("Sin mensajes aún")
                        .font(.title2).bold()
                    Text("Cuando contactes a un agente sobre una propiedad, la conversación aparecerá aquí.")
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
        loading = true; errorMsg = nil
        do {
            conversations = try await api.getConversations()
            // Sort newest first
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

    private var unread: Int { conv.unreadClient ?? 0 }

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            ZStack {
                Circle()
                    .fill(Color.rdBlue.opacity(0.12))
                    .frame(width: 50, height: 50)
                Image(systemName: "building.2.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Color.rdBlue)
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
                    Text(conv.propertyTitle)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                    Spacer()
                    Text(timeLabel(conv.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(conv.lastMessage ?? "Sin mensajes")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let broker = conv.brokerName {
                    Label(broker, systemImage: "person.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.rdBlue)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func timeLabel(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: iso) else { return "" }
        let d = Int(Date().timeIntervalSince(date) / 86400)
        if d == 0 { return "Hoy" }
        if d == 1 { return "Ayer" }
        return "\(d)d"
    }
}
