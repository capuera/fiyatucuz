---
number: 0007
title: Payment provider is abstracted; concrete provider TBD
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0007 — Payment provider is abstracted; concrete provider TBD

## Context

Merchant wallets are funded via a payment service provider (PSP). Candidate PSPs include Iyzico, Craftgate, PayTR, and Stripe. The concrete choice is business-dependent and remains **TBD**. The project owner directed that the domain model must not couple to any single PSP.

## Decision

- The `billing` bounded context defines a **`PaymentProvider` interface** describing the operations FiyatUcuz needs (checkout intent creation, capture, refund, webhook verification, status query).
- Domain code, ledger entries, invoices, and campaign eligibility rules refer only to the interface and to provider-agnostic value objects (e.g. `PaymentIntent { id, status, amount, currency }`).
- Concrete adapters (Iyzico, Craftgate, PayTR, Stripe, others) are added under `billing/providers/<name>/` when the PSP decision is made. Each adapter is responsible for provider-specific serialization, signature verification, and error translation.
- **PCI / KYC scope stays inside the adapter and the PSP.** FiyatUcuz never handles raw card data at MVP.
- Webhook handlers live in the `billing` context; provider selection routes the webhook to the correct adapter based on a stable path prefix and header signature.

## Alternatives considered

- **Pick a PSP now and integrate directly** — rejected. Business input on fees, KYC, and settlement is a blocker; committing early would force a costly migration.
- **Use a payment aggregator (Stripe, Adyen) globally** — attractive but presumes cross-border coverage the market may not need at MVP; still requires the same abstraction to avoid lock-in.

## Consequences

**Positive**

- The domain model does not care which PSP is chosen. Switching providers (or supporting multiple) is a bounded change.
- KYC / PCI concerns are isolated to a small, auditable surface.

**Negative**

- The abstraction cost is real: some PSP features (installments, wallet-of-wallets, dispute flows) will need interface additions rather than direct field mapping.
- Provider-specific behavior (e.g. asynchronous confirmations) may leak into the interface if not carefully designed.

**Neutral**

- No PSP dependency is installed in the foundation scaffold.

## Follow-ups

- Draft the `PaymentProvider` interface (design-only, no implementation) when the `billing` context is scaffolded.
- Business decision required to lift the TBD: PSP selection based on fees, coverage, KYC posture, and settlement cadence.
- Define webhook signature verification approach as part of the first adapter.
