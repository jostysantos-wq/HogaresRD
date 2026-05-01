import SwiftUI

// MARK: - EmptyStateView
//
// Convenience factories around `ContentUnavailableView` (iOS 17+).
// Three flavors so callers don't have to pick the right tone each
// time:
//
//   • `.calm`           — generic "nothing here yet" with optional CTA.
//   • `.filterCleared`  — user filtered to zero results; offers a
//                         "Clear filters" action.
//   • `.celebratory`    — user reached an inbox-zero / task-zero state
//                         and we want to congratulate them.
//
// All three return a real `ContentUnavailableView` so VoiceOver picks
// up the heading semantics correctly.

enum EmptyStateView {
    /// Generic empty state with an optional CTA button.
    @ViewBuilder
    static func calm(
        systemImage: String,
        title: String,
        description: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(Color.rdInk)
            }
        }
    }

    /// "No results match your filter" state — single button to clear.
    static func filterCleared(
        systemImage: String = "line.3.horizontal.decrease.circle",
        title: String,
        description: String,
        onClear: @escaping () -> Void
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            Button("Limpiar filtros", action: onClear)
                .buttonStyle(.bordered)
                .tint(Color.rdInk)
        }
    }

    /// Celebratory inbox-zero state — no CTA, just affirmation.
    static func celebratory(
        systemImage: String = "sparkles",
        title: String,
        description: String
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
                .foregroundStyle(Color.rdGreen)
        } description: {
            Text(description)
        }
    }
}

#Preview("EmptyStateView – calm") {
    EmptyStateView.calm(
        systemImage: "tray",
        title: "Sin notificaciones",
        description: "Cuando recibas mensajes nuevos aparecerán aquí.",
        actionTitle: "Refrescar",
        action: {}
    )
}

#Preview("EmptyStateView – filterCleared") {
    EmptyStateView.filterCleared(
        title: "Sin resultados",
        description: "Ningún listado coincide con tus filtros actuales.",
        onClear: {}
    )
}

#Preview("EmptyStateView – celebratory") {
    EmptyStateView.celebratory(
        title: "¡Todo al día!",
        description: "Has revisado todas las solicitudes pendientes."
    )
}
