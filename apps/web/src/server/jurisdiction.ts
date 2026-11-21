import "server-only";

/** Header in which the hosting platform reports the ISO 3166-1 alpha-2 country of the client address. */
export const GEOLOCATION_HEADER = "x-vercel-ip-country";

/** The United States and its territories, which have their own country codes. */
const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set(["US", "AS", "GU", "MP", "PR", "UM", "VI"]);

/**
 * Whether execution must be withheld from a request because of where it comes from.
 * - `restricted_country`: the platform located the request in the United States or one of its territories.
 * - `country_unknown`: the location could not be established in production. Restricted, because the gate
 *   fails closed.
 * - `permitted_country`: the platform located the request elsewhere.
 * - `development_no_geolocation`: no header outside production, where no platform sets one.
 */
export type Jurisdiction =
  | { readonly restricted: true; readonly reason: "restricted_country"; readonly country: string }
  | { readonly restricted: true; readonly reason: "country_unknown"; readonly country: null }
  | { readonly restricted: false; readonly reason: "permitted_country"; readonly country: string }
  | { readonly restricted: false; readonly reason: "development_no_geolocation"; readonly country: null };

export interface JurisdictionEnvironment {
  readonly NODE_ENV?: string | undefined;
}

/**
 * Classifies a request by the country in the platform geolocation header.
 *
 * When the header is absent the result depends on the environment. In production it is `country_unknown` and
 * restricted: a deployment that does not receive the header cannot tell where a request comes from, and
 * guessing "allowed" would open the gate for everyone. Outside production it is not restricted, because a
 * local server never receives the header and the gated features could not be developed otherwise. A header
 * that is present and is not a two-letter code is `country_unknown` in every environment.
 *
 * This is a coarse network signal, not a compliance control. It reflects the address a request arrives from,
 * which a VPN changes, says nothing about the residence or the eligibility of a person, and can be forged
 * when the server is reachable without the platform proxy that sets the header. Read endpoints must not use
 * it: public data stays public everywhere.
 */
export function classifyJurisdiction(headers: Headers, env: JurisdictionEnvironment = process.env): Jurisdiction {
  const value = headers.get(GEOLOCATION_HEADER);
  if (value === null) {
    return env.NODE_ENV === "production"
      ? { restricted: true, reason: "country_unknown", country: null }
      : { restricted: false, reason: "development_no_geolocation", country: null };
  }
  const country = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { restricted: true, reason: "country_unknown", country: null };
  return RESTRICTED_COUNTRIES.has(country)
    ? { restricted: true, reason: "restricted_country", country }
    : { restricted: false, reason: "permitted_country", country };
}
