# Product overview

Product-level framing intended for engineers, designers, and AI agents to align on what FiyatUcuz _is_ before writing code.

## 1. Value proposition

**For consumers:** find the best price and the most trustworthy merchant for what they want to buy — fast, SEO-discoverable, mobile-friendly.

**For merchants:** acquire high-intent traffic from consumers already comparing prices, with transparent click/impression billing and measurable ROI.

**For the platform:** monetize traffic through advertising placements (sponsored, showcase, keyword, bold) with a clear billing story tied to a merchant wallet.

## 2. Actors and jobs-to-be-done

| Actor            | Primary jobs                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Consumer         | Find a product; compare prices across merchants; see price history; navigate to the best merchant.                  |
| Merchant Owner   | Register the business; verify their website; upload a feed; fund the wallet; launch campaigns; monitor performance. |
| Merchant Staff   | Manage campaigns, keywords, and creative inside their allowed scope.                                                |
| Platform Admin   | Onboard merchants; enforce policy; resolve disputes; oversee catalog and matching quality.                          |
| Platform Support | Answer merchant questions; investigate tracking discrepancies (read-mostly).                                        |

## 3. Core value flows

### 3.1 Consumer discovery

1. Consumer arrives via search engine or direct URL to a comparison page.
2. Page renders SSR with structured data (JSON-LD `Product` + `AggregateOffer`).
3. Consumer clicks an offer → tracked click → redirect to Merchant Website.
4. Attribution runs later; if the click matched a live Campaign, the Merchant's Wallet is charged.

### 3.2 Merchant onboarding

1. Merchant signs up, verifies email, provides business identity.
2. Merchant adds a Website and completes DNS TXT or file-drop verification.
3. Merchant configures a Feed Source; first Feed Run archives, parses, normalizes, and attempts to match items.
4. Merchant reviews matches (approve/reject/reassign).
5. Merchant funds the Wallet through the PSP.
6. Merchant creates a Campaign, chooses Placements, sets budget and schedule.
7. Campaign goes live; performance appears in Analytics.

### 3.3 Feed ingestion

1. Scheduled worker fetches Feed → archives raw payload to object storage.
2. Parser extracts Staging Items.
3. Normalizer produces Normalized Items.
4. Matcher resolves to Products (auto, suggest, or leave unmatched).
5. Offers are upserted for matched items.
6. Feed Run is finalized with counts, warnings, errors.

### 3.4 Ad decision (consumer-facing)

1. Search Query arrives.
2. Organic ranking assembles from catalog + offers.
3. Advertising context evaluates eligible Placements: budget non-zero, schedule active, keyword match if applicable, wallet solvent.
4. Auction selects winners for each Ad Slot.
5. Response merges organic + sponsored, marked appropriately.
6. Impression Events fired for served slots; Click Events fired on interaction.

### 3.5 Billing

1. Tracking worker rolls up Events at defined intervals.
2. Attribution matches Events to Campaigns per the active model (last-click at MVP).
3. Attributed Events become Billable Records with an idempotency key.
4. Billing writes Ledger Entries (Charges) against the Merchant's Wallet.
5. Periodic Invoices summarize charges for the merchant.

## 4. Non-goals

- Checkout on FiyatUcuz. Consumers complete purchases on Merchant Websites.
- White-label deployment.
- Real-time collaborative merchant tooling.
- Full ML-driven recommendations at MVP (reserved for the `ai-discovery` context).

## 5. Success metrics (leading)

- **Coverage:** number of Products with ≥ 2 live Offers.
- **Freshness:** median lag between Feed Run and Offer visibility.
- **Match quality:** % of Normalized Items auto-matched with high confidence.
- **CTR:** click-through rate on comparison pages.
- **Merchant funding rate:** % of verified merchants who fund their Wallet within 30 days.
- **Advertising utilization:** % of live Campaigns spending within 20% of budget.

## 6. Success metrics (lagging)

- **Consumer sessions with a click-out.**
- **Total attributed spend per merchant per month.**
- **Retention:** % of merchants renewing their spend month-over-month.
- **SEO health:** number of comparison pages ranked on page 1 for target queries.

## 7. Constraints and assumptions

- Primary market: Türkiye. TRY currency. Turkish primary UI locale.
- Legal posture: KVKK compliance mandatory from day one.
- Team is small; operational surface must stay small.
- Backend runtime is Node.js + TypeScript (see [ADR-0001](../../adr/0001-backend-runtime.md)).
- Multi-tenant with strict merchant isolation (see [ADR-0004](../../adr/0004-multi-tenancy-model.md)).
