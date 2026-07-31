import assert from "node:assert/strict";
import { Input } from "@earendil-works/pi-tui";

const input = new Input();
for (const character of "actual-secret") input.handleInput(character);
for (let index = 0; index < 6; index++) input.handleInput("\x1b[D");

const value = input.getValue();
input.setValue("•".repeat(value.length));
const rendered = input.render(60).join("\n");
input.setValue(value);

assert(!rendered.includes(value));
assert(rendered.includes("••••••"));
input.handleInput("X");
assert.equal(input.getValue(), "actual-Xsecret");

console.log("masked input cursor preserved");
