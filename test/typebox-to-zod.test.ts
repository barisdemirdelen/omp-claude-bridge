import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../typebox-to-zod.js";

describe("jsonSchemaToZodShape", () => {
  test("returns an empty shape for non-object schemas", () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({ type: "string" })).toEqual({});
    expect(jsonSchemaToZodShape({ type: "object" })).toEqual({});
  });

  test("distinguishes required from optional properties", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        prompt: { type: "string" },
        mode: { type: "string" },
      },
      required: ["prompt"],
    });
    const schema = z.object(shape);
    expect(schema.safeParse({ prompt: "hi" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ prompt: "hi", mode: "read" }).success).toBe(true);
  });

  test("validates primitive types, enums, arrays, and nested objects", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        count: { type: "integer" },
        enabled: { type: "boolean" },
        level: { enum: ["low", "high"] },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
      },
      required: ["count", "enabled", "level", "tags", "meta"],
    });
    const schema = z.object(shape);
    expect(
      schema.safeParse({
        count: 1,
        enabled: true,
        level: "low",
        tags: ["a"],
        meta: { anything: 1 },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        count: "1",
        enabled: true,
        level: "low",
        tags: ["a"],
        meta: {},
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        count: 1,
        enabled: true,
        level: "mid",
        tags: ["a"],
        meta: {},
      }).success,
    ).toBe(false);
  });

  test("carries descriptions through", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        prompt: { type: "string", description: "the ask" },
      },
      required: ["prompt"],
    });
    expect(shape.prompt.description).toBe("the ask");
  });
});
