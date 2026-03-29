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
    @EnvironmentObject var api: APIService

    var body: some View {
        TabView {
            HomeView()
                .tabItem {
                    Label("Inicio", systemImage: "house.fill")
                }
            BrowseView()
                .tabItem {
                    Label("Explorar", systemImage: "magnifyingglass")
                }
            FeedView()
                .tabItem {
                    Label("Feed", systemImage: "newspaper.fill")
                }
            ProfileView()
                .tabItem {
                    Label("Perfil", systemImage: "person.circle.fill")
                }
        }
        .tint(Color.rdBlue)
    }
}
