# ADR-006: Cloudflare R2 for media

Status: Accepted (Fase 0)
Date: 2026-10-22

All media lives in Cloudflare R2 (S3-compatible, zero egress). Channel media is served from a custom public domain, never r2.dev. Standard storage class for channel media.
