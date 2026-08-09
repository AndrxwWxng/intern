/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as brain from "../brain.js";
import type * as connections from "../connections.js";
import type * as gmail from "../gmail.js";
import type * as http from "../http.js";
import type * as interns from "../interns.js";
import type * as log from "../log.js";
import type * as outbox from "../outbox.js";
import type * as providers from "../providers.js";
import type * as slack from "../slack.js";
import type * as tokens from "../tokens.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  brain: typeof brain;
  connections: typeof connections;
  gmail: typeof gmail;
  http: typeof http;
  interns: typeof interns;
  log: typeof log;
  outbox: typeof outbox;
  providers: typeof providers;
  slack: typeof slack;
  tokens: typeof tokens;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
