---
number: 0008
title: Hosting is container-first with Turkey-preferred residency; cloud vendor TBD
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0008 — Hosting is container-first with Turkey-preferred residency; cloud vendor TBD

## Context

FiyatUcuz targets the Turkish market. KVKK compliance is mandatory. The project owner directed:

- Deployment must be container-friendly.
- Primary deployment / data residency assumption: **Turkey preferred**.
- Cloud provider remains **TBD**.
- Do not hard-code a cloud vendor into the architecture. Keep infrastructure portable.

## Decision

- **Packaging:** every deployable ships as an **OCI container image** (Docker or equivalent). Images are built from repo-local Dockerfiles in CI.
- **Portability:** the runtime relies only on:
  - Standard container primitives (env vars, PORT, filesystem, stdout/stderr).
  - Standard network dependencies: PostgreSQL, Redis, S3-compatible object storage, OpenSearch-compatible search (later).
- **Storage:** interact with object storage via the S3 API only. No provider-specific SDKs; use an S3 SDK that accepts an endpoint URL so the same code targets AWS S3, MinIO, Wasabi, or Turkish providers.
- **Secrets:** loaded from env vars at process start. The secret source (Vault, cloud secret manager, sealed files) is a deployment concern, not an application concern.
- **Data residency default:** assume Turkey. Any deviation must be justified per data class in [SECURITY.md §Data classification](../.fiyatucuz/SECURITY.md).
- **Cloud vendor:** deliberately left TBD. Candidates include local Turkish providers (Turkcell BulutHizmetleri, Türk Telekom, Vodafone Ready Business), international clouds with Turkish regions (AWS Istanbul availability, GCP, Azure), or self-managed VPS. Selection deferred to a business decision.

## Alternatives considered

- **Pick a cloud vendor now** — rejected. Ties infrastructure design to unknown business constraints (cost, compliance, sales geography).
- **Adopt Kubernetes at foundation time** — rejected as premature. A single container per service on a managed runner is sufficient at MVP. K8s is compatible later if scale demands.
- **Serverless (Lambda / Cloud Run)** — attractive for cost but introduces per-vendor lock-in (cold starts, execution model, request/response limits). Rejected while portability is a stated goal.

## Consequences

**Positive**

- The application does not know or care where it runs.
- Local dev, CI test environments, and production share the same container image.
- Vendor switching cost is bounded to infrastructure code and configuration.

**Negative**

- No vendor-specific optimizations (managed queues, native auth integrations) are used until an ADR justifies each one.
- Some ops burden (patching, monitoring) must be self-managed until the vendor is chosen.

**Neutral**

- KVKK compliance work is required regardless of vendor.

## Follow-ups

- Add production Dockerfiles per service when each service reaches deployable state.
- When the cloud vendor is chosen, open a new ADR recording it and any vendor-specific deviations.
- Deployment / CD pipeline design remains deferred until hosting is chosen.
