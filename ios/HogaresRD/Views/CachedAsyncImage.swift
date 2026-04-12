import SwiftUI

// MARK: - Image Cache

final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSURL, UIImage>()

    private init() {
        cache.countLimit = 200
        cache.totalCostLimit = 100 * 1024 * 1024 // 100 MB
    }

    func get(_ url: URL) -> UIImage? {
        cache.object(forKey: url as NSURL)
    }

    func set(_ url: URL, image: UIImage) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        cache.setObject(image, forKey: url as NSURL, cost: cost)
    }
}

// MARK: - CachedAsyncImage

/// Drop-in replacement for `AsyncImage` that caches downloaded images
/// in memory via `NSCache`. Prevents re-downloads when scrolling back
/// through lists or navigating between tabs.
struct CachedAsyncImage<Content: View>: View {
    let url: URL?
    let content: (AsyncImagePhase) -> Content

    @State private var phase: AsyncImagePhase = .empty
    @State private var loadTask: Task<Void, Never>?

    init(url: URL?, @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {
        self.url = url
        self.content = content
    }

    var body: some View {
        content(phase)
            .onAppear { load() }
            .onChange(of: url) { _, _ in load() }
            .onDisappear { loadTask?.cancel() }
    }

    private func load() {
        loadTask?.cancel()

        guard let url else {
            phase = .empty
            return
        }

        // Serve from cache immediately — no network hit
        if let cached = ImageCache.shared.get(url) {
            phase = .success(Image(uiImage: cached))
            return
        }

        phase = .empty
        loadTask = Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                guard !Task.isCancelled else { return }
                if let uiImage = UIImage(data: data) {
                    ImageCache.shared.set(url, image: uiImage)
                    await MainActor.run {
                        phase = .success(Image(uiImage: uiImage))
                    }
                } else {
                    await MainActor.run { phase = .empty }
                }
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run { phase = .failure(error) }
            }
        }
    }
}
