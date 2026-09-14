# Needs Carl

- **macOS containment decision:** The final security review found that a child can call `setsid()` and escape PGID/SID-based descendant containment on macOS; unlike Linux, the current design has no race-safe cgroup-equivalent primitive. Please choose whether macOS must fail closed for external-process features, or whether macOS release qualification should remain blocked while we pursue a different privileged containment design.
- **Release signing, if no longer deferred:** Final signed/notarized macOS qualification needs a Developer ID Application certificate/private key, notarization credentials, and the expected TeamIdentifier supplied through the project secret-management or native-Mac path. Do not put credentials in this file.

The fresh V9 latency failure is engineering-owned and intentionally is not listed as a Carl action.
