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

    @State private var selectedTab  = 0
    @State private var previousTab  = 0
    @State private var showPost     = false

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                FeedView()
                    .tabItem { Label("Feed",    systemImage: "newspaper.fill") }
                    .tag(0)
                HomeView()
                    .tabItem { Label("Inicio",  systemImage: "house.fill") }
                    .tag(1)
                // Centre placeholder — intercepted before it ever displays
                Color.clear
                    .tabItem { Label("Publicar", systemImage: "plus") }
                    .tag(2)
                BrowseView()
                    .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                    .tag(3)
                ProfileView()
                    .tabItem { Label("Perfil",  systemImage: "person.circle.fill") }
                    .tag(4)
            }
            .tint(Color.rdBlue)
            .onChange(of: selectedTab) { _, new in
                if new == 2 {
                    selectedTab = previousTab   // snap back immediately
                    showPost    = true
                } else {
                    previousTab = new
                }
            }

            // ── Instagram-style centre button ──────────────────────
            Button {
                showPost = true
            } label: {
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [Color.rdBlue, Color.rdBlue.opacity(0.75)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 52, height: 52)
                        .shadow(color: Color.rdBlue.opacity(0.45), radius: 8, y: 3)
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .offset(y: -14)   // lift above tab bar
        }
        .sheet(isPresented: $showPost) {
            SubmitListingView()
                .environmentObject(api)
        }
    }
}
