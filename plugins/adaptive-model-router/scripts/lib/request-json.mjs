import { requestError } from "./request-errors.mjs";

// Only external request boundaries may classify JSON syntax as caller input.
// A SyntaxError from persisted state or an imported runtime is an internal failure.
export function parseRequestJson(value) {
  try { return JSON.parse(value); }
  catch (error) {
    if (error instanceof SyntaxError) throw requestError("INVALID_INPUT", "Malformed JSON request.");
    throw error;
  }
}
