# Architecture Decision Records

FiyatUcuz records every load-bearing architectural decision as an ADR.

## Why

- Decisions outlive the people who made them.
- New contributors (human or AI) need the _why_, not just the code.
- A superseded ADR is more useful than a rewritten README that erases history.

## Rules

1. One decision per ADR.
2. Filename: `NNNN-kebab-slug.md`, zero-padded to four digits.
3. Never edit an accepted ADR. Supersede it with a new ADR and update the old one's status/front-matter to `superseded-by: NNNN`.
4. An ADR is binding once merged and `status: accepted`.
5. A decision has no force until it is in an ADR — even if the team agreed verbally.

## Statuses

- `proposed` — draft; open for discussion.
- `accepted` — merged and binding.
- `superseded` — replaced by another ADR.
- `deprecated` — no longer relevant, no successor.
- `rejected` — considered and declined; kept for the record.

## Writing an ADR

Copy `template.md`. Fill in every section. Keep it under a page whenever possible. Concrete trade-offs beat prose.

## Index

See [`.fiyatucuz/DECISIONS.md`](../.fiyatucuz/DECISIONS.md).
