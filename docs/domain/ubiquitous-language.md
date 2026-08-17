# Ubiquitous language

Canonical vocabulary for FiyatUcuz. Terms in this glossary must be used with these exact meanings across code, documentation, UI copy, and conversations. Do not synonymize.

Turkish equivalents are provided where UI translation matters — the code stays in English.

## Actors

- **Consumer** _(Tüketici)_ — an end user searching for products or comparing prices. Not tied to a tenant.
- **Merchant** _(Satıcı)_ — a business that lists offers on the platform. Owns one or more Merchant Websites. Belongs to exactly one Tenant.
- **Merchant Owner** — a User with full authority over a merchant tenant.
- **Merchant Staff** — a User with delegated authority within a merchant tenant.
- **Platform Admin** — a User with platform-wide authority.
- **Platform Support** — a User with read-mostly platform-wide access for customer service.

## Organizational

- **Tenant** — the isolation unit. Platform is a tenant. Every merchant is a tenant. A Tenant owns Merchants, Wallets, Campaigns, and Users via Memberships.
- **Tenant Membership** — the link between a User and a Tenant, carrying the User's role in that Tenant.
- **Merchant Website** — a domain owned by a Merchant, verified via DNS TXT or file drop. Traffic destinations must be a verified Merchant Website.

## Catalog

- **Product** _(Ürün)_ — the canonical, cross-merchant description of a thing. Owned by `catalog`.
- **Offer** _(Fiyat teklifi)_ — a Merchant's price and availability for a Product (or an unmatched item pending Matching). Owned by `offers`. Tenant-scoped for writes, cross-tenant for public reads.
- **SKU** — a Merchant's internal identifier for their Offer. Never used as an external identifier.
- **Feed** — a Merchant's stream of raw item data, typically XML/CSV. Ingested, archived, parsed, normalized, then matched against Products.
- **Feed Source** — the configuration for a single Feed: URL, credentials, schedule, format.
- **Feed Run** — one execution of a Feed Source. Immutable record of what was fetched and when.
- **Staging Item** — a parsed but not-yet-normalized item from a Feed Run.
- **Normalized Item** — a cleaned, canonicalized Staging Item ready for Matching.
- **Product Match** — the resolution of a Normalized Item to a Product. May be automatic, suggested, manual, or rejected.
- **Category** — a taxonomy node. FiyatUcuz maintains its own taxonomy and Category Mappings from merchant taxonomies.

## Commerce surface

- **Search Query** — a consumer's search input plus filters. Not persisted (as an aggregate).
- **Search Result** — the assembled response to a Search Query: organic + sponsored, ranked. Not persisted.
- **Comparison Page** — the SEO-first page listing all Offers for a Product.
- **Price History** — the time series of best price for a Product.
- **Price Snapshot** — a point-in-time record of an Offer's price. Feeds Price History.

## Advertising

- **Campaign** _(Kampanya)_ — a Merchant's intent to advertise. Owns a Budget, one or more Placements, a Schedule.
- **Placement** — how/where the Campaign appears. Types include:
  - **Sponsored Product** — appears among organic results, marked as sponsored.
  - **Featured Product** — appears in a dedicated featured slot.
  - **Showcase Product** _(Vitrin)_ — appears in a category-level showcase.
  - **Bold Placement** — a merchant-level highlight in a listing.
  - **Keyword Package** — placement tied to a Keyword Package's covered keywords.
- **Budget** — a monetary or capacity cap for a Campaign over a period.
- **Ad Decision** — the auction/ranking result for a single Ad Slot at request time. Not persisted (aggregated for analytics).
- **Ad Slot** — a specific location in the UI that can carry an Ad Decision.

## Tracking

- **Click Event** — a consumer-initiated navigation from FiyatUcuz to a Merchant Website. Append-only.
- **Impression Event** — a display of an Offer or Placement to a consumer. Append-only.
- **Attribution** — the process of associating an Event with a Campaign for billing purposes.
- **Attributed Event** — the immutable output of Attribution.
- **Billable Record** — an Attributed Event that has been converted into a wallet charge.

## Money

- **Wallet** — a Tenant's balance. Not a bank account; a platform-internal ledger.
- **Ledger Entry** — one append-only movement on a Wallet. Balance is derived by summing entries. Never edited.
- **Topup** — a Ledger Entry created by a Merchant paying money into their Wallet.
- **Charge** — a Ledger Entry created by billing (typically from Billable Records).
- **Package** — a purchasable bundle of capacity (impressions, clicks, showcase days, keyword access).
- **Package Grant** — a Package purchase, with expiry and quotas.
- **Package Consumption** — a decrement of a Package Grant's quota.
- **Invoice** — periodic billing artifact. Contains Invoice Lines that reference Ledger Entries.

## Insight

- **Metric** — a named measurement (e.g., `clicks_per_hour`, `spend_per_campaign`).
- **Rollup** — a pre-aggregated metric over a time bucket. Dashboards read Rollups, never raw events.
- **Report** — a user-facing view over Rollups (or ad-hoc queries where scale allows).

## Platform

- **Notification** — a message delivered to a User over a channel (email, in-app, push, SMS).
- **Audit Record** — an immutable log of a sensitive action (auth, permission change, wallet mutation, campaign lifecycle event).

## Reserved

- **Recommendation** _(reserved)_ — a future AI-assisted suggestion surface. Belongs to `ai-discovery` context.

## Conventions

- **Identifier** — a ULID stored as `uuid`. Externally, ULIDs are rendered in their canonical 26-char form.
- **Money** — always minor units (e.g., TRY kuruş) as `bigint`. Never float.
- **Time** — always UTC as `timestamptz`. Display in local time in the UI only.
- **Tenant Id** — the primary key of `tenants.Tenant`. Required on every tenant-scoped operation.
