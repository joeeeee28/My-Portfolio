/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calendar from "../calendar.js";
import type * as finance from "../finance.js";
import type * as goals from "../goals.js";
import type * as habits from "../habits.js";
import type * as journal from "../journal.js";
import type * as learning from "../learning.js";
import type * as profiles from "../profiles.js";
import type * as projects from "../projects.js";
import type * as seed from "../seed.js";
import type * as tasks from "../tasks.js";
import type * as vision from "../vision.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  calendar: typeof calendar;
  finance: typeof finance;
  goals: typeof goals;
  habits: typeof habits;
  journal: typeof journal;
  learning: typeof learning;
  profiles: typeof profiles;
  projects: typeof projects;
  seed: typeof seed;
  tasks: typeof tasks;
  vision: typeof vision;
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
