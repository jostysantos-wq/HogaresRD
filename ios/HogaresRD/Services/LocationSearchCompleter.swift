import Foundation
import MapKit
import Combine

// MARK: - Apple-Maps style location completer, biased to Dominican Republic

/// Wraps MKLocalSearchCompleter to power the Explorar tab's location
/// autocomplete. Biased to the Dominican Republic so users searching for
/// a neighbourhood / barrio / sector get the same matches they would in
/// Apple Maps — not just the hardcoded city list.
final class LocationSearchCompleter: NSObject, ObservableObject, MKLocalSearchCompleterDelegate {

    @Published var results: [MKLocalSearchCompletion] = []
    @Published var isSearching: Bool = false

    private let completer: MKLocalSearchCompleter

    override init() {
        self.completer = MKLocalSearchCompleter()
        super.init()
        completer.delegate = self
        // Include addresses + points of interest so users can find both
        // towns ("Lucerna") and specific places ("Sambil Santo Domingo").
        completer.resultTypes = [.address, .pointOfInterest]
        // Bias the search window to the Dominican Republic. Center ≈
        // Santo Domingo, span wide enough to cover the whole island.
        completer.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 18.735693, longitude: -70.162651),
            span: MKCoordinateSpan(latitudeDelta: 4.5, longitudeDelta: 4.5)
        )
    }

    func updateQuery(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            results = []
            isSearching = false
            completer.queryFragment = ""
            return
        }
        isSearching = true
        completer.queryFragment = trimmed
    }

    // MARK: - MKLocalSearchCompleterDelegate

    func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        // Filter to results mentioning the Dominican Republic. MKLocalSearchCompleter's
        // `region` biases but doesn't strictly limit — without this filter we'd
        // pollute the list with similarly-named places in other countries.
        let drResults = completer.results.filter { r in
            let combined = (r.title + " " + r.subtitle).lowercased()
            return combined.contains("dominican") ||
                   combined.contains("república dominicana") ||
                   combined.contains("republica dominicana") ||
                   combined.contains(", rd") ||
                   combined.contains(", do")
        }
        // If the strict filter finds nothing, fall back to raw results —
        // some Apple Maps rows don't label "Dominican Republic" explicitly.
        self.results = drResults.isEmpty ? completer.results : drResults
        self.isSearching = false
    }

    func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        self.results = []
        self.isSearching = false
    }

    // MARK: - Resolve a completion to coordinates

    /// Fire an MKLocalSearch for a completion row and return the primary
    /// map item (coordinate + display name). Called when the user taps a
    /// row so we can recenter the map on the exact place.
    func resolve(_ completion: MKLocalSearchCompletion) async -> MKMapItem? {
        let request = MKLocalSearch.Request(completion: completion)
        request.region = completer.region
        let search = MKLocalSearch(request: request)
        return await withCheckedContinuation { cont in
            search.start { response, _ in
                cont.resume(returning: response?.mapItems.first)
            }
        }
    }
}
