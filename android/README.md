# Chhaperia ERP — Android app

A thin Android client for the floor tablets and phones. It is a WebView
pointed at the ERP server, wrapped so it behaves like an app: its own icon in
the launcher, no browser chrome, a working Back button, and file downloads
(invoices, labels, exports) landing in the device's Downloads folder.

## Why this and not a PWA

A progressive web app would be less code, but a service worker only runs over
**HTTPS** (or localhost). The ERP is served over plain HTTP on the factory
LAN, so a PWA cannot be installed from it. This app has no such restriction —
it is given explicit permission to talk to the local network in the clear, to
the ERP's address and nowhere else.

The web app *is* still a PWA (`frontend/manifest.webmanifest`, `frontend/sw.js`)
and will install straight from the browser the day the ERP is put behind
HTTPS on a real domain. Both paths lead to the same screens.

## Why the server address is typed in, not built in

The office PC's LAN address changes with the network — it has moved several
times already. An address compiled into the APK would mean a new APK every
time that happened. So the first launch asks for it, stores it, and offers a
**Change server** action afterwards. One APK keeps working forever.

## Building it

Everything is driven by `tools/build-apk.ps1` at the repo root, which expects
a JDK 17 and the Android SDK (both under `C:\Users\<you>\androidtools` on the
machine this was set up on):

    powershell -File tools/build-apk.ps1            # debug APK
    powershell -File tools/build-apk.ps1 -Release   # release APK, needs a keystore

The debug APK lands in
`android/app/build/outputs/apk/debug/app-debug.apk` and installs on any
Android 7 or newer device once "install from unknown sources" is allowed for
whatever app is doing the installing (Files, Chrome, Drive…).

## What is deliberately NOT in here

No push notifications, no camera, no background sync, no local database. The
ERP's data lives on the server and is only ever true as of the last request —
the same rule the service worker follows. This app is a window, not a copy.
