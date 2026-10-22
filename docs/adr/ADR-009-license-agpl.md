# ADR-009: License — AGPL-3.0

- Status: Accepted (2026-10-22)
- Decider: Project owner

## Context

Botara is a clean-room, from-scratch alternative to ChatbotX, whose codebase
is only partly MIT-licensed with the remainder under enterprise/commercial
terms (see ADR-001). Botara's long-term value is expected to sit in the
**hosted service** (managed SaaS), not in distributing binaries. The license
must therefore protect the hosted offering while keeping self-hosting free.

## Decision

Botara is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0), SPDX identifier `AGPL-3.0-only`. The verbatim license text lives
in `LICENSE` at the repository root.

## Rationale

- **Network-use copyleft:** AGPL's §13 closes the SaaS loophole — anyone
  running a modified Botara as a network service must offer the modified
  source to its users. A competitor cannot take Botara, improve it behind
  closed doors, and sell it as a closed hosted product.
- **Self-hosters stay free:** anyone may run, modify, and redistribute
  Botara under the AGPL at no cost.
- **Dual licensing stays possible:** the project owner is the sole
  copyright holder, so commercial/dual licensing for specific customers
  remains an option later.
- **Dependency compatibility:** all current dependencies are permissive
  (MIT/Apache-2.0/BSD family), so nothing conflicts with AGPL distribution.

## Alternatives considered

- **Apache-2.0** — rejected: permissive terms allow a closed-source SaaS
  competitor to build directly on Botara without giving anything back;
  that undermines the hosted-service model.
- **MIT** — rejected: no copyleft and no express patent grant; weakest
  protection of the three for this use case.

## Consequences

- If dual licensing is ever pursued, future external contributors should
  expect a **CLA (Contributor License Agreement)** so the owner keeps the
  rights needed to relicense.
- **Dependency policy:** permissive dependencies only. Any copyleft
  dependency (GPL/AGPL/LGPL family or source-available licenses) must be
  flagged and reviewed BEFORE it is added.
- Every hosted deployment of modified code carries the AGPL §13 duty to
  offer source to network users; the product should link to the source
  repository from the UI footer/about page when that lands.
