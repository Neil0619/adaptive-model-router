function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "number" ? "number" : typeof value;
}

export function validateSchema(schema, value, path = "input") {
  const errors = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actualType = typeOf(value);
  if (allowedTypes.length && !allowedTypes.includes(actualType) && !(actualType === "integer" && allowedTypes.includes("number"))) {
    return [`${path} must be ${allowedTypes.join(" or ")}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validateSchema(childSchema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

export function assertSchema(schema, value, label = "input") {
  const errors = validateSchema(schema, value, label);
  if (errors.length) {
    const error = new Error(errors.slice(0, 4).join("; "));
    error.code = "INVALID_INPUT";
    throw error;
  }
}
