import { describe, expect, spyOn, test } from "bun:test";
import { ApiError, toApiError } from "../../src/server/api/errors";
import {
  API_VERSION,
  isoTimestamp,
  preflight,
  publicCache,
  redactedHost,
  route,
  serialize,
} from "../../src/server/api/http";
import { booleanParameter, parseAddress, parseQuery } from "../../src/server/api/params";
import {
  IneligibleTokenError,
  MalformedResponseError,
  MissingConfigurationError,
  MissingFeedError,
  StaleFeedError,
  TokenPausedError,
  UpstreamError,
} from "../../src/server/market/errors";
import { body, get } from "./support";

const TOKEN = "0xb20000000000000000000078ee7ce2fe4908108c";

describe("serialization", () => {
  test("writes a bigint of any size as an exact decimal string", () => {
    const uint256Max = 2n ** 256n - 1n;
    expect(serialize({ value: uint256Max, nested: [{ price: 12_982_480_034n }] })).toBe(
      `{"value":"${uint256Max}","nested":[{"price":"12982480034"}]}`,
    );
    expect(uint256Max.toString()).toHaveLength(78);
  });

  test("refuses a number that is not a safe integer instead of emitting a float", () => {
    expect(() => serialize({ price: 184.27 })).toThrow(TypeError);
    expect(() => serialize({ supply: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
    expect(() => serialize({ ratio: Number.NaN })).toThrow(TypeError);
    expect(serialize({ decimals: 8, count: 0 })).toBe('{"decimals":8,"count":0}');
  });

  test("formats time as ISO 8601 UTC with second precision", () => {
    expect(isoTimestamp(1_795_288_255)).toBe("2026-11-21T19:10:55Z");
    expect(isoTimestamp(0)).toBe("1970-01-01T00:00:00Z");
  });

  test("a cache lifetime that has run out is not cacheable", () => {
    expect(publicCache(15)).toBe("public, max-age=15");
    expect(publicCache(0)).toBe("no-store");
    expect(publicCache(-3)).toBe("no-store");
  });
});

describe("error mapping", () => {
  const cases: readonly [string, Error, number, string, Record<string, unknown> | null][] = [
    [
      "an unreachable source",
      new UpstreamError("base_rpc", "read failed"),
      503,
      "upstream_unavailable",
      { source: "base_rpc" },
    ],
    [
      "a malformed payload",
      new MalformedResponseError("coinbase_api", "$.tokens", "is not an array"),
      502,
      "upstream_malformed",
      { source: "coinbase_api" },
    ],
    [
      "missing configuration",
      new MissingConfigurationError("BASE_RPC_URL", "is not set"),
      500,
      "service_misconfigured",
      null,
    ],
    ["an ineligible token", new IneligibleTokenError(TOKEN, ["not_minted"]), 409, "ineligible_token", null],
    ["a paused token", new TokenPausedError(TOKEN), 409, "token_paused", null],
    ["a token without feed", new MissingFeedError(TOKEN, "none is mapped"), 409, "missing_feed", null],
    ["a stale feed", new StaleFeedError(TOKEN, 1), 409, "stale_feed", null],
    ["an unexpected error", new Error("connect ECONNREFUSED 10.0.0.7:8545"), 500, "internal_error", null],
  ];

  for (const [name, error, status, code, details] of cases) {
    test(`${name} is ${status} ${code}`, () => {
      const mapped = toApiError(error);
      expect(mapped).toMatchObject({ status, code, details });
      expect(mapped.message).not.toContain(error.message);
    });
  }

  test("an ApiError passes through unchanged", () => {
    const error = new ApiError(404, "asset_not_found", "No listed asset has this token address.");
    expect(toApiError(error)).toBe(error);
  });
});

describe("route wrapper", () => {
  test("a 503 carries Retry-After, the version, open CORS and is never stored", async () => {
    const handler = route(() => {
      throw new UpstreamError("coinbase_api", "responded with HTTP 503", { status: 503 });
    });
    const response = await handler(get("/api/v1/assets"), undefined);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("X-EquityOS-Api-Version")).toBe(API_VERSION);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect((await body(response)).error).toEqual({
      code: "upstream_unavailable",
      message: "A data source did not answer and no recent copy of its data is available. Retry shortly.",
      details: { source: "coinbase_api" },
    });
  });

  test("a 500 is logged as one line without any message, and answers without the variable name or the cause", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cause = new MissingConfigurationError("BASE_RPC_URL", "is not set");
      const handler = route(() => {
        throw cause;
      });
      const response = await handler(get("/api/v1/status"), undefined);
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(text).not.toContain("BASE_RPC_URL");
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "service_misconfigured",
          message: "The server is not configured to read its data sources.",
          details: null,
        },
      });
      expect(log).toHaveBeenCalledWith("api /api/v1/status: service_misconfigured (MissingConfigurationError)");
    } finally {
      log.mockRestore();
    }
  });

  test("an unexpected failure is logged with its error classes and a redacted host, never its message or URL", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const url = "https://base-mainnet.g.example-rpc.com/v2/SECRETKEY?apikey=SECRET2";
      const transport = Object.assign(new Error(`request to ${url} failed`), { url });
      const handler = route(() => {
        throw new TypeError(`wrapped: ${url}`, { cause: transport });
      });
      expect((await handler(get("/api/v1/assets"), undefined)).status).toBe(500);
      const [line, ...rest] = log.mock.calls[0] ?? [];
      expect(rest).toEqual([]);
      expect(line).toBe("api /api/v1/assets: internal_error (TypeError < Error) host *.example-rpc.com");
      expect(String(line)).not.toContain("SECRET");
      expect(redactedHost(Object.assign(new Error("x"), { url: "http://127.0.0.1:8545/key" }))).toBe("ip-address");
      expect(redactedHost(Object.assign(new Error("x"), { url: "https://localhost/key" }))).toBe("localhost");
      expect(redactedHost(new Error("no url"))).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  test("a client error is not logged", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = route(() => {
        throw new ApiError(400, "invalid_parameter", "Unknown query parameter.");
      });
      expect((await handler(get("/api/v1/assets"), undefined)).status).toBe(400);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("the preflight allows GET from any origin", () => {
    const response = preflight();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("request validation", () => {
  test("an address is accepted in any letter case and returned in lowercase", () => {
    expect(parseAddress("0xB20000000000000000000078EE7CE2FE4908108C")).toBe(TOKEN);
    expect(parseAddress(TOKEN)).toBe(TOKEN);
  });

  for (const raw of ["", "0x", "0x1234", TOKEN.slice(2), `${TOKEN}00`, `0x${"g".repeat(40)}`, "nvda"]) {
    test(`"${raw}" is not an address`, () => {
      expect(() => parseAddress(raw)).toThrow(
        expect.objectContaining({ status: 400, code: "invalid_address", details: { parameter: "address" } }),
      );
    });
  }

  test("an unknown or repeated query parameter is rejected by name", () => {
    expect(() => parseQuery(get("/api/v1/assets?eligble=true"), ["eligible"])).toThrow(
      expect.objectContaining({
        status: 400,
        code: "invalid_parameter",
        details: { parameter: "eligble", accepted: ["eligible"] },
      }),
    );
    expect(() => parseQuery(get("/api/v1/assets?eligible=true&eligible=false"), ["eligible"])).toThrow(
      expect.objectContaining({ status: 400, code: "invalid_parameter", details: { parameter: "eligible" } }),
    );
  });

  test("a boolean parameter accepts only true and false", () => {
    const query = (search: string) => parseQuery(get(`/api/v1/assets${search}`), ["eligible"]);
    expect(booleanParameter(query(""), "eligible")).toBeUndefined();
    expect(booleanParameter(query("?eligible=true"), "eligible")).toBe(true);
    expect(booleanParameter(query("?eligible=false"), "eligible")).toBe(false);
    for (const value of ["1", "TRUE", "yes", ""]) {
      expect(() => booleanParameter(query(`?eligible=${value}`), "eligible")).toThrow(
        expect.objectContaining({ status: 400, code: "invalid_parameter" }),
      );
    }
  });
});
