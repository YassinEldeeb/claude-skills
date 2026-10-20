import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/checkout.js";

test("totals a cart", () => assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1, discount: 0.2 }]), 24));
