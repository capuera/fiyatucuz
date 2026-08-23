// Re-export the GOOGLE_MERCHANT_XML parser as a named module for grep-ability.
// The actual implementation lives in `./index.ts` so the parser registry is
// authoritative in one place.
export { GoogleMerchantXmlParser } from './index.js';
