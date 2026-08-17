# Bounded contexts

Every backend module belongs to exactly one bounded context. Contexts communicate via explicit contracts; they never share internals.

This registry is a proposal. Contexts marked _(reserved)_ have no implementation planned in the initial phase but the name is claimed to prevent later collision.

## Registry

| #   | Context                     | Responsibility                                                          | Owns (aggregates)                                 | Consumes                            | Notes                                                           |
| --- | --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| 1   | `identity`                  | Authentication, session lifecycle, MFA, OAuth (Google/Apple)            | User, Credential, Session, MfaFactor, OAuthLink   | —                                   | Only context allowed to write auth records.                     |
| 2   | `users`                     | User profile, preferences, notification settings                        | UserProfile, UserPreferences                      | `identity`                          | Excludes credentials.                                           |
| 3   | `tenants`                   | Tenant lifecycle, membership, tenant-level settings                     | Tenant, TenantMembership, TenantSettings          | `identity`, `users`                 | Enforces the tenant model.                                      |
| 4   | `merchants`                 | Merchant business profile, ownership verification, website registration | Merchant, MerchantWebsite, WebsiteVerification    | `tenants`                           | Verification is DNS TXT + file-drop.                            |
| 5   | `catalog`                   | Canonical product catalog                                               | Product, ProductAttribute, ProductMedia           | `normalization`, `matching`         | Cross-tenant public data.                                       |
| 6   | `feed`                      | XML/CSV ingest, archival, parsing, staging                              | FeedSource, FeedRun, StagingItem                  | `merchants`                         | Never mutates live offers.                                      |
| 7   | `normalization`             | Attribute cleanup, unit conversion, brand/model canonicalization        | NormalizedItem                                    | `feed`                              | Deterministic + rule-based initially.                           |
| 8   | `matching`                  | Cross-merchant product identity resolution                              | ProductMatch, MatchCandidate                      | `normalization`, `catalog`          | Hybrid rule + statistical initially; ML later.                  |
| 9   | `offers`                    | Merchant offers on catalog products                                     | Offer, OfferPriceHistory                          | `catalog`, `merchants`              | Tenant-scoped writes; cross-tenant reads for comparison.        |
| 10  | `pricing`                   | Price snapshots, price history, price alerts                            | PriceSnapshot, PriceAlert                         | `offers`                            | Consumer-facing price history.                                  |
| 11  | `search`                    | Query understanding, result assembly                                    | SearchQuery (transient), SearchResult (transient) | `catalog`, `offers`, `advertising`  | PG FTS phase 1 → OpenSearch phase 2.                            |
| 12  | `categories`                | Category taxonomy, hierarchies                                          | Category, CategoryMapping                         | `catalog`                           | Category mapping across merchant taxonomies.                    |
| 13  | `keywords`                  | Keyword vocabulary and stems, keyword packages                          | Keyword, KeywordPackage                           | `search`, `advertising`             | Keyword-based ad targeting relies on this.                      |
| 14  | `advertising`               | Ad placement decisions (which sponsored offer wins)                     | Placement, AdSlot, AdDecision (transient)         | `campaigns`, `keywords`, `wallet`   | Auction/ranking lives here.                                     |
| 15  | `campaigns`                 | Merchant advertising intent, budgets, schedules                         | Campaign, CampaignBudget, CampaignSchedule        | `wallet`, `packages`                | Campaign lifecycle events audited.                              |
| 16  | `tracking`                  | Click + impression capture, idempotency, dedup                          | ClickEvent, ImpressionEvent                       | —                                   | Hot-path; separate lightweight endpoints.                       |
| 17  | `attribution`               | Attribute events to campaigns, produce billable records                 | AttributedEvent, BillableRecord                   | `tracking`, `campaigns`             | Last-click at MVP; model interface allows evolution.            |
| 18  | `wallet`                    | Tenant balances, ledger                                                 | Wallet, LedgerEntry                               | —                                   | Append-only ledger; balance = derived state.                    |
| 19  | `packages`                  | Purchasable capacity bundles                                            | Package, PackageGrant, PackageConsumption         | `wallet`                            | Feeds campaign eligibility.                                     |
| 20  | `billing`                   | Top-ups, invoices, statements, tax                                      | Topup, Invoice, InvoiceLine, TaxProfile           | `wallet`, `packages`                | PSP integration lives here.                                     |
| 21  | `analytics`                 | Metrics warehouse and rollups for merchants and admins                  | Rollup, MetricDefinition                          | `tracking`, `attribution`, `offers` | Hourly + daily rollups; dashboards read only rollups.           |
| 22  | `reporting`                 | User-facing reports and exports                                         | Report, ReportRun, ReportExport                   | `analytics`                         | May be merged into `analytics` if trivial.                      |
| 23  | `notifications`             | Multi-channel notification delivery                                     | Notification, DeliveryAttempt, ChannelPreference  | `users`, `merchants`                | Email at MVP; push/SMS later.                                   |
| 24  | `seo`                       | Sitemap generation, canonical URL rules, structured data policy         | SitemapPartition, UrlRule                         | `catalog`, `offers`, `content`      | Owned by backend even though consumed by web.                   |
| 25  | `content`                   | Editorial content, category pages, static content                       | ContentPage, ContentBlock                         | `seo`                               | May be minimal at MVP; owns non-catalog SEO surface.            |
| 26  | `admin`                     | Platform admin operations, cross-tenant tools                           | AdminAction                                       | _(all, read-only where possible)_   | Uses the RLS-bypass role deliberately and audits every access.  |
| 27  | `audit`                     | Immutable audit log                                                     | AuditRecord                                       | _(receives events from all)_        | Append-only; retention policy TBD.                              |
| 28  | `ai-discovery` _(reserved)_ | AI-assisted discovery, recommendations, embeddings                      | _(TBD)_                                           | _(TBD)_                             | Reserved for future work; not implemented in the initial phase. |

## Communication rules

- **Synchronous:** direct function call across module boundaries via each module's `index.ts` (its public API). No deep imports.
- **Asynchronous:** in-process domain events at first (module A emits, subscribers registered at bootstrap). Move to Redis/BullMQ when a subscriber must run out-of-process.
- **Cross-service:** contracts in `packages/*-contracts`. Once a module is extracted, its contract package becomes the only allowed dependency for its consumers.

## Ownership of shared aggregates

- `Product` is owned by `catalog`. Everyone else references by id.
- `Wallet` is owned by `wallet`. Ledger entries appended via a single API; balances read via a single API. No direct table access from other modules.
- `Tenant` is owned by `tenants`. Everyone else uses `TenantId` as a value object.

## Open boundary questions

- Should `pricing` be a submodule of `offers` at MVP, or a peer? _(Current: peer, for clarity of the price-history public surface.)_
- Should `attribution` merge into `tracking`? _(Current: separate. Tracking is hot-path capture; attribution is deferred computation.)_
- Should `reporting` merge into `analytics`? _(Current: separate. Merge if implementation is trivial.)_
- Where does the ad auction/ranking live? _(Current: `advertising`. Consider extracting once ML enters the picture.)_
