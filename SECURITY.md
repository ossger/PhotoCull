# Security policy

PhotoCull runs entirely on your machine: the Electron app talks to its Python
worker over `127.0.0.1` only, guarded by a per-launch token, and nothing is
uploaded anywhere.

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[private vulnerability reporting](https://github.com/ossger/Photography/security/advisories/new)
rather than a public issue. You'll get an acknowledgement within a few days.

Only the latest release is supported with fixes.
