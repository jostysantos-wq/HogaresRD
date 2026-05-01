import SwiftUI

// MARK: - Shimmer
//
// Lightweight loading shimmer for `redacted` placeholder views. Drop
// `.shimmer()` after `.redacted(reason: .placeholder)` to get the
// horizontal-sweep gradient highlight that signals "loading" without
// blocking the main thread on a `ProgressView`.

private struct ShimmerModifier: ViewModifier {
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay(
                GeometryReader { proxy in
                    let gradient = LinearGradient(
                        gradient: Gradient(stops: [
                            .init(color: Color.rdMuted.opacity(0.15), location: 0.0),
                            .init(color: Color.rdMuted.opacity(0.35), location: 0.5),
                            .init(color: Color.rdMuted.opacity(0.15), location: 1.0)
                        ]),
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    Rectangle()
                        .fill(gradient)
                        .frame(width: proxy.size.width * 1.5, height: proxy.size.height)
                        .offset(x: phase * proxy.size.width)
                        .blendMode(.plusLighter)
                        .allowsHitTesting(false)
                }
                .mask(content)
            )
            .onAppear {
                withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) {
                    phase = 1.5
                }
            }
            .accessibilityHidden(true)
    }
}

extension View {
    /// Animated linear-gradient sweep, intended to be paired with
    /// `.redacted(reason: .placeholder)`. Self-contained — no need to
    /// pass timing parameters.
    func shimmer() -> some View {
        modifier(ShimmerModifier())
    }
}

#Preview("Shimmer") {
    VStack(alignment: .leading, spacing: Spacing.s12) {
        Text("Cargando contenido…")
            .font(.headline)
            .redacted(reason: .placeholder)
            .shimmer()
        Text("Subtítulo cargando")
            .font(.subheadline)
            .redacted(reason: .placeholder)
            .shimmer()
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.rdSurface)
}
