import SwiftUI

// MARK: - ToastBanner
//
// Capsule-shaped status banner that slides in from the top. Used for
// short-lived confirmations ("Guardado", "Mensaje enviado") and
// non-blocking errors that don't warrant an alert.
//
// Usage:
//   .toast(toast, isPresented: $showToast)
// where `toast` is a `ToastBanner.Style` describing the message and
// tint. Auto-dismisses after 3 seconds.

struct ToastBanner: View {
    enum Style {
        case success(String)
        case info(String)
        case error(String)

        var label: String {
            switch self {
            case .success(let s), .info(let s), .error(let s): return s
            }
        }

        var systemImage: String {
            switch self {
            case .success: return "checkmark.circle.fill"
            case .info: return "info.circle.fill"
            case .error: return "exclamationmark.triangle.fill"
            }
        }

        var tint: Color {
            switch self {
            case .success: return .rdGreen
            case .info: return .rdBlue
            case .error: return .rdRed
            }
        }
    }

    let style: Style

    var body: some View {
        HStack(spacing: Spacing.s8) {
            Image(systemName: style.systemImage)
                .foregroundStyle(style.tint)
                .accessibilityHidden(true)
            Text(style.label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.rdInk)
                .lineLimit(2)
        }
        .padding(.horizontal, Spacing.s16)
        .padding(.vertical, Spacing.s12)
        .background(
            Capsule(style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(Color.rdLine, lineWidth: 1)
                )
        )
        .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(style.label)
    }
}

// MARK: - Modifier

private struct ToastModifier: ViewModifier {
    let style: ToastBanner.Style?
    @Binding var isPresented: Bool
    var duration: TimeInterval = 3

    func body(content: Content) -> some View {
        ZStack(alignment: .top) {
            content
            if isPresented, let style {
                ToastBanner(style: style)
                    .padding(.top, Spacing.s8)
                    .padding(.horizontal, Spacing.s16)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
                        withAnimation(.easeInOut(duration: 0.25)) {
                            isPresented = false
                        }
                    }
                    .zIndex(10)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: isPresented)
    }
}

extension View {
    /// Present a top toast banner. Pass nil to clear without animation.
    func toast(_ style: ToastBanner.Style?, isPresented: Binding<Bool>) -> some View {
        modifier(ToastModifier(style: style, isPresented: isPresented))
    }
}

#Preview("Toast") {
    struct Demo: View {
        @State private var showSuccess = true
        var body: some View {
            ZStack { Color.rdBg.ignoresSafeArea() }
                .toast(.success("Guardado correctamente"), isPresented: $showSuccess)
        }
    }
    return Demo()
}
