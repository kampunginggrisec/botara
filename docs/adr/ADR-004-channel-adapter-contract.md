# ADR-004: Channel adapter contract + capability matrix

Status: Accepted (Fase 0)
Date: 2026-10-22

Every channel implements the ChannelAdapter contract in packages/channels and declares a CapabilitySet. The UI and flow engine must respect the matrix (e.g. Threads: no DM, no like). New channels are added by implementing the contract, never by special-casing core code.
