import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoringWriterProjection } from "../scripts/lib/scoring-boundary.mjs";

const scorer = readFileSync(new URL("../scripts/lib/scorer.mjs", import.meta.url), "utf8").replace(/\r\n/gu, "\n");

test("the real scoring boundary accepts LF and CRLF without normalizing protected writer bytes", () => {
  const lf = scoringWriterProjection(scorer);
  const crlf = scoringWriterProjection(scorer.replaceAll("\n", "\r\n"));
  assert.equal(crlf, lf.replaceAll("\n", "\r\n"));
  assert.notEqual(crlf, lf, "line-ending changes outside the pure function remain writer changes");
});

test("both line endings retain the strict pure scoring grammar", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = scorer.replaceAll("\n", newline);
    const marker = 'const text = `${phase} ${normalizeText(goal)}`;';
    assert.throws(() => scoringWriterProjection(source.replace(marker, marker + " doWork();")), /Unproven scorer writer change/);
    assert.throws(() => scoringWriterProjection(source.replace(marker, "const text = readExternalState();")), /Unproven scorer writer change/);
    const appended = source + newline + "unrelatedWriterChange();";
    assert.notEqual(scoringWriterProjection(source), scoringWriterProjection(appended));
  }
});
