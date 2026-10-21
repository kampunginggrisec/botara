# ADR-007: Resend for email (transactional + inbound)

Status: Accepted (Fase 0)
Date: 2026-10-22

Resend handles transactional email and the email channel, including inbound: the email.received webhook carries metadata only, content/attachments are fetched via the Receiving API and attachments are copied into R2.
