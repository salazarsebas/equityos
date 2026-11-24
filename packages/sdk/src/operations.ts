/**
 * Every operation of API v1, keyed by its `operationId` in the OpenAPI document. Each entry gives the method, the
 * path template and the decoders of `data` and `meta` of the success response. `apps/web/test/api/sdk.test.ts`
 * requires this table and the OpenAPI document to list the same operations with the same paths and shapes.
 */

import { array, type Decoder, json } from "./decode.ts";
import {
  asset,
  assetListMeta,
  compositionMeta,
  index,
  indexComposition,
  indexListMeta,
  indexSummary,
  indexVersion,
  portfolio,
  portfolioMeta,
  portfolioPlan,
  registryMeta,
  snapshotMeta,
  status,
  statusMeta,
} from "./schemas.ts";

export interface EnvelopeOperation {
  readonly method: "GET";
  readonly path: string;
  /** The success response is `{ data, meta }`. */
  readonly envelope: true;
  readonly data: Decoder<unknown>;
  readonly meta: Decoder<unknown>;
}

export interface DocumentOperation {
  readonly method: "GET";
  readonly path: string;
  /** The success response is a document returned as it is, without the envelope. */
  readonly envelope: false;
  readonly body: Decoder<unknown>;
}

export type Operation = EnvelopeOperation | DocumentOperation;

export const OPERATIONS = {
  listAssets: { method: "GET", path: "/assets", envelope: true, data: array(asset), meta: assetListMeta },
  getAsset: { method: "GET", path: "/assets/{address}", envelope: true, data: asset, meta: snapshotMeta },
  listIndexes: { method: "GET", path: "/indexes", envelope: true, data: array(indexSummary), meta: indexListMeta },
  getIndex: { method: "GET", path: "/indexes/{identifier}", envelope: true, data: index, meta: registryMeta },
  getIndexVersion: {
    method: "GET",
    path: "/indexes/{identifier}/versions/{version}",
    envelope: true,
    data: indexVersion,
    meta: registryMeta,
  },
  getIndexComposition: {
    method: "GET",
    path: "/indexes/{identifier}/composition",
    envelope: true,
    data: indexComposition,
    meta: compositionMeta,
  },
  getPortfolio: { method: "GET", path: "/portfolio", envelope: true, data: portfolio, meta: portfolioMeta },
  getPortfolioPlan: {
    method: "GET",
    path: "/portfolio/plan",
    envelope: true,
    data: portfolioPlan,
    meta: portfolioMeta,
  },
  getStatus: { method: "GET", path: "/status", envelope: true, data: status, meta: statusMeta },
  getOpenApiDocument: { method: "GET", path: "/openapi.json", envelope: false, body: json() },
} as const satisfies Readonly<Record<string, Operation>>;

export type OperationId = keyof typeof OPERATIONS;
