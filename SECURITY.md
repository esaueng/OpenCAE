# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/esaueng/OpenCAE/security/advisories/new).
Do not include vulnerabilities, credentials, or confidential project files in public issues.

Include the affected commit or version, reproduction steps using a minimal
non-sensitive example, expected and actual behavior, and the potential impact.
Please redact tokens and personal information from logs and screenshots.

## System boundaries

OpenCAE is a local-first browser CAD/CAE workspace. Production simulations run
in the browser. The production Worker serves assets and supports consent-based,
client-encrypted recovery backups. The independently runnable reference API
is also part of this repository; identify which component a report affects.

Imported geometry and project files are untrusted inputs. Backup authorization,
confidentiality, bounded input handling, and build/dependency security are
relevant reporting areas. A dependency alert should identify its affected
version and usage where known; uncertainty does not prevent a private report.
