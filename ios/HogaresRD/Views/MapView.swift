import SwiftUI
import MapKit
import CoreLocation

// MARK: - MapStateStore  (bridges UIKit region changes → SwiftUI pin positions)
final class MapStateStore: ObservableObject {
    weak var mapView: MKMapView?

    /// Screen positions for pins, computed from the live MKMapView whenever
    /// the region changes.  Driving this from the UIKit callback guarantees
    /// the map already has proper bounds when we call convert(_:toPointTo:).
    @Published var pinScreenPositions: [(Listing, CGPoint)] = []

    /// Re-compute visible pin screen positions. Uses a fast lat/lng bounding-box
    /// pre-filter so we only call the expensive `convert(_:toPointTo:)` on pins
    /// that could possibly be in the viewport — 20→50 pins instead of all 200+.
    func refresh(listings: [Listing]) {
        guard let mv = mapView else { return }
        let region = mv.region
        let halfLat = region.span.latitudeDelta / 2 * 1.15  // 15% margin
        let halfLng = region.span.longitudeDelta / 2 * 1.15
        let minLat = region.center.latitude  - halfLat
        let maxLat = region.center.latitude  + halfLat
        let minLng = region.center.longitude - halfLng
        let maxLng = region.center.longitude + halfLng

        pinScreenPositions = listings.compactMap { listing in
            guard let lat = listing.lat, let lng = listing.lng else { return nil }
            // Quick lat/lng bounds check — skips expensive convert() for distant pins
            guard lat >= minLat && lat <= maxLat &&
                  lng >= minLng && lng <= maxLng else { return nil }
            let coord = CLLocationCoordinate2D(latitude: lat, longitude: lng)
            let pt    = mv.convert(coord, toPointTo: mv)
            let extended = mv.bounds.insetBy(dx: -20, dy: -20)
            guard extended.contains(pt) else { return nil }
            return (listing, pt)
        }
    }
}

// MARK: - NativeMapView (UIViewRepresentable wrapping MKMapView)
struct NativeMapView: UIViewRepresentable {
    let listings:       [Listing]
    @Binding var selected:     Listing?
    @Binding var centerOnUser: Bool
    var userLocation:          CLLocationCoordinate2D?
    @Binding var targetCoordinate: CLLocationCoordinate2D?
    var targetZoom: Double = 35_000
    @ObservedObject var mapState: MapStateStore

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate          = context.coordinator
        map.showsUserLocation = true
        map.showsCompass      = false
        map.autoresizingMask  = [.flexibleWidth, .flexibleHeight]

        // Store weak reference so MapStateStore can call convert(_:toPointTo:)
        mapState.mapView = map

        // Initial camera — centered on DR with altitude wide enough to show
        // the whole country (Santo Domingo + Santiago + Puerto Plata +
        // Punta Cana + Barahona). Previously used 60km altitude which only
        // showed Santo Domingo metro — listings in Bani, Puerto Plata, etc
        // were off-screen until user manually zoomed out.
        let center = CLLocationCoordinate2D(latitude: 18.735, longitude: -70.163)
        map.camera = MKMapCamera(lookingAtCenter: center,
                                 fromDistance: 400_000, // 400km altitude — shows entire DR
                                 pitch: 0, heading: 0)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        // ── Center on user if requested ──────────────────────────────────
        if centerOnUser {
            DispatchQueue.main.async { self.centerOnUser = false }
            let coord = userLocation ?? CLLocationCoordinate2D(latitude: 18.486, longitude: -69.931)
            map.setRegion(MKCoordinateRegion(center: coord,
                                             latitudinalMeters: 5_000,
                                             longitudinalMeters: 5_000),
                          animated: true)
        }

        // ── Center on target coordinate (search result) ─────────────────
        if let target = targetCoordinate {
            DispatchQueue.main.async { self.targetCoordinate = nil }
            map.setRegion(MKCoordinateRegion(center: target,
                                             latitudinalMeters: targetZoom,
                                             longitudinalMeters: targetZoom),
                          animated: true)
        }

        // Refresh pin positions whenever the listing set changes
        DispatchQueue.main.async {
            self.mapState.refresh(listings: self.listings)
        }
    }

    // MARK: - Coordinator
    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: NativeMapView

        init(_ parent: NativeMapView) { self.parent = parent }

        /// Called after every pan / zoom — recompute pin positions
        func mapView(_ map: MKMapView, regionDidChangeAnimated animated: Bool) {
            DispatchQueue.main.async {
                self.parent.mapState.refresh(listings: self.parent.listings)
            }
        }
        func mapView(_ map: MKMapView, regionWillChangeAnimated animated: Bool) {
            DispatchQueue.main.async {
                self.parent.mapState.refresh(listings: self.parent.listings)
            }
        }
    }
}

// MARK: - ListingAnnotation (kept for future compatibility)
final class ListingAnnotation: NSObject, MKAnnotation {
    let listing:  Listing
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var title: String? { listing.shortPrice }

    init(listing: Listing, coordinate: CLLocationCoordinate2D) {
        self.listing    = listing
        self.coordinate = coordinate
        super.init()
    }
}
