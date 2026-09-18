/*
 * The Recorder page's own script: it renders the diff, makes every line addressable, and
 * exposes the one function Node calls.
 *
 * This file ships to the browser verbatim - `buildPage` inlines it - and the tests evaluate
 * this same source in a DOM, so there is exactly one implementation of the tagging and the
 * tests exercise the bytes that actually run.
 *
 * The contract with the rest of the pipeline is `window.spr.run(action)`, taking the action
 * objects `schemas/timeline.schema.json` defines and nothing else. Keeping it to one entry
 * point is what makes the Recorder (Milestone 2 step 4) small: it sleeps until `at_ms` and
 * passes the object straight through.
 *
 * Every method is a no-op when its target is missing, never a throw. A page that dies part-way
 * through a recording produces a video of a stack trace; one that skips an action produces a
 * video with one dull moment in it.
 */
(function () {
  "use strict";

  /**
   * diff2html compacts a rename into one name: `src/{old-name.ts → new-name.ts}`. Findings
   * name the new path, so that is what a row has to be tagged with.
   */
  var BRACED_RENAME = /^(.*)\{(.*) → (.*)\}(.*)$/;
  var ARROW = " → ";

  /** The new-side path for a file name as diff2html displays it. */
  function newPathOf(displayed) {
    var name = (displayed || "").trim();
    var braced = BRACED_RENAME.exec(name);
    if (braced) return braced[1] + braced[3] + braced[4];
    // No common prefix to compact: diff2html writes the two paths out in full.
    if (name.indexOf(ARROW) !== -1) return name.split(ARROW).pop().trim();
    return name;
  }

  /**
   * Tags every row with the file it belongs to and the line numbers it carries, so that every
   * selector afterwards reads attributes this page set rather than diff2html's own markup.
   *
   * This matters because diff2html's class names move between versions. Tagging here means an
   * upgrade can only break one function, and that function has a test.
   *
   * A row carries `data-old-line`, `data-new-line`, or both: a context line exists on both
   * sides at different numbers, which is why there is no single `data-side` attribute.
   */
  function tagRows(root) {
    var doc = root || document;
    var wrappers = doc.querySelectorAll(".d2h-file-wrapper");
    var tagged = 0;

    for (var i = 0; i < wrappers.length; i += 1) {
      var wrapper = wrappers[i];
      var label = wrapper.querySelector(".d2h-file-name");
      var file = newPathOf(label ? label.textContent : "");
      if (!file) continue;

      wrapper.setAttribute("data-file", file);

      var rows = wrapper.querySelectorAll("tr");
      for (var j = 0; j < rows.length; j += 1) {
        var row = rows[j];
        row.setAttribute("data-file", file);

        var oldNum = row.querySelector(".line-num1");
        var newNum = row.querySelector(".line-num2");
        var oldText = oldNum && oldNum.textContent ? oldNum.textContent.trim() : "";
        var newText = newNum && newNum.textContent ? newNum.textContent.trim() : "";

        if (oldText) row.setAttribute("data-old-line", oldText);
        if (newText) row.setAttribute("data-new-line", newText);
        tagged += 1;
      }
    }
    return { files: wrappers.length, rows: tagged };
  }

  /**
   * The rows of one file within a line range on one side.
   *
   * Attributes are compared rather than built into a selector string, because a file path is
   * not safe to interpolate into CSS and escaping it would be one more thing to get wrong.
   */
  function rowsIn(file, side, start, end) {
    var attribute = side === "old" ? "data-old-line" : "data-new-line";
    var all = document.querySelectorAll("tr[data-file]");
    var found = [];

    for (var i = 0; i < all.length; i += 1) {
      var row = all[i];
      if (row.getAttribute("data-file") !== file) continue;
      var raw = row.getAttribute(attribute);
      if (raw === null) continue;
      var line = Number(raw);
      if (Number.isInteger(line) && line >= start && line <= end) found.push(row);
    }
    return found;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  var HIGHLIGHT = "spr-hl";

  /* Scroll settling, for the pre-roll positioning the Recorder does before t0 (ADR-042).
   * `scrollTo` animates, and there is no portable event for "a smooth scroll finished", so
   * this reports stillness instead: the same offset seen on three consecutive polls. Three
   * rather than two because a single dropped frame mid-animation would otherwise read as
   * settled. */
  var STILL_POLLS = 3;
  var lastOffset = null;
  var stillFor = 0;

  window.spr = {
    /** Step 4 waits on this before it starts its clock. */
    ready: false,

    /**
     * Whether scrolling has come to rest. The Recorder waits on this after positioning the
     * page for the first step, so the video does not open mid-animation.
     */
    settled: function () {
      var offset = Math.round(window.scrollY);
      if (offset === lastOffset) stillFor += 1;
      else stillFor = 0;
      lastOffset = offset;
      return stillFor >= STILL_POLLS;
    },

    /** Exposed so the tests can tag real diff2html output without drawing it in a browser. */
    tagRows: tagRows,
    newPathOf: newPathOf,

    /** Draws the diff, tags it, and declares the page ready. */
    init: function (diffText, options) {
      var target = byId("spr-diff");
      if (!target) return;
      var ui = new window.Diff2HtmlUI(target, diffText, options);
      ui.draw();
      // The full bundle carries highlight.js; without it this is a no-op rather than an error.
      if (typeof ui.highlightCode === "function") ui.highlightCode();
      tagRows(document);
      window.spr.ready = true;
    },

    /** Brings a file's section into view. Files are all on one page, so this is a scroll. */
    openFile: function (file) {
      var wrapper = document.querySelector('.d2h-file-wrapper[data-file="' + cssValue(file) + '"]');
      if (wrapper) wrapper.scrollIntoView({ behavior: "auto", block: "start" });
    },

    /**
     * Centres a range. Animated, because a viewer watching the page move from one finding to
     * the next is following it - except when `instant` is set, which the Recorder uses for the
     * pre-roll before t0 (ADR-042). Nobody watches the pre-roll, and an animation there only
     * risks the video opening with the tail of it: sample-01 did, a smooth scroll that had not
     * started when the stillness check first looked.
     */
    scrollTo: function (file, side, start, end, instant) {
      var rows = rowsIn(file, side, start, end);
      if (rows.length === 0) return;
      // The middle of the range, so a long finding is centred rather than clipped at its top.
      rows[Math.floor(rows.length / 2)].scrollIntoView({
        behavior: instant ? "auto" : "smooth",
        block: "center",
      });
    },

    highlight: function (file, side, start, end) {
      var rows = rowsIn(file, side, start, end);
      for (var i = 0; i < rows.length; i += 1) rows[i].classList.add(HIGHLIGHT);
      if (rows.length > 0) {
        rows[0].classList.add("spr-hl-first");
        rows[rows.length - 1].classList.add("spr-hl-last");
      }
    },

    clear: function () {
      var lit = document.querySelectorAll("." + HIGHLIGHT);
      for (var i = 0; i < lit.length; i += 1) {
        lit[i].classList.remove(HIGHLIGHT, "spr-hl-first", "spr-hl-last");
      }
    },

    /**
     * The only function the Recorder calls. Dispatches one timeline action.
     * An action type this page does not know is ignored: a timeline from a newer schema should
     * degrade, not stop the recording. `options.instant` makes a scroll jump rather than
     * animate, for the positioning the Recorder does before t0.
     */
    run: function (action, options) {
      var instant = Boolean(options && options.instant);
      if (!action || typeof action.type !== "string") return;
      switch (action.type) {
        case "open_file":
          return window.spr.openFile(action.file);
        case "scroll_to":
          return window.spr.scrollTo(
            action.file,
            action.side,
            action.line_start,
            action.line_end,
            instant,
          );
        case "highlight":
          return window.spr.highlight(action.file, action.side, action.line_start, action.line_end);
        case "clear_highlight":
          return window.spr.clear();
        default:
          return undefined;
      }
    },
  };

  /** Escapes the two characters that would break out of a quoted attribute selector. */
  function cssValue(value) {
    return String(value === undefined || value === null ? "" : value).replace(/["\\]/g, "\\$&");
  }
})();
