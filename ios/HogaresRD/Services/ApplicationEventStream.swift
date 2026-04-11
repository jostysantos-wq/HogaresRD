import Foundation

// MARK: - Application Event Stream (SSE)
//
// Consumes the long-lived GET /api/applications/:id/events Server-Sent
// Events stream the backend publishes whenever an application is saved.
// Each `event: state` frame contains an `ApplicationState` envelope that
// callers use to decide whether to re-fetch the full detail.
//
// Usage:
//     let stream = ApplicationEventStream(applicationId: id, api: api)
//     for try await state in stream.states() {
//         await reloadIfChanged(state)
//     }
//
// The stream cancels cleanly when the caller's Task is cancelled (e.g.
// when a SwiftUI .task modifier's view disappears). If the connection
// drops for any reason (network blip, 5xx, Nginx reap), the loop exits
// with a thrown error and the caller can restart — ApplicationDetailView
// implements a bounded retry with exponential backoff.

final class ApplicationEventStream {
    let applicationId: String
    weak var api: APIService?

    init(applicationId: String, api: APIService) {
        self.applicationId = applicationId
        self.api = api
    }

    enum StreamError: Error, LocalizedError {
        case notAuthenticated
        case badURL
        case badStatus(Int)
        case connectionClosed

        var errorDescription: String? {
            switch self {
            case .notAuthenticated: return "No autenticado"
            case .badURL:           return "URL inválida"
            case .badStatus(let c): return "SSE status \(c)"
            case .connectionClosed: return "Conexión cerrada"
            }
        }
    }

    /// Returns an async stream that yields an `ApplicationState` for every
    /// `event: state` frame received from the server. Heartbeat `ping`
    /// events are consumed silently. The stream throws on network error
    /// or when the caller cancels the enclosing Task.
    func states() -> AsyncThrowingStream<ApplicationState, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await self.consume(continuation: continuation)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func consume(continuation: AsyncThrowingStream<ApplicationState, Error>.Continuation) async throws {
        guard let api = api else { throw StreamError.notAuthenticated }
        guard let token = api.token else { throw StreamError.notAuthenticated }

        // The SSE endpoint uses the ?token= fallback because URLSession
        // cannot attach custom headers to async-bytes streaming requests
        // on all OS versions. The server only honors query-string tokens
        // on GET, so this is safe.
        var comps = URLComponents(string: "\(apiBase)/api/applications/\(applicationId)/events")!
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url else { throw StreamError.badURL }

        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        // Disable the default 60s timeout since this is a long-lived stream
        req.timeoutInterval = 86_400

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw StreamError.connectionClosed
        }
        guard (200..<300).contains(http.statusCode) else {
            throw StreamError.badStatus(http.statusCode)
        }

        // Parse the line-oriented SSE wire format:
        //   event: state
        //   data: {"id":"…"}
        //   (blank line separates frames)
        var currentEvent = "message"
        var currentData  = ""

        for try await line in bytes.lines {
            if Task.isCancelled { return }

            // Blank line = dispatch the pending frame
            if line.isEmpty {
                if currentEvent == "state", !currentData.isEmpty {
                    if let data = currentData.data(using: .utf8),
                       let state = try? JSONDecoder().decode(ApplicationState.self, from: data) {
                        continuation.yield(state)
                    }
                }
                currentEvent = "message"
                currentData  = ""
                continue
            }
            if line.hasPrefix(":") { continue } // comment / keepalive
            if let colon = line.firstIndex(of: ":") {
                let field = String(line[..<colon])
                var value = line[line.index(after: colon)...]
                if value.hasPrefix(" ") { value = value.dropFirst() }
                switch field {
                case "event": currentEvent = String(value)
                case "data":  currentData += String(value)
                default:      break
                }
            }
        }

        throw StreamError.connectionClosed
    }
}
