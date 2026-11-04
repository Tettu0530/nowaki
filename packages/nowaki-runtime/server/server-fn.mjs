// Server function helpers: input validation with any Standard Schema library (zod, valibot,
// arktype, ...; https://standardschema.dev) and errors whose message is meant for the client.

/// Thrown from a server function, its status and message reach the client (any other error is a
/// generic 500 in production). `data` is sent as-is, so keep it free of secrets.
export class ServerFnError extends Error {
  constructor(message, { status = 400, data } = {}) {
    super(message);
    this.name = "ServerFnError";
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400;
    this.data = data;
  }
}

/// `export const addTodo = serverFn(schema, async (input, ...rest) => ...)`: the first argument is
/// validated against `schema` before `impl` runs; invalid input is a 400 with the issues.
export function serverFn(schema, impl) {
  const std = schema?.["~standard"];
  if (!std || typeof std.validate !== "function") {
    throw new TypeError("serverFn(schema, impl): schema must implement Standard Schema (~standard.validate)");
  }
  if (typeof impl !== "function") throw new TypeError("serverFn(schema, impl): impl must be a function");
  const fn = async (input, ...rest) => {
    const result = await std.validate(input);
    if (result.issues) {
      throw new ServerFnError("Invalid input", {
        status: 400,
        data: {
          issues: result.issues.map((i) => ({
            message: String(i.message),
            path: i.path?.map((p) => (typeof p === "object" && p !== null ? p.key : p)),
          })),
        },
      });
    }
    return impl(result.value, ...rest);
  };
  fn.__nowakiValidated = true;
  return fn;
}
