import Foundation

/// Posts captures to the ingest service over Tailscale. The endpoint and an
/// optional bearer token are read from UserDefaults so they can be overridden
/// without a rebuild:
///   defaults write com.humanwareos.menubar ingestEndpoint "https://host.example/capture"
///   defaults write com.humanwareos.menubar ingestToken "<shared-secret>"
final class IngestClient {
    static let shared = IngestClient()

    private let defaultEndpoint = "http://127.0.0.1:8899/capture"

    private var endpoint: URL {
        if let stored = UserDefaults.standard.string(forKey: "ingestEndpoint"),
           let url = URL(string: stored) {
            return url
        }
        return URL(string: defaultEndpoint)!
    }

    func send(text: String, completion: @escaping (Result<Void, Error>) -> Void) {
        var request = URLRequest(url: endpoint, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = UserDefaults.standard.string(forKey: "ingestToken"), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["text": text, "source": "menubar"]
        )

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                completion(.failure(NSError(
                    domain: "HumanwareOSIngest",
                    code: code,
                    userInfo: [NSLocalizedDescriptionKey: "ingest returned HTTP \(code)"]
                )))
                return
            }
            completion(.success(()))
        }.resume()
    }
}
