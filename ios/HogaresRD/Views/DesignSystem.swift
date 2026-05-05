import SwiftUI

// MARK: - Design System primitives
//
// Cross-screen tokens used everywhere. The goal is *Hierarchy,
// Harmony, Consistency* — Apple's three pillars for the new system
// design (iOS 26 / Liquid Glass). Every screen should reach for
// these primitives instead of hand-rolling its own animations,
// empty states, or motion timing.
//
// Usage:
//   .animation(Motion.snappy, value: someState)   // button feedback
//   .animation(Motion.layout, value: filter)      // segmented swap
//   ContentUnavailableView(...)                    // empty states
//   .listSectionHeader(.serifAccent)               // hero titles only

// MARK: - Motion
//
// Four named curves. Use these instead of raw `.spring(...)` /
// `.easeInOut(duration:)` calls so timing stays consistent across
// surfaces. Numbers chosen to feel responsive without being jumpy:
// nothing > 350 ms, nothing < 100 ms.

enum Motion {
    /// Primary interactive feedback — button taps, card presses,
    /// pill toggles. Snappy spring with light dampening so the
    /// element settles quickly.
    static let snappy = Animation.interpolatingSpring(stiffness: 260, damping: 24)

    /// Content arrival — list rows materialising, cards sliding in
    /// from a sheet dismissal, hero KPIs counting up. Slightly
    /// softer spring so multiple elements arriving together feel
    /// orchestrated rather than chaotic.
    static let arrival = Animation.spring(response: 0.45, dampingFraction: 0.82)

    /// Layout swap — segmented controls, filter chip selection,
    /// tab content transitioning. Quick ease-in-out under 250 ms
    /// so the user's eye isn't tracked across a long curve.
    static let layout = Animation.easeInOut(duration: 0.22)

    /// Fade — banners, toast errors, hint visibility, popovers.
    /// Shorter than `layout` because opacity changes are perceived
    /// faster than position changes.
    static let fade = Animation.easeInOut(duration: 0.18)
}

// MARK: - Typography
//
// We keep nearly everything on the system sans (San Francisco) so
// the app harmonises with iOS chrome. The serif accent (Cormorant
// via system .serif) is reserved for *hero* titles only — the
// floating-avatar profile name, the donut center label, large
// editorial titles. Anywhere else uses the system sans.
//
// `.heroSerif` is a single small modifier so it's hard to misuse.

extension View {
    /// Apply only to hero titles (large, anchor-of-screen). Body
    /// copy, row labels, and section eyebrows must NOT use this.
    func heroSerif(size: CGFloat = 28, weight: Font.Weight = .semibold) -> some View {
        self.font(.system(size: size, weight: weight, design: .serif))
    }
}

// MARK: - Empty / Error states
//
// We standardise on the system `ContentUnavailableView` (iOS 17+).
// It's a one-liner that already renders the right hierarchy,
// supports actions, integrates with Liquid Glass, and inherits
// the user's Dynamic Type + accent settings. Custom VStack
// empty states are forbidden going forward — every "Sin X"
// surface should use the helpers below or call
// ContentUnavailableView directly.

struct EmptyState {
    /// Lightweight wrapper so call sites are concise. Pick this
    /// when there's no useful action — pure "nothing here yet".
    static func plain(
        title: LocalizedStringKey,
        systemImage: String,
        description: LocalizedStringKey
    ) -> some View {
        ContentUnavailableView(title, systemImage: systemImage, description: Text(description))
    }

    /// Empty state with a primary action button. Generic parameter
    /// name avoids shadowing SwiftUI's `Label` view inside the body.
    static func actionable<Action: View>(
        title: LocalizedStringKey,
        systemImage: String,
        description: LocalizedStringKey,
        @ViewBuilder action: () -> Action
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            action()
        }
    }
}
