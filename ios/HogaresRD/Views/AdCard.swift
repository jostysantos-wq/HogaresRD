import SwiftUI

/// Full-screen sponsored card shown every 5 listings in the Feed.
struct AdCard: View {
    let ad: Ad
    var onImpression: () -> Void = { }
    var onTap:        () -> Void = { }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {

                // ── Background image ───────────────────────────────────
                if let url = ad.imageURL {
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().aspectRatio(contentMode: .fill)
                        default:
                            adPlaceholder
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                } else {
                    adPlaceholder
                        .frame(width: geo.size.width, height: geo.size.height)
                }

                // ── Tap target (opens URL) ─────────────────────────────
                Button { onTap() } label: {
                    Color.clear
                        .frame(width: geo.size.width, height: geo.size.height)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // ── "Publicidad" badge (top-left) ──────────────────────
                VStack {
                    HStack {
                        Text("Publicidad")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white.opacity(0.85))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(.ultraThinMaterial.opacity(0.8))
                            .clipShape(Capsule())
                            .padding(.top, 52)
                            .padding(.leading, 16)
                        Spacer()
                    }
                    Spacer()
                }

                // ── Gradient scrim ─────────────────────────────────────
                LinearGradient(
                    colors: [
                        .black.opacity(0.80),
                        .black.opacity(0.45),
                        .black.opacity(0.05),
                        .clear
                    ],
                    startPoint: .bottom,
                    endPoint: .init(x: 0.5, y: 0.45)
                )
                .allowsHitTesting(false)

                // ── Text overlay ───────────────────────────────────────
                VStack(alignment: .leading, spacing: 8) {
                    if let advertiser = ad.advertiser, !advertiser.isEmpty {
                        Text(advertiser.uppercased())
                            .font(.caption2.weight(.heavy))
                            .foregroundStyle(Color.rdBlue)
                            .tracking(1.5)
                    }

                    Text(ad.title)
                        .font(.title3.weight(.heavy))
                        .foregroundStyle(.white)
                        .lineLimit(3)
                        .shadow(color: .black.opacity(0.5), radius: 4)

                    // CTA row
                    HStack(spacing: 6) {
                        Spacer()
                        Text("Ver oferta")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(.white)
                        Image(systemName: "arrow.up.right")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(.white)
                    }
                    .padding(.top, 2)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 110)
                .allowsHitTesting(false)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
            .onAppear { onImpression() }
        }
    }

    private var adPlaceholder: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.0, green: 0.22, blue: 0.66),
                         Color(red: 0.0, green: 0.10, blue: 0.28)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            Image(systemName: "megaphone.fill")
                .font(.system(size: 60))
                .foregroundStyle(.white.opacity(0.15))
        }
    }
}
