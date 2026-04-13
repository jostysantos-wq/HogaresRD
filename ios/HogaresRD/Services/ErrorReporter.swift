import Foundation
import UIKit

// MARK: - Client Error Reporter
//
// Collects iOS errors and ships them to the server in batches.
// Errors are buffered in memory and flushed every 30 seconds or
// when the buffer reaches 10 items — whichever comes first.
// Fire-and-forget: failures are silently dropped to avoid loops.

final class ErrorReporter {
    static let shared = ErrorReporter()

    private var buffer: [[String: Any]] = []
    private let lock = NSLock()
    private var flushTask: Task<Void, Never>?

    private let maxBuffer = 10
    private let flushInterval: TimeInterval = 30

    // Thread-safe user info from UserDefaults (avoids @MainActor isolation on APIService)
    private var _cachedUserId: String? {
        guard let data = UserDefaults.standard.data(forKey: "rd_user"),
              let user = try? JSONDecoder().decode(User.self, from: data) else { return nil }
        return user.id
    }
    private var _cachedUserRole: String? {
        guard let data = UserDefaults.standard.data(forKey: "rd_user"),
              let user = try? JSONDecoder().decode(User.self, from: data) else { return nil }
        return user.role
    }

    private init() {
        startFlushLoop()
    }

    // MARK: - Public API

    /// Report a network/API error with endpoint context.
    func reportAPIError(_ error: Error, endpoint: String, statusCode: Int? = nil, context: String = "") {
        enqueue(
            message: error.localizedDescription,
            context: context.isEmpty ? endpoint : "\(endpoint) — \(context)",
            stack: String(describing: error),
            endpoint: endpoint,
            statusCode: statusCode
        )
    }

    /// Report a decode error with the raw response for debugging.
    func reportDecodeError(_ error: Error, endpoint: String, rawPrefix: String = "") {
        let detail: String
        if let decodingError = error as? DecodingError {
            switch decodingError {
            case .typeMismatch(let type, let ctx):
                detail = "TypeMismatch: \(type) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
            case .valueNotFound(let type, let ctx):
                detail = "ValueNotFound: \(type) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
            case .keyNotFound(let key, _):
                detail = "KeyNotFound: \(key.stringValue)"
            case .dataCorrupted(let ctx):
                detail = "DataCorrupted: \(ctx.debugDescription)"
            @unknown default:
                detail = String(describing: decodingError)
            }
        } else {
            detail = String(describing: error)
        }

        enqueue(
            message: "Decode error: \(detail)",
            context: endpoint,
            stack: rawPrefix.isEmpty ? detail : "\(detail)\nraw: \(rawPrefix)",
            endpoint: endpoint,
            statusCode: nil
        )
    }

    /// Report a general error from any view or service.
    func report(_ message: String, context: String = "", error: Error? = nil) {
        enqueue(
            message: message,
            context: context,
            stack: error.map { String(describing: $0) } ?? "",
            endpoint: nil,
            statusCode: nil
        )
    }

    // MARK: - Internal

    private func enqueue(message: String, context: String, stack: String, endpoint: String?, statusCode: Int?) {
        let entry: [String: Any] = [
            "source":     "ios",
            "timestamp":  ISO8601DateFormatter().string(from: Date()),
            "message":    String(message.prefix(2000)),
            "context":    String(context.prefix(500)),
            "stack":      String(stack.prefix(4000)),
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?",
            "osVersion":  UIDevice.current.systemVersion,
            "device":     UIDevice.current.model,
            "userId":     _cachedUserId as Any,
            "userRole":   _cachedUserRole as Any,
            "endpoint":   endpoint as Any,
            "statusCode": statusCode as Any,
        ]

        lock.lock()
        buffer.append(entry)
        let shouldFlush = buffer.count >= maxBuffer
        lock.unlock()

        if shouldFlush {
            Task { await flush() }
        }
    }

    private func startFlushLoop() {
        flushTask = Task.detached(priority: .utility) { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self?.flushInterval ?? 30))
                await self?.flush()
            }
        }
    }

    private func flush() async {
        lock.lock()
        guard !buffer.isEmpty else { lock.unlock(); return }
        let batch = buffer
        buffer = []
        lock.unlock()

        // Fire-and-forget POST to server
        guard let url = URL(string: "\(apiBase)/api/admin/client-errors") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 10
        req.httpBody = try? JSONSerialization.data(withJSONObject: batch)

        _ = try? await URLSession.shared.data(for: req)
    }
}
