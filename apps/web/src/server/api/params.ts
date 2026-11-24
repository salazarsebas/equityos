import "server-only";
import type { Address } from "viem";
import { ApiError } from "./errors";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parses a 20-byte hex address in any letter case and returns it in lowercase, the form every token is keyed
 * by. A checksum is not required and a wrong one is not rejected: the address is only used as a lookup key.
 *
 * @throws {ApiError} 400 `invalid_address`
 */
export function parseAddress(raw: string): Address {
  if (!ADDRESS_PATTERN.test(raw)) {
    throw new ApiError(400, "invalid_address", "The address is not a 0x-prefixed 20-byte hex string.", {
      parameter: "address",
    });
  }
  return `0x${raw.slice(2).toLowerCase()}`;
}

function invalidParameter(parameter: string, message: string, accepted?: readonly string[]): ApiError {
  return new ApiError(400, "invalid_parameter", message, accepted ? { parameter, accepted } : { parameter });
}

/**
 * The query parameters of a request, after checking that each one is known and given once. An unknown
 * parameter is an error and not ignored, so that a misspelled filter cannot silently return unfiltered data.
 *
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function parseQuery(request: Request, known: readonly string[]): URLSearchParams {
  const query = new URL(request.url).searchParams;
  for (const name of new Set(query.keys())) {
    if (!known.includes(name)) {
      throw invalidParameter(name, `Unknown query parameter "${name}".`, known);
    }
    if (query.getAll(name).length > 1) throw invalidParameter(name, `Query parameter "${name}" is given twice.`);
  }
  return query;
}

/**
 * Reads a boolean query parameter. Only the literals `true` and `false` are accepted.
 *
 * @returns `undefined` when the parameter is absent
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function booleanParameter(query: URLSearchParams, name: string): boolean | undefined {
  const value = query.get(name);
  if (value === null) return undefined;
  if (value !== "true" && value !== "false") {
    throw invalidParameter(name, `Query parameter "${name}" must be true or false.`, ["true", "false"]);
  }
  return value === "true";
}

/**
 * Reads a non-negative integer query parameter written in decimal digits, within `[min, max]`.
 *
 * @returns `undefined` when the parameter is absent
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function integerParameter(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const value = query.get(name);
  if (value === null) return undefined;
  const parsed = /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalidParameter(name, `Query parameter "${name}" must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

/**
 * Reads a query parameter that must be present and not empty.
 *
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function requiredParameter(query: URLSearchParams, name: string): string {
  const value = query.get(name);
  if (value === null || value === "") throw invalidParameter(name, `Query parameter "${name}" is required.`);
  return value;
}

/**
 * Reads a non-negative integer written in decimal digits, within `[0, max]`, as a `bigint`: an amount that can
 * exceed 2^53.
 *
 * @returns `undefined` when the parameter is absent
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function amountParameter(query: URLSearchParams, name: string, max: bigint): bigint | undefined {
  const value = query.get(name);
  if (value === null) return undefined;
  const parsed = /^(0|[1-9][0-9]{0,29})$/.test(value) ? BigInt(value) : null;
  if (parsed === null || parsed > max) {
    throw invalidParameter(name, `Query parameter "${name}" must be an integer from 0 to ${max} in decimal digits.`);
  }
  return parsed;
}

/**
 * Reads a parameter that takes one of a fixed set of values.
 *
 * @returns `undefined` when the parameter is absent
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function choiceParameter<T extends string>(
  query: URLSearchParams,
  name: string,
  accepted: readonly T[],
): T | undefined {
  const value = query.get(name);
  if (value === null) return undefined;
  const found = accepted.find((choice) => choice === value);
  if (found === undefined) {
    throw invalidParameter(name, `Query parameter "${name}" must be one of ${accepted.join(", ")}.`, accepted);
  }
  return found;
}
