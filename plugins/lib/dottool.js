/**
 * dottool — build one DSH ToolDefinition from a compact description.
 *
 * All dot tools share the same output contract: `execute` returns a short
 * human-readable string (also a valid JSON value), rendered for the model as
 * a single text block. Errors thrown inside a tool body become error TEXT,
 * never a rejected execution — a dot must degrade, not crash its host fiber.
 */

/**
 * @param {object} def
 * @param {string} def.name        model-facing tool name (dot_*)
 * @param {string} def.description one-paragraph tool description
 * @param {object} [def.properties] JSON-Schema properties map
 * @param {string[]} [def.required] required argument names
 * @param {(args: object, exec: object) => Promise<string>} def.execute
 */
export function dotTool(def) {
  const properties = def.properties ?? {};
  const required = Array.isArray(def.required) && def.required.length > 0 ? def.required : undefined;
  return {
    name: def.name,
    description: def.description,
    parameters: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required !== undefined ? { required } : {}),
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }];
      },
      presentationMeta(_args, value) {
        return { tool: def.name };
      },
    },
    async execute(args, exec) {
      try {
        return await def.execute(args ?? {}, exec);
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
        return `dot tool error in ${def.name}: ${message}`;
      }
    },
  };
}
