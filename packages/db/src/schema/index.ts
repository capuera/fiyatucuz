// Schema barrel.
//
// Bounded contexts contribute their Drizzle tables here via re-export as they
// land (see ADR-0003, ADR-0012). This file is the single input to
// drizzle.config.ts and to Drizzle client type-inference, so every table that
// must be typed/migrated by the ORM must be reachable from a re-export here.

export * from './identity.js';
export * from './tenants.js';
export * from './merchants.js';
export * from './feeds.js';
