import CoreLocation
import Combine

final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    @Published var location:    CLLocationCoordinate2D? = nil
    @Published var authStatus:  CLAuthorizationStatus  = .notDetermined

    override init() {
        super.init()
        manager.delegate           = self
        manager.desiredAccuracy    = kCLLocationAccuracyHundredMeters
        authStatus                 = manager.authorizationStatus
    }

    /// True when the user has explicitly denied or restricted location.
    var isDeniedOrRestricted: Bool {
        authStatus == .denied || authStatus == .restricted
    }

    func requestLocation() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        default:
            break
        }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager,
                         didUpdateLocations locations: [CLLocation]) {
        location = locations.last?.coordinate
    }

    func locationManager(_ manager: CLLocationManager,
                         didFailWithError error: Error) {
        // Silently swallow – user may simply be in a simulator
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authStatus = manager.authorizationStatus
        if authStatus == .authorizedWhenInUse || authStatus == .authorizedAlways {
            manager.requestLocation()
        }
    }
}
