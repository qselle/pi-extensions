import { expect, test } from "bun:test";
import { TranscriptSearch } from "../../lib/transcript/search.ts";

test("phrase and hard word wraps map to all occupied rows", () => {
  const search = new TranscriptSearch(["Find the", "continuous", "identifier", "next"], ["Find the continuousidentifier next"]);
  expect(search.find("the continuousidentifier")).toEqual([{ firstLine: 0, lastLine: 2 }]);
  expect(search.find("continuousidentifier next")).toEqual([{ firstLine: 1, lastLine: 3 }]);
  expect(search.find("thecontinuous")).toEqual([]);
});

test("hard newlines and labels do not become invented matches", () => {
  const search = new TranscriptSearch(["You", "power", "shell"], ["You", "power", "shell"]);
  expect(search.find("powershell")).toEqual([]);
  expect(search.find("power shell")).toEqual([]);
  expect(search.find("You power")).toEqual([]);
});

test("ANSI, Unicode, repeated occurrences and normalized spacing retain row offsets", () => {
  const search = new TranscriptSearch(["\x1b[31mÉ界\x1b[0m", "🙂 foo", "é界🙂", "  foo"], ["É界🙂 foo é界🙂   foo"]);
  expect(search.find("É界🙂 foo")).toEqual([{ firstLine: 0, lastLine: 1 }, { firstLine: 2, lastLine: 3 }]);
  expect(search.find("   ")).toEqual([]);
});

test("quote continuation borders stay outside searchable text", () => {
  const search = new TranscriptSearch(["│ first", "│ second", "│ third"], ["│ first second third"], true);
  expect(search.find("first second third")).toEqual([{ firstLine: 0, lastLine: 2 }]);
  expect(search.find("│ second")).toEqual([{ firstLine: 1, lastLine: 1 }]);
});

test("unmappable native layouts fall back to literal row matching", () => {
  const search = new TranscriptSearch(["first", "unexpected", "second"], ["first second"]);
  expect(search.find("first second")).toEqual([]);
  expect(search.find("unexpected")).toEqual([{ firstLine: 1, lastLine: 1 }]);
});
