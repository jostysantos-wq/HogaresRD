import SwiftUI

// MARK: - Brand Colors
//
// Brand tokens adapt to light + dark mode via UITraitCollection. Avoid
// hard-coded `Color(red:…)` literals in views — they ignore Dark Mode and
// produce invisible text on dark backgrounds. If you need a new tonal
// step, add it here so it updates everywhere at once.
//
// The original `Color.rdBlue/Red/Green/Bg/Orange/Purple/Teal` palette is
// kept here verbatim — 800+ call sites depend on these exact RGB values.
// New "ink/surface/line/muted" tokens encode the editorial cream + ink
// palette used by the iOS app's wallet-style cards and lists.
extension Color {
    // ── Original brand palette (do not alter RGB) ──
    static let rdBlue  = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.36, green: 0.56, blue: 0.96, alpha: 1)
            : UIColor(red: 0.0,  green: 0.22, blue: 0.66, alpha: 1)
    })
    static let rdRed   = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.97, green: 0.36, blue: 0.40, alpha: 1)
            : UIColor(red: 0.81, green: 0.08, blue: 0.17, alpha: 1)
    })
    static let rdGreen = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.36, green: 0.78, blue: 0.55, alpha: 1)
            : UIColor(red: 0.11, green: 0.48, blue: 0.24, alpha: 1)
    })
    static let rdBg    = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.10, blue: 0.16, alpha: 1)
            : UIColor(red: 0.95, green: 0.96, blue: 1.00, alpha: 1)
    })

    // ── Status palette tokens (adaptive) ──
    // Used by application/status pills throughout the app. Shipping
    // dark-mode variants here keeps the badges legible on dark
    // backgrounds. Names mirror the semantic meaning, not the hue.
    static let rdOrange = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.99, green: 0.62, blue: 0.18, alpha: 1)
            : UIColor(red: 0.85, green: 0.47, blue: 0.02, alpha: 1)
    })
    static let rdPurple = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.74, green: 0.46, blue: 0.95, alpha: 1)
            : UIColor(red: 0.55, green: 0.24, blue: 0.78, alpha: 1)
    })
    static let rdTeal = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.36, green: 0.80, blue: 0.80, alpha: 1)
            : UIColor(red: 0.18, green: 0.60, blue: 0.60, alpha: 1)
    })

    // ── Editorial neutral palette (adaptive) ──
    //
    // The wallet-card / list rows / form cards across the app are
    // rendered against a cream surface with near-black ink. In dark mode
    // we swap so cream becomes the ink and a deep charcoal becomes the
    // surface. The light-mode hex anchors come straight from the design
    // mock (ink #131318, cream #F4F2EB).

    /// Near-black "ink" used for headlines, primary buttons, and active
    /// tab pills. Swaps to cream in dark mode.
    static let rdInk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xF4 / 255.0, green: 0xF2 / 255.0, blue: 0xEB / 255.0, alpha: 1)
            : UIColor(red: 0x13 / 255.0, green: 0x13 / 255.0, blue: 0x18 / 255.0, alpha: 1)
    })

    /// Softer ink (~70% opacity baked in) — secondary labels, inactive
    /// tab icons, captions that should stay legible without competing
    /// with primary content.
    static let rdInkSoft = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xF4 / 255.0, green: 0xF2 / 255.0, blue: 0xEB / 255.0, alpha: 0.70)
            : UIColor(red: 0x13 / 255.0, green: 0x13 / 255.0, blue: 0x18 / 255.0, alpha: 0.70)
    })

    /// Cream surface — primary background for cards, identity tiles,
    /// form sections. Inverts to a dark charcoal panel in dark mode.
    static let rdSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x1E / 255.0, green: 0x1E / 255.0, blue: 0x22 / 255.0, alpha: 1)
            : UIColor(red: 0xF4 / 255.0, green: 0xF2 / 255.0, blue: 0xEB / 255.0, alpha: 1)
    })

    /// Slightly tinted variant of `rdSurface` — used for nested rows or
    /// muted card backgrounds where stacking on `rdSurface` requires a
    /// subtle separation.
    static let rdSurfaceMuted = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x26 / 255.0, green: 0x26 / 255.0, blue: 0x2A / 255.0, alpha: 1)
            : UIColor(red: 0xEB / 255.0, green: 0xE8 / 255.0, blue: 0xDD / 255.0, alpha: 1)
    })

    /// Hairline divider — ink at 12% in light, cream at 18% in dark so
    /// it stays just visible against the corresponding surface.
    static let rdLine = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xF4 / 255.0, green: 0xF2 / 255.0, blue: 0xEB / 255.0, alpha: 0.18)
            : UIColor(red: 0x13 / 255.0, green: 0x13 / 255.0, blue: 0x18 / 255.0, alpha: 0.12)
    })

    /// Mid-gray placeholder — used by skeleton shimmer and other
    /// "pending content" treatments where neither ink nor surface is
    /// appropriate.
    static let rdMuted = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x7C / 255.0, green: 0x7B / 255.0, blue: 0x78 / 255.0, alpha: 1)
            : UIColor(red: 0x9C / 255.0, green: 0x99 / 255.0, blue: 0x94 / 255.0, alpha: 1)
    })

    // ── Accent synonyms ──
    // These let downstream code reach for a "primary accent" without
    // baking in a specific brand color. We currently route them all to
    // `rdInk` because the editorial design uses ink-on-cream as the
    // primary CTA — change here to re-skin globally.
    static var rdAccent: Color { rdInk }
    static var rdAccentSoft: Color { rdInkSoft }
}

// MARK: - Spacing

/// Canonical spacing scale. Use these instead of magic numbers like
/// `padding(14)` so the rhythm stays consistent across screens.
enum Spacing {
    /// 4pt — hairline gap between tightly coupled elements.
    static let s4: CGFloat = 4
    /// 8pt — chip gap, micro padding.
    static let s8: CGFloat = 8
    /// 12pt — control-internal padding.
    static let s12: CGFloat = 12
    /// 16pt — default card padding and section gutter.
    static let s16: CGFloat = 16
    /// 24pt — between independent sections on the same screen.
    static let s24: CGFloat = 24
    /// 32pt — page-top breathing room and hero gaps.
    static let s32: CGFloat = 32
}

// MARK: - Radius

/// Canonical corner radii. `large` and `xlarge` use `.continuous` style
/// where applied so they read as wallet-card squircles, not perfect
/// circles.
enum Radius {
    /// 8pt — chips, tiny pills, status badges.
    static let small: CGFloat = 8
    /// 12pt — primary buttons, tile fills.
    static let medium: CGFloat = 12
    /// 20pt — cards, identity tiles, empty-state panels.
    static let large: CGFloat = 20
    /// 28pt — hero cards, full-width banners.
    static let xlarge: CGFloat = 28
}
