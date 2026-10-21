# ADR-008: WhatsApp dual-API routing + per-message cost ledger

Status: Accepted (Fase 0)
Date: 2026-10-22

WhatsApp sends route by the template's latest category: marketing via the Marketing Messages API (/{phone-number-id}/marketing_messages), everything else via Cloud API (/{phone-number-id}/messages), ahead of the 13 Oct 2027 Cloud API marketing sunset. Since 1 Oct 2026 WhatsApp pricing is per delivered message, so a cost ledger records every billable send from day one.
