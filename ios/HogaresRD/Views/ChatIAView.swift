import SwiftUI

// MARK: - Chat IA View (Claude-powered assistant)

struct ChatIAView: View {
    @EnvironmentObject var api: APIService
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var sending = false
    @State private var scrollProxy: ScrollViewProxy?
    @FocusState private var inputFocused: Bool

    private var suggestions: [String] {
        let role = api.currentUser?.role ?? "user"
        if ["agency", "broker", "inmobiliaria", "constructora"].contains(role) {
            return [
                "Como publico una propiedad?",
                "Como gestiono mi pipeline de aplicaciones?",
                "Consejos para el mercado de Santo Domingo",
                "Que documentos necesito para una aplicacion?",
                "Como veo las estadisticas de mis propiedades?",
                "Como agendo visitas con clientes?"
            ]
        }
        return [
            "Como busco propiedades en la app?",
            "Como guardo propiedades que me gustan?",
            "Como contacto a un agente?",
            "Como agendo una visita a una propiedad?",
            "Que necesito para aplicar a una propiedad?",
            "Como funciona la calculadora de hipoteca?"
        ]
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        if messages.isEmpty {
                            welcomeView
                        }

                        ForEach(messages) { msg in
                            ChatBubble(message: msg)
                                .id(msg.id)
                        }

                        if sending {
                            HStack(spacing: 8) {
                                TypingIndicator()
                                Text("Claude está pensando...")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                            }
                            .padding(.horizontal)
                            .id("typing")
                        }
                    }
                    .padding(.vertical, 16)
                }
                .onAppear { scrollProxy = proxy }
            }

            Divider()

            // Input bar
            HStack(spacing: 10) {
                TextField("Pregúntale algo a Claude...", text: $inputText, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .focused($inputFocused)
                    .onSubmit { send() }

                Button {
                    send()
                } label: {
                    Image(systemName: sending ? "hourglass" : "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(canSend ? Color.rdBlue : Color(.tertiaryLabel))
                }
                .disabled(!canSend)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemGroupedBackground))
        }
        .navigationTitle("Chat IA")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button {
                        messages = []
                    } label: {
                        Label("Nueva conversación", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    // MARK: - Welcome

    private var welcomeView: some View {
        VStack(spacing: 20) {
            Spacer().frame(height: 20)

            // Claude avatar
            ZStack {
                Circle()
                    .fill(LinearGradient(
                        colors: [Color(red: 0.85, green: 0.55, blue: 0.25), Color(red: 0.75, green: 0.40, blue: 0.15)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ))
                    .frame(width: 64, height: 64)
                Image(systemName: "brain.head.profile.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.white)
            }

            VStack(spacing: 6) {
                Text("Asistente HogaresRD")
                    .font(.title3).bold()
                Text("Powered by Claude")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text("Preguntame como usar la app, buscar propiedades, publicar listados, gestionar aplicaciones, o cualquier duda sobre bienes raices en Republica Dominicana.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            // Suggestion chips
            VStack(spacing: 8) {
                Text("Sugerencias")
                    .font(.caption).bold()
                    .foregroundStyle(.tertiary)

                FlowLayout(spacing: 8) {
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button {
                            inputText = suggestion
                            send()
                        } label: {
                            Text(suggestion)
                                .font(.caption)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(Color.rdBlue.opacity(0.08))
                                .foregroundStyle(Color.rdBlue)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
            }

            Spacer().frame(height: 20)
        }
    }

    // MARK: - Actions

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
    }

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }

        let userMsg = ChatMessage(role: .user, content: text)
        messages.append(userMsg)
        inputText = ""
        sending = true

        scrollToBottom()

        Task {
            let history = messages.dropLast().map { ["role": $0.role.rawValue, "content": $0.content] }

            // Build context from current user
            var context: [String: Any] = [:]
            if let user = api.currentUser {
                context["brokerName"] = user.name
                context["userRole"] = user.role
            }

            do {
                let reply = try await api.sendChatMessage(
                    message: text,
                    history: history,
                    context: context
                )
                let assistantMsg = ChatMessage(role: .assistant, content: reply)
                messages.append(assistantMsg)
            } catch {
                let errorMsg = ChatMessage(role: .assistant, content: "⚠️ \(error.localizedDescription)")
                messages.append(errorMsg)
            }

            sending = false
            scrollToBottom()
        }
    }

    private func scrollToBottom() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(100))
            withAnimation(Motion.fade) {
                if sending {
                    scrollProxy?.scrollTo("typing", anchor: .bottom)
                } else if let last = messages.last {
                    scrollProxy?.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }
}

// MARK: - Chat Message Model

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    let content: String
    let timestamp = Date()

    enum Role: String {
        case user
        case assistant
    }
}

// MARK: - Chat Bubble

struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.role == .assistant {
                // Claude avatar
                ZStack {
                    Circle()
                        .fill(Color(red: 0.85, green: 0.55, blue: 0.25))
                        .frame(width: 30, height: 30)
                    Image(systemName: "brain.head.profile.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(.white)
                }
                .padding(.top, 2)
            }

            if message.role == .user { Spacer(minLength: 50) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
                Text(message.content)
                    .font(.subheadline)
                    .padding(12)
                    .background(message.role == .user ? Color.rdBlue : Color(.secondarySystemGroupedBackground))
                    .foregroundStyle(message.role == .user ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                Text(timeString)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }

            if message.role == .assistant { Spacer(minLength: 50) }
        }
        .padding(.horizontal)
    }

    private var timeString: String {
        let f = DateFormatter()
        f.timeStyle = .short
        return f.string(from: message.timestamp)
    }
}

// MARK: - Typing Indicator

struct TypingIndicator: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(Color(red: 0.85, green: 0.55, blue: 0.25))
                    .frame(width: 30, height: 30)
                Image(systemName: "brain.head.profile.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(.white)
            }
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color(.tertiaryLabel))
                        .frame(width: 7, height: 7)
                        .opacity(phase == i ? 1.0 : 0.3)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(Capsule())
        }
        .onAppear {
            Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
                withAnimation(Motion.fade) {
                    phase = (phase + 1) % 3
                }
            }
        }
    }
}

// FlowLayout is defined in ListingDetailView.swift
