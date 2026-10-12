// Cut the foreground out of an image with macOS Vision: swift remove_background.swift <input> <output.png>
import CoreImage
import Foundation
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3, let input = CIImage(contentsOf: URL(fileURLWithPath: arguments[1])) else {
    FileHandle.standardError.write("usage: remove_background.swift <input> <output.png>\n".data(using: .utf8)!)
    exit(2)
}
let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(ciImage: input)
do {
    try handler.perform([request])
    guard let observation = request.results?.first else {
        FileHandle.standardError.write("remove_background: no foreground found\n".data(using: .utf8)!)
        exit(1)
    }
    let masked = try observation.generateMaskedImage(
        ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: false)
    try CIContext().writePNGRepresentation(
        of: CIImage(cvPixelBuffer: masked), to: URL(fileURLWithPath: arguments[2]),
        format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
} catch {
    FileHandle.standardError.write("remove_background: \(error)\n".data(using: .utf8)!)
    exit(1)
}
