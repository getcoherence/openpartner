# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use one of these private channels instead:

- **GitHub private vulnerability reporting** (preferred): <https://github.com/getcoherence/openpartner/security/advisories/new>
- **Email**: security@openpartner.dev — replies within 48 hours.

Include as much of the following as you can:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a minimal proof-of-concept.
- The commit SHA or release version you tested against.
- Whether you intend to publish a write-up, and on what timeline.

## What to expect

- Acknowledgement within **48 hours**.
- An initial assessment (severity, scope, owner) within **5 business days**.
- For critical issues, a fix or mitigation shipped within **7 days** of acknowledgement.
- Coordinated disclosure: we'll work with you on a timeline before any public details are shared.
- Credit in the release notes for the fix, if you want it.

## Scope

In scope:

- The OpenPartner application code in this repository (`apps/`, `packages/`).
- The official Docker images published from this repository.
- The hosted production deployment at `app.openpartner.dev` and `network.openpartner.dev`.
- The `@openpartner/sdk` npm package published from this repository.

Out of scope:

- Self-hosted deployments running modified code.
- Vulnerabilities in third-party dependencies — please report those upstream and let us know which dependency.
- Findings that require physical access, social engineering of OpenPartner staff, or DoS / volumetric attacks.
- Reports generated solely by automated scanners with no demonstrated impact.

## Supported versions

The `main` branch is the only supported version. Security fixes ship to the latest release tag.

## Hall of fame

We list reporters who responsibly disclose verified vulnerabilities in `SECURITY-HALL-OF-FAME.md` (created on first entry) — opt in via your report.
