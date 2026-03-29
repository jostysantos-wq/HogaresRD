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
            HomeView()
                .tabItem { Label("Inicio",   systemImage: "house.fill") }
                .tag(1)
            // Centre slot — intercepted by onChange, never displays content
            Color.clear
                .tabItem { Label("Publicar", systemImage: "plus.circle.fill") }
                .tag(2)
            BrowseView()
                .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                .tag(3)
            ProfileView()
                .tabItem { Label("Perfil",   systemImage: "person.circle.fill") }
                .tag(4)
        }
        .tint(Color.rdBlue)
        // Intercept centre-tab tap → show post sheet, snap back to previous tab
        .onChange(of: selectedTab) { _, new in
            if new == 2 {
                selectedTab = previousTab
                showPost    = true
            } else {
                previousTab = new
            }
        }
        .sheet(isPresented: $showPost) {
            SubmitListingView().environmentObject(api)
        }
    }
}
