export class CfKanbanToolError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "CfKanbanToolError";
    this.code = code;
    this.details = details;
  }
}

export function toolError(code, message, details = {}, cause) {
  return new CfKanbanToolError(code, message, details, cause === undefined ? {} : { cause });
}

export function serializeError(error) {
  if (error instanceof CfKanbanToolError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "UNEXPECTED_TOOL_FAILURE",
      message: error instanceof Error ? error.message : "Unexpected tool failure",
      details: {},
    },
  };
}

// Only known local failure codes may cross the capability-delivery boundary.
export function safeBrowserFailureCode(error) {
  return ["DELIVERY_HELPER_UNAVAILABLE", "DELIVERY_HELPER_FAILED", "BROWSER_RELAY_FAILED", "BROWSER_OPEN_TIMEOUT", "BROWSER_DELIVERY_UNAVAILABLE"].includes(error?.code)
    ? error.code : "BROWSER_DELIVERY_UNKNOWN";
}
