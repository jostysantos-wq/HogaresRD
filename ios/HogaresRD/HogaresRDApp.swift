import SwiftUI

@main
struct HogaresRDApp: App {
    @StateObject private var api = APIService.shared
    @AppStorage("appColorScheme") private var schemePref: String = "system"

    private var preferredScheme: ColorScheme? {
        switch schemePref {
        case "dark":  return .dark
        case "light": return .light
        default:      return nil
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(api)
                .preferredColorScheme(preferredScheme)
        }
    }
}
