import AppKit
import CoreImage
import Vision

guard CommandLine.arguments.count == 3 else {
    fputs("usage: ExtractForegroundMask <input> <output>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputPattern = CommandLine.arguments[2]
guard let image = NSImage(contentsOf: inputURL) else {
    fputs("could not read input image\n", stderr)
    exit(3)
}

var imageRect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &imageRect, context: nil, hints: nil) else {
    fputs("could not decode input image\n", stderr)
    exit(4)
}

let handler = VNImageRequestHandler(cgImage: cgImage)
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let observation = request.results?.first else {
    fputs("no foreground instances found\n", stderr)
    exit(5)
}

let source = CIImage(cgImage: cgImage)
let clear = CIImage(color: .clear).cropped(to: source.extent)
let context = CIContext()
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func makeCutout(instances: IndexSet) throws -> CIImage {
    let maskBuffer = try observation.generateScaledMaskForImage(
        forInstances: instances,
        from: handler
    )
    return source.applyingFilter("CIBlendWithMask", parameters: [
        kCIInputBackgroundImageKey: clear,
        kCIInputMaskImageKey: CIImage(cvPixelBuffer: maskBuffer),
    ])
}

func makeIsolatedCutout(in region: CGRect) throws -> CIImage {
    guard let croppedCGImage = context.createCGImage(source, from: region) else {
        throw NSError(domain: "ExtractForegroundMask", code: 7)
    }

    let croppedHandler = VNImageRequestHandler(cgImage: croppedCGImage)
    let croppedRequest = VNGenerateForegroundInstanceMaskRequest()
    try croppedHandler.perform([croppedRequest])
    guard let croppedObservation = croppedRequest.results?.first else {
        throw NSError(domain: "ExtractForegroundMask", code: 8)
    }

    let croppedSource = CIImage(cgImage: croppedCGImage)
    let croppedClear = CIImage(color: .clear).cropped(to: croppedSource.extent)
    let maskBuffer = try croppedObservation.generateScaledMaskForImage(
        forInstances: croppedObservation.allInstances,
        from: croppedHandler
    )
    let cutout = croppedSource.applyingFilter("CIBlendWithMask", parameters: [
        kCIInputBackgroundImageKey: croppedClear,
        kCIInputMaskImageKey: CIImage(cvPixelBuffer: maskBuffer),
    ])

    return cutout
        .transformed(by: CGAffineTransform(translationX: region.minX, y: region.minY))
        .composited(over: clear)
}

func writeImage(_ image: CIImage, to outputURL: URL) throws {
    guard let png = context.pngRepresentation(of: image, format: .RGBA8, colorSpace: colorSpace) else {
        throw NSError(domain: "ExtractForegroundMask", code: 6)
    }
    try png.write(to: outputURL, options: .atomic)
}

if outputPattern.contains("%s") {
    // Segment every member from a source crop that contains no neighbour. This
    // prevents a foreground instance shared by two adjacent people from leaking
    // into the selected member's glow layer.
    let splitOne = source.extent.width * 0.333
    let splitTwo = source.extent.width * 0.700
    let members: [(String, CGRect)] = [
        ("frank", CGRect(x: 0, y: 0, width: splitOne, height: source.extent.height)),
        ("momo", CGRect(x: splitOne, y: 0, width: splitTwo - splitOne, height: source.extent.height)),
        ("anne", CGRect(x: splitTwo, y: 0, width: source.extent.width - splitTwo, height: source.extent.height)),
    ]
    for (name, region) in members {
        let isolated = try makeIsolatedCutout(in: region.integral)
        let path = outputPattern.replacingOccurrences(of: "%s", with: name)
        try writeImage(isolated, to: URL(fileURLWithPath: path))
    }
} else if outputPattern.contains("%d") {
    for instance in observation.allInstances {
        let path = outputPattern.replacingOccurrences(of: "%d", with: String(instance))
        try writeImage(try makeCutout(instances: IndexSet(integer: instance)), to: URL(fileURLWithPath: path))
    }
} else {
    try writeImage(try makeCutout(instances: observation.allInstances), to: URL(fileURLWithPath: outputPattern))
}
