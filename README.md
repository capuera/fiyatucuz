# FiyatUcuz

FiyatUcuz is an AI-native commerce discovery and price comparison platform designed to connect consumers with merchants through product discovery, price intelligence, performance marketing, tracking, analytics, and merchant tooling.

**Repository:** `https://github.com/capuera/fiyatucuzboş`

> The repository is currently in the foundation phase. Product requirements, domain language, architecture decisions, API contracts, and implementation standards will be added incrementally before production modules are developed.

## Product Goals

FiyatUcuz is intended to provide:

- Product and offer discovery
- Price comparison and price history
- Merchant onboarding and management
- XML/feed-based product ingestion
- Product normalization and catalog management
- Search and filtering
- Performance marketing and sponsored placement
- Click, impression, and conversion tracking
- Merchant wallet/balance management
- Analytics and reporting
- SEO-first public web experience
- Responsive web and mobile applications
- AI-assisted product discovery and recommendations

## Engineering Principles

The project follows these principles:

1. **Domain-first** — business domains and rules are defined before implementation details.
2. **API-first** — externally consumed capabilities are specified as contracts.
3. **AI-native** — repository documentation is structured so coding agents can understand project intent and constraints.
4. **Security and privacy by design** — authentication, authorization, auditability, and data protection are architectural concerns.
5. **SEO-first public web** — public product and content pages must be crawlable and performant.
6. **Observable by default** — important application operations should be measurable, traceable, and auditable.
7. **Incremental architecture** — start with a modular architecture that can evolve without premature microservice complexity.

## Planned Application Surfaces

```text
apps/
├── web/       # Public consumer-facing web application
├── admin/     # Internal administration application
└── mobile/   # React Native + Expo application

services/      # Independently deployable supporting services when justified
packages/      # Shared TypeScript libraries
```

The backend will be implemented as a .NET application and will be introduced after the initial domain and architecture specifications are established.

## Planned Technology Direction

### Backend
- .NET 10 / ASP.NET Core
- PostgreSQL
- Redis
- RabbitMQ
- OpenSearch
- SignalR
- Background job processing
- S3-compatible object storage

### Web
- Next.js
- React
- TypeScript
- Tailwind CSS
- TanStack Query
- Zod

### Mobile
- React Native
- Expo
- Expo Router
- TypeScript
- TanStack Query
- Zod

### Repository Tooling
- pnpm
- Turborepo
- GitHub Actions
- Docker

Technology choices remain subject to the Architecture Decision Record process until formally accepted.

## Repository Structure

```text
.
├── .github/        # GitHub workflows, templates and repository automation
├── apps/            # User-facing and administrative applications
├── packages/        # Shared TypeScript packages
├── services/        # Supporting services
├── docs/            # Product and technical documentation
├── knowledge/       # Domain language and AI-readable project knowledge
├── adr/             # Architecture Decision Records
├── contracts/       # API/event contracts
├── schemas/         # Data and validation schemas
├── infra/           # Infrastructure definitions
├── scripts/         # Development and maintenance scripts
└── tests/            # Cross-application/integration test assets
```

## Development Status

| Area | Status |
|---|---|
| Repository foundation | In progress |
| Business requirements | Planned |
| Domain model | Planned |
| Architecture | Planned |
| Database specification | Planned |
| API contracts | Planned |
| Web application | Planned |
| Mobile application | Planned |
| AI capabilities | Planned |
| Production infrastructure | Planned |

## Source of Truth

Until a dedicated project specification is introduced, the repository documentation is the authoritative source for engineering decisions.

Future authoritative sources will include:

- `docs/` — approved project and technical documentation
- `knowledge/` — ubiquitous language and domain knowledge
- `adr/` — architecture decisions
- `contracts/` — API and event contracts
- `schemas/` — machine-readable schemas

## Contribution

Contribution and development rules will be defined in `CONTRIBUTING.md` before external contributors or additional engineering agents are introduced.

## License

The licensing model has not yet been finalized. A license file will be added after the project ownership and distribution policy are formally approved.
