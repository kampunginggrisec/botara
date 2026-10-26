import { describe, expect, test } from "bun:test";
import { insertPlainText, insertVariable, variableOptions, variableToken, VARIABLE_OPTIONS } from "./variables";

/**
 * Variable picker model (variables package #1): the catalogue stays in
 * sync with the @botara/shared engine roots, and the insertion math is
 * exact (the component itself is a thin shell over insertIntoElement).
 */
describe("variable catalogue", () => {
  test("every documented root is offered", () => {
    const tokens = VARIABLE_OPTIONS.map((o) => o.token);
    for (const expected of [
      "contact.name", "contact.externalId", "contact.channel", "contact.tags",
      "channel.name", "channel.platform", "workspace.name",
      "system.date", "system.time", "system.now",
    ]) {
      expect(tokens).toContain(expected);
    }
  });

  test("vars options are flow-only", () => {
    expect(variableOptions(false).some((o) => o.group === "vars")).toBe(false);
    expect(variableOptions(true).some((o) => o.group === "vars")).toBe(true);
    // Non-flow surfaces still get every other group.
    expect(variableOptions(false).length).toBe(VARIABLE_OPTIONS.length - 1);
  });

  test("variableToken wraps a path in braces", () => {
    expect(variableToken("contact.name")).toBe("{{contact.name}}");
  });
});

describe("insertVariable", () => {
  test("inserts at the caret and reports the caret after the token", () => {
    const r = insertVariable("Halo !", "contact.name", 5, 5);
    expect(r.text).toBe("Halo {{contact.name}}!");
    expect(r.caret).toBe(5 + "{{contact.name}}".length);
  });

  test("replaces the current selection", () => {
    const r = insertVariable("Halo NAME!", "contact.name", 5, 9);
    expect(r.text).toBe("Halo {{contact.name}}!");
  });

  test("a null selection appends at the end", () => {
    const r = insertVariable("Halo ", "workspace.name", null, null);
    expect(r.text).toBe("Halo {{workspace.name}}");
    expect(r.caret).toBe(r.text.length);
  });

  test("inserting into an empty field yields just the token", () => {
    const r = insertVariable("", "system.date", 0, 0);
    expect(r.text).toBe("{{system.date}}");
    expect(r.caret).toBe("{{system.date}}".length);
  });
});
