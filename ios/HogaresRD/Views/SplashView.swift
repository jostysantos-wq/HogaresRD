import SwiftUI

/// Animated splash screen shown while the app initializes.
/// Matches the HogaresRD brand: Dominican flag colors, palm + bohío mark.
struct SplashView: View {
    @State private var logoScale:    CGFloat = 0.6
    @State private var logoOpacity:  Double  = 0
    @State private var textOpacity:  Double  = 0
    @State private var taglineOpacity: Double = 0
    @State private var shimmerOffset: CGFloat = -200

    var body: some View {
        ZStack {
            // Background gradient — dark navy to DR blue
            LinearGradient(
                colors: [
                    Color(red: 0, green: 0.04, blue: 0.14),
                    Color(red: 0, green: 0.11, blue: 0.38),
                    Color(red: 0, green: 0.07, blue: 0.24),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // ── Logo Mark ────────────────────────────────────────
                ZStack {
                    // Subtle glow behind the logo
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [Color.white.opacity(0.06), .clear],
                                center: .center,
                                startRadius: 20,
                                endRadius: 100
                            )
                        )
                        .frame(width: 200, height: 200)

                    // Palm + bohío icon (matching LogoMark from Expo app)
                    VStack(spacing: 0) {
                        // Palm fronds
                        Image(systemName: "leaf.fill")
                            .font(.system(size: 44, weight: .medium))
                            .foregroundStyle(Color(red: 0.81, green: 0.07, blue: 0.15)) // DR Red
                            .rotationEffect(.degrees(-15))
                            .offset(y: 8)

                        // House
                        Image(systemName: "house.fill")
                            .font(.system(size: 52, weight: .regular))
                            .foregroundStyle(.white)
                    }
                }
                .scaleEffect(logoScale)
                .opacity(logoOpacity)

                Spacer().frame(height: 28)

                // ── Brand Name ───────────────────────────────────────
                VStack(spacing: 4) {
                    Text("hogares")
                        .font(.system(size: 36, weight: .light, design: .default))
                        .tracking(4)
                        .foregroundStyle(.white)
                    +
                    Text("RD")
                        .font(.system(size: 36, weight: .black, design: .default))
                        .foregroundStyle(Color(red: 0.81, green: 0.07, blue: 0.15))
                }
                .opacity(textOpacity)

                Spacer().frame(height: 12)

                // ── Tagline ──────────────────────────────────────────
                Text("Bienes raices en Republica Dominicana")
                    .font(.system(size: 13, weight: .medium))
                    .tracking(1)
                    .foregroundStyle(.white.opacity(0.5))
                    .opacity(taglineOpacity)

                Spacer()

                // ── Bottom shimmer bar ───────────────────────────────
                ZStack {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(.white.opacity(0.08))
                        .frame(width: 160, height: 3)

                    RoundedRectangle(cornerRadius: 2)
                        .fill(
                            LinearGradient(
                                colors: [.clear, .white.opacity(0.4), .clear],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: 60, height: 3)
                        .offset(x: shimmerOffset)
                        .mask(
                            RoundedRectangle(cornerRadius: 2)
                                .frame(width: 160, height: 3)
                        )
                }
                .padding(.bottom, 80)
            }
        }
        .onAppear {
            // Logo entrance
            withAnimation(.spring(response: 0.7, dampingFraction: 0.7)) {
                logoScale = 1.0
                logoOpacity = 1.0
            }

            // Brand text fade in
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                textOpacity = 1.0
            }

            // Tagline fade in
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                taglineOpacity = 1.0
            }

            // Shimmer loop
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                shimmerOffset = 200
            }
        }
    }
}
