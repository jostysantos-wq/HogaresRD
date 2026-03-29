import SwiftUI

@main
struct HogaresRDApp: App {
    @StateObject private var api = APIService.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(api)
        }
    }
}
