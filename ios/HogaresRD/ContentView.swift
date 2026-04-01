import SwiftUI

// MARK: - Brand Colors
extension Color {
    static let rdBlue  = Color(red: 0/255,  green: 56/255,  blue: 168/255)
    static let rdRed   = Color(red: 207/255, green: 20/255,  blue: 43/255)
    static let rdGreen = Color(red: 27/255,  green: 122/255, blue: 62/255)
    static let rdBg    = Color(red: 242/255, green: 246/255, blue: 255/255)
}

// MARK: - Root Tab View

struct ContentView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore

    @State private var selectedTab = 0
    @State private var previousTab = 0
    @State private var showPost    = false

    var body: some View {
        TabView(selection: $selectedTab) {
            FeedView()
                .tabItem { Label("Feed",     systemImage: "newspaper.fill") }
                .tag(0)
            BrowseView()
                .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                .tag(1)
            // Centre slot — intercepted by onChange, never displays content
            Color.clear
                .tabItem { Label("Publicar", systemImage: "plus.circle.fill") }
                .tag(2)
            NotificationsView()
                .tabItem { Label("Alertas",  systemImage: "bell.fill") }
                .tag(3)
        }
        .tint(Color.rdBlue)
        .onChange(of: selectedTab) { _, new in
            if new == 2 {
                selectedTab = previousTab
                showPost    = true
            } else {
                previousTab = new
            }
            // Re-stamp red after every change so the glass bar never resets it
            applyPublicarTint()
        }
        // Paint the Publicar tab item red via UIKit (SwiftUI tint is all-or-nothing)
        .onAppear { applyPublicarTint() }
        .sheet(isPresented: $showPost) {
            SubmitListingView().environmentObject(api)
        }
    }

    // MARK: - Per-item tint

    private func applyPublicarTint() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let root  = scene.windows.first?.rootViewController,
                  let tbc   = firstTabBarController(in: root),
                  (tbc.tabBar.items?.count ?? 0) > 2 else { return }

            let red = UIColor(Color.rdRed)
            let cfg = UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold)
            let img = UIImage(systemName: "plus.circle.fill", withConfiguration: cfg)?
                          .withTintColor(red, renderingMode: .alwaysOriginal)
            tbc.tabBar.items?[2].image         = img
            tbc.tabBar.items?[2].selectedImage = img
        }
    }

    private func firstTabBarController(in vc: UIViewController) -> UITabBarController? {
        if let tbc = vc as? UITabBarController { return tbc }
        return vc.children.compactMap { firstTabBarController(in: $0) }.first
    }
}
