(function () {
  "use strict";

  function resolvePointer(spec, pointer) {
    if (!pointer?.startsWith("#/") || !spec) return null;
    return pointer.slice(2).split("/").reduce((value, key) => {
      const decoded = key.replace(/~1/g, "/").replace(/~0/g, "~");
      return value?.[decoded];
    }, spec);
  }

  function sampleString(schema) {
    const token = () => Math.random().toString(36).slice(2, 10);
    const randomDate = () => {
      const start = Date.UTC(2024, 0, 1);
      const end = Date.UTC(2028, 11, 31);
      return new Date(start + Math.random() * (end - start));
    };
    const formatSamples = {
      date: () => randomDate().toISOString().slice(0, 10),
      "date-time": () => randomDate().toISOString(),
      email: () => `user.${token()}@example.com`,
      uuid: () => typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `xxxxxxxx-xxxx-4xxx-yxxx-${token()}${token().slice(0, 4)}`.replace(/[xy]/g, character => {
        const value = Math.random() * 16 | 0;
        return (character === "x" ? value : value & 3 | 8).toString(16);
      }),
      uri: () => `https://example.com/${token()}`,
      url: () => `https://example.com/${token()}`,
      hostname: () => `${token()}.example.com`,
      ipv4: () => `192.0.2.${Math.ceil(Math.random() * 254)}`,
      ipv6: () => `2001:db8::${Math.ceil(Math.random() * 999)}`,
      binary: () => `binary-${token()}`,
      byte: () => btoa(token())
    };
    return formatSamples[schema.format]?.() ?? `${schema.title || "text"}-${token()}`;
  }

  function randomNumber(schema, integer) {
    const minimum = Number.isFinite(schema.minimum) ? schema.minimum : integer ? 1 : 0;
    const maximum = Number.isFinite(schema.maximum) ? schema.maximum : minimum + 100;
    const value = minimum + Math.random() * Math.max(maximum - minimum, 1);
    return integer ? Math.floor(value) : Number(value.toFixed(2));
  }

  function generate(schema, spec, options = {}) {
    const seen = options.seen ?? new Set();
    const depth = options.depth ?? 0;
    if (options.example !== undefined) return options.example;
    if (!schema || typeof schema !== "object") return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.examples?.length) return schema.examples[0];
    if (schema.default !== undefined) return schema.default;
    if (schema.const !== undefined) return schema.const;
    if (schema.enum?.length) return schema.enum[Math.floor(Math.random() * schema.enum.length)];
    if (depth > 12) return null;

    if (schema.$ref) {
      if (seen.has(schema.$ref)) return null;
      const resolved = resolvePointer(spec, schema.$ref);
      if (!resolved) return null;
      return generate(resolved, spec, {
        ...options,
        depth: depth + 1,
        seen: new Set([...seen, schema.$ref]),
        example: undefined
      });
    }

    if (schema.allOf?.length) {
      const values = schema.allOf.map(part => generate(part, spec, { ...options, depth: depth + 1, seen, example: undefined }));
      if (values.every(value => value && typeof value === "object" && !Array.isArray(value))) {
        return Object.assign({}, ...values);
      }
      return values.find(value => value !== null) ?? null;
    }
    const branches = schema.anyOf ?? schema.oneOf;
    if (branches?.length) {
      const branch = branches.find(item => !isNullSchema(item)) ?? branches[0];
      return generate(branch, spec, { ...options, depth: depth + 1, seen, example: undefined });
    }

    const inferredType = schema.type || (schema.properties ? "object" : schema.items ? "array" : null);
    if (inferredType === "object") {
      const result = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (property?.readOnly && options.forRequest) continue;
        if (property?.writeOnly && options.forResponse) continue;
        result[name] = generate(property, spec, {
          depth: depth + 1,
          seen,
          forRequest: options.forRequest,
          forResponse: options.forResponse
        });
      }
      return result;
    }
    if (inferredType === "array") {
      const count = Math.max(1, Math.min(schema.minItems ?? 1, 3));
      return Array.from({ length: count }, () => generate(schema.items ?? {}, spec, {
        depth: depth + 1,
        seen,
        forRequest: options.forRequest,
        forResponse: options.forResponse
      }));
    }
    if (inferredType === "integer") return randomNumber(schema, true);
    if (inferredType === "number") return randomNumber(schema, false);
    if (inferredType === "boolean") return Math.random() >= 0.5;
    if (inferredType === "null") return null;
    return sampleString(schema);
  }

  function pointerName(reference) {
    const encoded = String(reference ?? "").split("/").pop() || "Schema";
    try { return decodeURIComponent(encoded.replace(/~1/g, "/").replace(/~0/g, "~")); }
    catch { return encoded; }
  }

  function describe(schema, spec, seen = new Set()) {
    if (!schema || typeof schema !== "object") return "unknown";
    if (schema.$ref) {
      const name = pointerName(schema.$ref);
      if (seen.has(schema.$ref)) return name;
      const resolved = resolvePointer(spec, schema.$ref);
      if (!resolved) return name;
      const next = new Set([...seen, schema.$ref]);
      if (resolved.type === "array" || (resolved.items && !resolved.properties)) return describe(resolved, spec, next);
      if (resolved.enum || resolved.oneOf || resolved.anyOf) return describe(resolved, spec, next);
      if (resolved.allOf && !resolved.properties && !resolved.type) return describe(resolved, spec, next);
      if (resolved.type && resolved.type !== "object" && !resolved.properties) return describe(resolved, spec, next);
      return name;
    }
    if (schema.oneOf?.length) return schema.oneOf.map(item => describe(item, spec, seen)).join(" | ");
    if (schema.anyOf?.length) return schema.anyOf.map(item => describe(item, spec, seen)).join(" | ");
    if (schema.allOf?.length) return schema.allOf.map(item => describe(item, spec, seen)).join(" & ");
    if (schema.enum?.length) return `${schema.type || "enum"} (${schema.enum.map(String).join(" | ")})`;
    if (schema.type === "array" || schema.items) return `array<${describe(schema.items ?? {}, spec, seen)}>`;
    const type = schema.type || (schema.properties ? "object" : "unknown");
    return schema.format ? `${type} (${schema.format})` : type;
  }

  function isNullSchema(schema) {
    if (!schema || typeof schema !== "object") return false;
    if (schema.type === "null") return true;
    if (Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every(type => type === "null")) return true;
    return schema.const === null;
  }

  function shape(schema, spec, seen = new Set()) {
    if (!schema || typeof schema !== "object") return "unknown";
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return pointerName(schema.$ref);
      const resolved = resolvePointer(spec, schema.$ref);
      return resolved ? shape(resolved, spec, new Set([...seen, schema.$ref])) : pointerName(schema.$ref);
    }
    if (schema.allOf?.length) {
      const parts = schema.allOf.map(item => shape(item, spec, seen));
      if (parts.every(part => part && typeof part === "object" && !Array.isArray(part))) return Object.assign({}, ...parts);
    }
    const branches = schema.anyOf ?? schema.oneOf;
    if (branches?.length) {
      for (const branch of branches) {
        if (isNullSchema(branch)) continue;
        const shaped = shape(branch, spec, seen);
        if (shaped && typeof shaped === "object") return shaped;
      }
    }
    if (schema.type === "array" || (schema.items && !schema.properties)) {
      const itemShape = shape(schema.items ?? {}, spec, seen);
      if (itemShape && typeof itemShape === "object") return [itemShape];
      return describe(schema, spec, seen);
    }
    if (schema.properties) {
      return Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, shape(value, spec, seen)]));
    }
    return describe(schema, spec, seen);
  }

  window.ApiMock = { generate, describe, shape };
})();
