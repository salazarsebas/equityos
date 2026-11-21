import { describe, expect, test } from "bun:test";
import { classifyJurisdiction, GEOLOCATION_HEADER } from "../src/server/jurisdiction";

const production = { NODE_ENV: "production" };
const development = { NODE_ENV: "development" };

function from(country?: string): Headers {
  return new Headers(country === undefined ? {} : { [GEOLOCATION_HEADER]: country });
}

describe("jurisdiction gate", () => {
  test("a request located in the United States is restricted in every environment", () => {
    for (const env of [production, development, {}]) {
      expect(classifyJurisdiction(from("US"), env)).toEqual({
        restricted: true,
        reason: "restricted_country",
        country: "US",
      });
    }
  });

  test("the territories of the United States are restricted under their own country codes", () => {
    for (const country of ["AS", "GU", "MP", "PR", "UM", "VI"]) {
      expect(classifyJurisdiction(from(country), production)).toMatchObject({
        restricted: true,
        reason: "restricted_country",
        country,
      });
    }
  });

  test("a request located elsewhere is permitted", () => {
    for (const country of ["DE", "BR", "JP", "CA", "MX"]) {
      expect(classifyJurisdiction(from(country), production)).toEqual({
        restricted: false,
        reason: "permitted_country",
        country,
      });
    }
  });

  test("the header is read without regard to case or surrounding space", () => {
    expect(classifyJurisdiction(from("us"), production).restricted).toBe(true);
    expect(classifyJurisdiction(from(" de "), production)).toMatchObject({ restricted: false, country: "DE" });
  });

  test("without the header production fails closed", () => {
    expect(classifyJurisdiction(from(), production)).toEqual({
      restricted: true,
      reason: "country_unknown",
      country: null,
    });
  });

  test("without the header a server outside production is not restricted", () => {
    for (const env of [development, { NODE_ENV: "test" }, {}]) {
      expect(classifyJurisdiction(from(), env)).toEqual({
        restricted: false,
        reason: "development_no_geolocation",
        country: null,
      });
    }
  });

  test("a header that is not a two-letter code is unknown and restricted in every environment", () => {
    for (const value of ["", "USA", "U", "1A", "XX-YY", "unknown"]) {
      for (const env of [production, development]) {
        expect(classifyJurisdiction(from(value), env)).toEqual({
          restricted: true,
          reason: "country_unknown",
          country: null,
        });
      }
    }
  });
});
