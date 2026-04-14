import SwiftUI

/// Full-screen sponsored card shown every 5 listings in the Feed.
/// The ad image (typically 1200×628 landscape) is displayed at its natural
/// aspect ratio centered vertically, with a dark branded background filling
/// the rest of the reel-height card. This avoids the zoomed/blurry look
/// that .scaledToFill caused with landscape images in a portrait frame.
struct AdCard: View {
    let ad: Ad
    var onImpression: () -> Void = { }
    var onTap:        () -> Void = { }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Dark branded background
                LinearGradient(
                    colors: [Color(red: 0.02, green: 0.05, blue: 0.15),
                             Color(red: 0.0, green: 0.14, blue: 0.42)],
                    startPoint: .top, endPoint: .bottom
                )

                // Centered ad image at natural aspect ratio
                VStack(spacing: 0) {
                    Spacer()

                    if let url = ad.imageURL {
                        CachedAsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .shadow(color: .black.opacity(0.4), radius: 20, y: 8)
                            default:
                                adPlaceholderImage
                            }
                        }
                        .padding(.horizontal, 16)
                    } else {
                        adPlaceholderImage
                            .padding(.horizontal, 16)
                    }

                    Spacer()
                }

                // Tap target
                Button { onTap() } label: {
                    Color.clear
                        .frame(width: geo.size.width, height: geo.size.height)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // "Publicidad" badge (top-left)
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

                // Bottom text overlay
                VStack(alignment: .leading, spacing: 8) {
                    Spacer()

                    if let advertiser = ad.advertiser, !advertiser.isEmpty {
                        Text(advertiser.uppercased())
                            .font(.caption2.weight(.heavy))
                            .foregroundStyle(Color.rdBlue.opacity(0.9))
                            .tracking(1.5)
                    }

                    Text(ad.title)
                        .font(.title3.weight(.heavy))
                        .foregroundStyle(.white)
                        .lineLimit(3)
                        .shadow(color: .black.opacity(0.5), radius: 4)

                    if let desc = ad.description, !desc.isEmpty {
                        Text(desc)
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.75))
                            .lineLimit(2)
                    }

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

    private var adPlaceholderImage: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Color.white.opacity(0.08))
            .frame(height: 200)
            .overlay(
                Image(systemName: "megaphone.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.white.opacity(0.15))
            )
    }
}
