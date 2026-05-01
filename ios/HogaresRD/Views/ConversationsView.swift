import SwiftUI

// MARK: - Filter Tab
enum ConvFilter: String, CaseIterable, Identifiable, Hashable {
    case all      = "Todos"
    case unread   = "No leídos"
    case archived = "Archivados"
    var id: String { rawValue }
}

// MARK: - Conversations List (Front-style)
//
// Wave 8-C refactor: each row is a 40pt avatar + content stack with a
// leading 3pt accent stripe when unread (no more bold-everything). Empty
// states use `EmptyStateView`; filters use `ChipRow`. Skeleton rows
// surface during slow initial loads.

struct ConversationsView: View {
    @EnvironmentObject var api: APIService
    @State private var conversations: [Conversation] = []
    @State private var loading = true
    @State private var showSkeleton = false
    @State private var errorMsg: String?
    @State private var locallyRead: Set<String> = []
    @State private var activeFilter: ConvFilter = .all
    @State private var searchText: String = ""

    /// Tracks whether the user has *ever* had threads, so the
    /// celebratory empty state only appears when "all caught up" makes
    /// sense (otherwise we show the calm "no threads yet" state).
    @AppStorage("conversations.hadThreads") private var hadThreads: Bool = false

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
            HStack(spacing: Spacing.s8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Color.rdInkSoft)
                    .font(.subheadline)
                    .accessibilityHidden(true)
                TextField("Buscar conversaciones...", text: $searchText)
                    .font(.subheadline)
                    .submitLabel(.search)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color.rdInkSoft)
                    }
                    .accessibilityLabel("Borrar búsqueda")
                }
            }
            .padding(.horizontal, Spacing.s12)
            .padding(.vertical, 9)
            .background(Color.rdSurfaceMuted, in: RoundedRectangle(cornerRadius: Radius.medium))
            .padding(.horizontal, Spacing.s16)
            .padding(.top, Spacing.s8)

            // ── Filter tabs ─────────────────────────────────
            ChipRow(
                items: [
                    .init(id: ConvFilter.all,      label: "Todos",      count: nil),
                    .init(id: ConvFilter.unread,   label: "No leídos",  count: unreadCount > 0 ? unreadCount : nil),
                    .init(id: ConvFilter.archived, label: "Archivados", count: nil)
                ],
                selection: $activeFilter
            )
            .padding(.vertical, Spacing.s4)

            Divider().opacity(0.4)

            // ── Content ─────────────────────────────────────
            Group {
                if loading && conversations.isEmpty {
                    if showSkeleton {
                        VStack(spacing: 0) {
                            ForEach(0..<5, id: \.self) { _ in
                                SkeletonRow().padding(.horizontal, Spacing.s16)
                                Divider().opacity(0.4)
                            }
                            Spacer()
                        }
                    } else {
                        Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else if let err = errorMsg, conversations.isEmpty {
                    EmptyStateView.calm(
                        systemImage: "exclamationmark.triangle",
                        title: "No pudimos cargar mensajes",
                        description: err,
                        actionTitle: "Reintentar",
                        action: { Task { await load() } }
                    )
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
                                .tint(Color.rdPurple)
                            }
                            if conv.archived == true {
                                Button {
                                    Task { await unarchiveConv(conv) }
                                } label: {
                                    Label("Restaurar", systemImage: "arrow.uturn.backward")
                                }
                                .tint(Color.rdOrange)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollDismissesKeyboard(.interactively)
                }
            }
        }
        .navigationTitle("Mensajes")
        .task { await loadAll() }
        .refreshable { await loadAll() }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !searchText.isEmpty {
            EmptyStateView.filterCleared(
                title: "Sin resultados",
                description: "No se encontraron conversaciones para \"\(searchText)\".",
                onClear: { searchText = "" }
            )
        } else {
            switch activeFilter {
            case .all:
                EmptyStateView.calm(
                    systemImage: "bubble.left.and.bubble.right",
                    title: "Sin mensajes aún",
                    description: "Cuando contactes a un agente sobre una propiedad, la conversación aparecerá aquí."
                )
            case .unread:
                if hadThreads {
                    EmptyStateView.celebratory(
                        title: "Todo al día",
                        description: "No tienes mensajes sin leer."
                    )
                } else {
                    EmptyStateView.calm(
                        systemImage: "checkmark.bubble",
                        title: "Todo al día",
                        description: "No tienes mensajes sin leer todavía."
                    )
                }
            case .archived:
                EmptyStateView.calm(
                    systemImage: "archivebox",
                    title: "Sin archivados",
                    description: "Las conversaciones archivadas aparecerán aquí."
                )
            }
        }
    }

    // Load ALL conversations (both active + archived) in one go for client-side filtering
    private func loadAll() async {
        if conversations.isEmpty {
            loading = true
            // Show skeleton only after 300ms — prevents flash on cached
            // responses.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                if loading && conversations.isEmpty {
                    showSkeleton = true
                }
            }
        }
        errorMsg = nil
        do {
            async let active  = api.getConversations(archived: false)
            async let archived = api.getConversations(archived: true)
            conversations = try await active + archived
            if !conversations.isEmpty { hadThreads = true }
        } catch let decodingError as DecodingError {
            errorMsg = decodingErrorMessage(decodingError)
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
        showSkeleton = false
    }

    private func decodingErrorMessage(_ error: DecodingError) -> String {
        switch error {
        case .typeMismatch(let type, let ctx):
            return "Tipo incorrecto: \(type) en \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
        case .valueNotFound(let type, let ctx):
            return "Valor requerido ausente: \(type) en \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
        case .keyNotFound(let key, _):
            return "Campo requerido ausente: \(key.stringValue)"
        case .dataCorrupted(let ctx):
            return "Datos corruptos: \(ctx.debugDescription)"
        @unknown default:
            return error.localizedDescription
        }
    }

    private func load() async {
        await loadAll()
    }

    private func archiveConv(_ conv: Conversation) async {
        do {
            try await api.archiveConversation(id: conv.id)
            withAnimation { conversations.removeAll { $0.id == conv.id } }
            await loadAll()
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func unarchiveConv(_ conv: Conversation) async {
        do {
            try await api.unarchiveConversation(id: conv.id)
            withAnimation { conversations.removeAll { $0.id == conv.id } }
            await loadAll()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Conversation Row (Front-style)
//
// Two anchors: a 40pt avatar (with optional bottom-right unread dot) and
// a 3pt accent stripe on the leading edge when there are unread messages.
// We rely on those anchors instead of bolding the entire row.

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

    private var roleColor: Color {
        conv.clientId == myId ? Color.rdBlue : Color.rdGreen
    }

    var body: some View {
        HStack(spacing: Spacing.s12) {
            // ── Leading accent stripe (unread indicator) ──
            RoundedRectangle(cornerRadius: 1.5)
                .fill(isUnread ? Color.rdAccent : Color.clear)
                .frame(width: 3)
                .accessibilityHidden(true)

            // ── 40pt avatar with unread dot at bottom-right ──
            ZStack(alignment: .bottomTrailing) {
                avatar
                    .frame(width: 40, height: 40)
                    .clipShape(Circle())

                if isUnread {
                    Circle()
                        .fill(Color.rdAccent)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(Color.rdSurface, lineWidth: 1.5))
                        .accessibilityHidden(true)
                }
            }

            // ── Content ──
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(otherName)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.rdInk)
                        .lineLimit(1)

                    if conv.claimRequired == true {
                        DSStatusBadge(label: "Nuevo", tint: .rdOrange)
                    }

                    if conv.closed == true {
                        Image(systemName: "lock.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.rdInkSoft)
                            .accessibilityLabel("Conversación cerrada")
                    }

                    Spacer()

                    Text(relativeTime(conv.updatedAt))
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                }

                Text(conv.propertyTitle)
                    .font(.caption)
                    .foregroundStyle(Color.rdInkSoft)
                    .lineLimit(1)

                if let last = conv.lastMessage, !last.isEmpty {
                    Text(last)
                        .font(.caption2)
                        .foregroundStyle(Color.rdInkSoft)
                        .lineLimit(1)
                } else {
                    Text("Sin mensajes")
                        .font(.caption2)
                        .foregroundStyle(Color.rdMuted)
                        .italic()
                }
            }
        }
        .padding(.vertical, Spacing.s8)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var avatar: some View {
        if let avatarURL = conv.otherPartyAvatarURL(myId: myId) {
            CachedAsyncImage(url: avatarURL, maxPixelSize: 120) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    avatarFallback
                }
            }
        } else if let imgStr = conv.propertyImage, let url = URL(string: imgStr) {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    avatarFallback
                }
            }
        } else {
            avatarFallback
        }
    }

    private var avatarFallback: some View {
        ZStack {
            Circle().fill(roleColor.opacity(0.12))
            Image(systemName: conv.clientId == myId ? "person.fill" : "building.2.fill")
                .foregroundStyle(roleColor.opacity(0.7))
        }
    }

    // Cached formatters — DateFormatter/ISO8601DateFormatter allocation is expensive
    private static let iso8601Frac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso8601NoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let timeFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h:mm a"; f.locale = Locale(identifier: "es_DO"); return f
    }()
    private static let dayNameFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "EEE"; f.locale = Locale(identifier: "es_DO"); return f
    }()
    private static let shortDateFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "d/M/yy"; return f
    }()

    private func relativeTime(_ iso: String) -> String {
        let date = Self.iso8601Frac.date(from: iso) ?? Self.iso8601NoFrac.date(from: iso)
        guard let d = date else { return "" }

        let now = Date()
        let diff = now.timeIntervalSince(d)

        if diff < 60 { return "Ahora" }
        if diff < 3600 { return "\(Int(diff / 60))m" }
        if Calendar.current.isDateInToday(d) {
            return Self.timeFmt.string(from: d)
        }
        if Calendar.current.isDateInYesterday(d) { return "Ayer" }
        let days = Calendar.current.dateComponents([.day], from: d, to: now).day ?? 0
        if days < 7 {
            return Self.dayNameFmt.string(from: d).capitalized
        }
        return Self.shortDateFmt.string(from: d)
    }
}
