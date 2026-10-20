import assert from "node:assert/strict";
import { test } from "node:test";
import { addCents } from "../src/index.js";

test("adds integer cents exactly", () => {
    assert.equal(addCents(10, 20), 30);
});

test("rejects floating-point amounts", () => {
    assert.throws(() => addCents(0.1, 0.2), TypeError);
});
