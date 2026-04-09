import SwiftUI

// MARK: - Filter Tab
enum ConvFilter: String, CaseIterable, Identifiable {
    case all      = "Todos"
    case unread   = "No leídos"
    case archived = "Archivados"
    var id: String { rawValue }
}

// MARK: - Conversations List (Redesigned — WhatsApp/Zillow style)

struct ConversationsView: View {
    @EnvironmentObject var api: APIService
    @State private var conversations: [Conversation] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var locallyRead: Set<String> = []
    @State private var activeFilter: ConvFilter = .all
    @State private var searchText: String = ""

    private var displayedConversations: [Conversation] {
        var list = conversations

        // Filter by tab
        switch activeFilter {
        case .all:
            list = list.filter { $0.archived != true }
        case .unread:
            let myId = api.currentUser?.id ?? ""
            list = list.filter { conv in
                guard conv.archived != true else { return false }
                if locallyRead.contains(conv.id) { return false }
                let isClient = conv.clientId == myId
                let count = isClient ? (conv.unreadClient ?? 0) : (conv.unreadBroker ?? 0)
                return count > 0
            }
        case .archived:
            list = list.filter { $0.archived == true }
        }

        // Filter by search
        if !searchText.isEmpty {
            let q = searchText.lowercased()
            list = list.filter {
                $0.propertyTitle.lowercased().contains(q) ||
                $0.clientName.lowercased().contains(q) ||
                ($0.brokerName ?? "").lowercased().contains(q) ||
                ($0.lastMessage ?? "").lowercased().contains(q)
            }
        }

        return list.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var unreadCount: Int {
        let myId = api.currentUser?.id ?? ""
        return conversations.filter { conv in
            guard conv.archived != true else { return false }
            if locallyRead.contains(conv.id) { return false }
            let isClient = conv.clientId == myId
            return (isClient ? (conv.unreadClient ?? 0) : (conv.unreadBroker ?? 0)) > 0
        }.count
    }

    var body: some View {
        VStack(spacing: 0) {
            // ── Search bar ──────────────────────────────────
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 15))
                TextField("Buscar conversaciones...", text: $searchText)
                    .font(.subheadline)
                    .submitLabel(.search)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 16)
            .padding(.top, 8)

            // ── Filter tabs ─────────────────────────────────
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ConvFilter.allCases) { filter in
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { activeFilter = filter }
                        } label: {
                            HStack(spacing: 4) {
                                Text(filter.rawValue)
                                    .font(.caption.weight(activeFilter == filter ? .bold : .medium))
                                if filter == .unread && unreadCount > 0 {
                                    Text("\(unreadCount)")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(Color.rdRed, in: Capsule())
                                }
                            }
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .foregroundStyle(activeFilter == filter ? .white : .primary)
                            .background(
                                activeFilter == filter ? Color.rdBlue : Color(.secondarySystemFill),
                                in: Capsule()
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }

            Divider()

            // ── Content ─────────────────────────────────────
            Group {
                if loading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Cargando mensajes...")
                            .font(.caption).foregroundStyle(.secondary)
                    }
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
                } else if displayedConversations.isEmpty {
                    emptyState
                } else {
                    List(displayedConversations) { conv in
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
                            if conv.archived != true {
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
                    .scrollDismissesKeyboard(.interactively)
                }
            }
        }
        .onTapGesture {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        .navigationTitle("Mensajes")
        .task { await loadAll() }
        .refreshable { await loadAll() }
        .onAppear { Task { await loadAll() } }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: emptyIcon)
                .font(.system(size: 56))
                .foregroundStyle(Color.rdBlue.opacity(0.3))

            Text(emptyTitle)
                .font(.title3).bold()

            Text(emptySubtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxHeight: .infinity)
    }

    private var emptyIcon: String {
        switch activeFilter {
        case .all: return "bubble.left.and.bubble.right"
        case .unread: return "checkmark.bubble"
        case .archived: return "archivebox"
        }
    }

    private var emptyTitle: String {
        if !searchText.isEmpty { return "Sin resultados" }
        switch activeFilter {
        case .all: return "Sin mensajes aún"
        case .unread: return "Todo al día"
        case .archived: return "Sin archivados"
        }
    }

    private var emptySubtitle: String {
        if !searchText.isEmpty {
            return "No se encontraron conversaciones para \"\(searchText)\"."
        }
        switch activeFilter {
        case .all:
            return "Cuando contactes a un agente sobre una propiedad, la conversación aparecerá aquí."
        case .unread:
            return "No tienes mensajes sin leer. ¡Estás al día!"
        case .archived:
            return "Las conversaciones archivadas aparecerán aquí."
        }
    }

    // Load ALL conversations (both active + archived) in one go for client-side filtering
    private func loadAll() async {
        if conversations.isEmpty { loading = true }
        errorMsg = nil
        do {
            async let active = api.getConversations(archived: false)
            async let archived = api.getConversations(archived: true)
            let (a, b) = try await (active, archived)
            conversations = a + b
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func load() async {
        await loadAll()
    }

    private func archiveConv(_ conv: Conversation) async {
        do {
            try await api.archiveConversation(id: conv.id)
            if let idx = conversations.firstIndex(where: { $0.id == conv.id }) {
                conversations.remove(at: idx)
            }
            await loadAll()
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func unarchiveConv(_ conv: Conversation) async {
        do {
            try await api.unarchiveConversation(id: conv.id)
            if let idx = conversations.firstIndex(where: { $0.id == conv.id }) {
                conversations.remove(at: idx)
            }
            await loadAll()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Conversation Row (Redesigned — WhatsApp/iMessage style)

struct ConversationRow: View {
    let conv: Conversation
    let myId: String
    var readOverride: Bool = false

    private var unread: Int {
        if readOverride { return 0 }
        let isClient = conv.clientId == myId
        return isClient ? (conv.unreadClient ?? 0) : (conv.unreadBroker ?? 0)
    }

    private var isUnread: Bool { unread > 0 }

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

    private var roleColor: Color {
        conv.clientId == myId ? Color.rdBlue : Color.rdGreen
    }

    var body: some View {
        HStack(spacing: 12) {
            // ── Avatar with listing thumbnail ──
            ZStack(alignment: .bottomTrailing) {
                // Listing image or fallback
                if let imgStr = conv.propertyImage, let url = URL(string: imgStr) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFill()
                        default:
                            avatarFallback
                        }
                    }
                    .frame(width: 52, height: 52)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    avatarFallback
                }

                // Small role indicator dot
                Circle()
                    .fill(roleColor)
                    .frame(width: 14, height: 14)
                    .overlay(
                        Image(systemName: conv.clientId == myId ? "person.fill" : "building.2.fill")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(.white)
                    )
                    .offset(x: 3, y: 3)
            }

            // ── Content ──
            VStack(alignment: .leading, spacing: 3) {
                // Top line: name + badges + time
                HStack(spacing: 6) {
                    Text(otherName)
                        .font(.subheadline.weight(isUnread ? .bold : .semibold))
                        .lineLimit(1)

                    if conv.claimRequired == true {
                        Text("Nuevo")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Color.orange, in: Capsule())
                    }

                    if conv.closed == true {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }

                    Spacer()

                    Text(relativeTime(conv.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(isUnread ? Color.rdBlue : .secondary)
                }

                // Property name
                Text(conv.propertyTitle)
                    .font(.caption)
                    .foregroundStyle(Color.rdBlue)
                    .lineLimit(1)

                // Last message preview
                HStack(spacing: 6) {
                    if let last = conv.lastMessage, !last.isEmpty {
                        Text(last)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fontWeight(isUnread ? .medium : .regular)
                    } else {
                        Text("Sin mensajes")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .italic()
                    }

                    Spacer()

                    // Unread badge
                    if unread > 0 {
                        Text("\(unread)")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Color.rdBlue, in: Circle())
                    }
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var avatarFallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12)
                .fill(roleColor.opacity(0.12))
                .frame(width: 52, height: 52)
            Image(systemName: "house.fill")
                .font(.system(size: 20))
                .foregroundStyle(roleColor.opacity(0.5))
        }
    }

    private func relativeTime(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: iso)
        if date == nil {
            fmt.formatOptions = [.withInternetDateTime]
            date = fmt.date(from: iso)
        }
        guard let d = date else { return "" }

        let now = Date()
        let diff = now.timeIntervalSince(d)

        if diff < 60 { return "Ahora" }
        if diff < 3600 { return "\(Int(diff / 60))m" }
        if Calendar.current.isDateInToday(d) {
            let df = DateFormatter()
            df.dateFormat = "h:mm a"
            df.locale = Locale(identifier: "es_DO")
            return df.string(from: d)
        }
        if Calendar.current.isDateInYesterday(d) { return "Ayer" }
        let days = Calendar.current.dateComponents([.day], from: d, to: now).day ?? 0
        if days < 7 {
            let df = DateFormatter()
            df.dateFormat = "EEE"
            df.locale = Locale(identifier: "es_DO")
            return df.string(from: d).capitalized
        }
        let df = DateFormatter()
        df.dateFormat = "d/M/yy"
        return df.string(from: d)
    }
}
