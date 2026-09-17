/**
 * The page's contract, as TypeScript sees it from Node.
 *
 * `spr.js` is plain browser JavaScript (ADR-030) and is not compiled, so this is the only
 * description of `window.spr` the type checker has. It exists so `record.ts` can call
 * `page.evaluate(() => window.spr.run(a))` without `any`, which the project forbids.
 *
 * `spr` is optional because a page that has not finished loading has no `window.spr` yet, and
 * the Recorder's own readiness wait is what proves otherwise.
 */
import type { Timeline } from "../../contracts/generated/timeline.js";

declare global {
  /**
   * The browser global itself. The project's tsconfig has no DOM lib - deliberately, since the
   * only browser code here is plain JavaScript - so `window` has to be declared alongside its
   * shape. It exists only inside `page.evaluate` callbacks, which run in the browser.
   */
  var window: Window;

  /**
   * Just enough of `document` for the assertions the Recorder's test makes inside
   * `page.evaluate` - counting the rows a highlight lit. Deliberately minimal: this is not a
   * DOM lib, and anything that wants more of one should be in `spr.js` instead.
   */
  var document: {
    querySelectorAll(selectors: string): { readonly length: number };
  };

  interface Window {
    spr?: {
      /** True once the diff is drawn and every row is tagged. */
      ready: boolean;
      /** The single entry point: dispatches one timeline action. */
      run(action: Timeline["actions"][number]): void;
    };
  }
}

export {};
