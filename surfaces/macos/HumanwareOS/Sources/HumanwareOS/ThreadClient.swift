import Foundation

struct ThreadItem {
    let channel: String
    let title: String
    let appURL: URL
}

struct ThreadGroup {
    let status: String
    let label: String
    let threads: [ThreadItem]

    /// The endpoint returns threads newest-first. Group them under alphabetical
    /// channel headings while preserving that recency order inside each channel.
    var channels: [ThreadChannelGroup] {
        var threadsByChannel: [String: [ThreadItem]] = [:]
        for thread in threads {
            threadsByChannel[thread.channel, default: []].append(thread)
        }
        let channelOrder = threadsByChannel.keys.sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
        return channelOrder.map {
            ThreadChannelGroup(channel: $0, threads: threadsByChannel[$0] ?? [])
        }
    }
}

struct ThreadChannelGroup {
    let channel: String
    let threads: [ThreadItem]
}

struct ThreadSnapshot {
    var groups: [ThreadGroup] = []
    var sampledAt: Date?
    var ok = false
    var error: String?

    var count: Int { groups.reduce(0) { $0 + $1.threads.count } }
    var activeCount: Int {
        groups
            .filter { $0.status != "scheduled" && $0.status != "closed" }
            .reduce(0) { $0 + $1.threads.count }
    }
}

final class ThreadClient {
    static let shared = ThreadClient()

    private let defaultEndpoint = "http://127.0.0.1:8899/threads"

    private var endpoint: URL {
        if let stored = UserDefaults.standard.string(forKey: "threadsEndpoint"),
           let url = URL(string: stored) {
            return url
        }
        if let capture = UserDefaults.standard.string(forKey: "ingestEndpoint"),
           let base = URL(string: capture),
           let threads = URL(string: "/threads", relativeTo: base) {
            return threads.absoluteURL
        }
        return URL(string: defaultEndpoint)!
    }

    func fetch(completion: @escaping (ThreadSnapshot) -> Void) {
        var request = URLRequest(url: endpoint, timeoutInterval: 8)
        request.httpMethod = "GET"
        if let token = UserDefaults.standard.string(forKey: "ingestToken"), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                completion(ThreadSnapshot(error: error.localizedDescription))
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let data,
                  let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  (root["ok"] as? Bool) == true,
                  let rawGroups = root["groups"] as? [[String: Any]] else {
                completion(ThreadSnapshot(error: "thread feed unavailable"))
                return
            }

            let groups = rawGroups.compactMap { raw -> ThreadGroup? in
                guard let status = raw["status"] as? String,
                      let label = raw["label"] as? String,
                      let rawThreads = raw["threads"] as? [[String: Any]] else { return nil }
                let threads = rawThreads.compactMap { item -> ThreadItem? in
                    guard let channel = item["channel"] as? String,
                          let title = item["title"] as? String,
                          let rawURL = item["appUrl"] as? String,
                          let url = URL(string: rawURL) else { return nil }
                    return ThreadItem(channel: channel, title: title, appURL: url)
                }
                return ThreadGroup(status: status, label: label, threads: threads)
            }

            let iso = ISO8601DateFormatter()
            let fractionalISO = ISO8601DateFormatter()
            fractionalISO.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var sampledAt: Date?
            if let raw = root["sampledAt"] as? String {
                sampledAt = fractionalISO.date(from: raw) ?? iso.date(from: raw)
            }
            completion(ThreadSnapshot(groups: groups, sampledAt: sampledAt, ok: true))
        }.resume()
    }
}
