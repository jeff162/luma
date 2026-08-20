// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The macOS application wrapper: a Dock icon, a Quit that works, and a server it keeps alive.
//
// It exists because a Python process cannot be a well-behaved macOS application. LaunchServices expects
// a regular app to check in with the window server, and one that never does bounces in the Dock for the
// length of the launch timeout — minutes — before being marked as failed, at which point the Dock offers
// only Force Quit. Declaring the app background-only (which is what PyInstaller does for a console
// build) avoids the bounce by having no Dock presence at all. Neither is acceptable, and the third
// option — a Cocoa event loop inside the Python process — would mean a large dependency and moving
// uvicorn off the main thread, where it sits precisely so Ctrl+C is a clean shutdown.
//
// So this is the application, and the Python build is its child. It is deliberately the only part of the
// system that knows anything about AppKit; nothing on the Python side changes because of it.
//
// The two processes watch each other, because either can go first:
//
// - **This one first.** Force Quit gives it no chance to clean up, so the child is not told — it finds
//   out. The pipe below is held open here and read there; the kernel closes this end however the process
//   dies, and the read returns end-of-file. That is a guarantee rather than a courtesy, which is what
//   makes it work under SIGKILL.
// - **The child first**, whether through the app's own Shut down control or a crash. `terminationHandler`
//   is how that arrives here, and the answer is to quit — an application whose whole purpose has exited
//   should not stay in the Dock as a corpse.

import AppKit
import Foundation

private let appName = "Luma"
// Inside `Contents/Resources`, where the PyInstaller build is placed by `scripts/build_desktop.py`.
private let serverRelativePath = "server/luma"
private let parentPipeVariable = "LUMA_PARENT_PIPE"
private let logRelativePath = "Library/Application Support/\(appName)/luma-desktop.log"
// How long a graceful stop is given before the process is killed outright. Generous: the server is
// finishing in-flight requests and closing databases, and killing it early is the thing being avoided.
private let shutdownGrace: TimeInterval = 20

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private let server = Process()
    // Held for the process's whole life on purpose: releasing it closes the write end, which the child
    // reads as this process having died.
    private var deadMansSwitch: Pipe?
    private var stopping = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()

        guard let resources = Bundle.main.resourceURL else {
            reportFailureAndQuit("This application bundle has no Resources directory.")
            return
        }
        let executable = resources.appendingPathComponent(serverRelativePath)
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            reportFailureAndQuit("The server is missing from this application bundle:\n\(executable.path)")
            return
        }

        let pipe = Pipe()
        deadMansSwitch = pipe

        server.executableURL = executable
        server.standardInput = pipe.fileHandleForReading
        var environment = ProcessInfo.processInfo.environment
        environment[parentPipeVariable] = "1"
        server.environment = environment
        server.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            DispatchQueue.main.async { self?.serverStopped(status: status) }
        }

        do {
            try server.run()
        } catch {
            reportFailureAndQuit("The server could not be started:\n\(error.localizedDescription)")
            return
        }

        // Now that the child has its own copy, drop this one. The child must end up holding the only
        // read end and none of the write end, or the pipe never reaches end-of-file and the watch is
        // silently dead.
        try? pipe.fileHandleForReading.close()
    }

    /// The child exited on its own — the in-app Shut down control, or a failure.
    private func serverStopped(status: Int32) {
        // A stop this process asked for is already being waited on in `applicationShouldTerminate`.
        guard !stopping else { return }
        if status != 0 {
            let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(logRelativePath)
            reportFailureAndQuit("The server stopped unexpectedly (exit status \(status)).\n\n"
                + "What it reported before stopping is in:\n\(log.path)")
            return
        }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.isRunning else { return .terminateNow }
        guard !stopping else { return .terminateLater }
        stopping = true

        // SIGTERM rather than `Process.terminate()` for the same reason Ctrl+C works: it is the signal
        // uvicorn handles, so the server finishes what it is doing, clears its lockfile, and exits.
        kill(server.processIdentifier, SIGTERM)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(shutdownGrace)
            while self.server.isRunning && Date() < deadline {
                usleep(100_000)
            }
            if self.server.isRunning {
                kill(self.server.processIdentifier, SIGKILL)
            }
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }

        // Quitting is not instant, and saying so is what stops macOS deciding the app is unresponsive.
        return .terminateLater
    }

    /// A menu with nothing but Quit. An application with no menu bar at all cannot be quit with the
    /// keystroke every other application uses, and the Dock's Quit is not a substitute for it.
    private func installMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Quit \(appName)",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        NSApp.mainMenu = mainMenu
    }

    /// The alternative is the failure this whole wrapper exists to prevent: an icon that bounces once
    /// and disappears, with nothing anywhere to say why.
    private func reportFailureAndQuit(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "\(appName) could not start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
// Regular, not accessory: the Dock icon is the point.
application.setActivationPolicy(.regular)
let delegate = LauncherDelegate()
application.delegate = delegate
application.run()
