import Foundation

struct Ad: Decodable, Identifiable {
    let id:             String
    let title:          String
    let advertiser:     String?
    let description:    String?
    let image_url:      String
    let target_url:     String?
    let ad_type:        String?
    let placement:      String?
    let is_active:      Bool
    let start_date:     String?
    let end_date:       String?
    let impressions:    Int?
    let clicks:         Int?
    let cooldown_hours: Int?

    var imageURL:  URL? { URL(string: image_url) }
    var targetURL: URL? { target_url.flatMap { URL(string: $0) } }
    var isPopup:   Bool { ad_type == "popup" }
}

struct AdsResponse: Decodable {
    let ads: [Ad]
}
