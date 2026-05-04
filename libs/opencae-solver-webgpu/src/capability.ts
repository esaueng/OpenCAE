export type WebGPUCapability = {
  available: boolean;
  status: "available" | "unavailable" | "error";
  reason:
    | "webgpu-available"
    | "navigator-unavailable"
    | "webgpu-unavailable"
    | "adapter-unavailable"
    | "request-adapter-failed";
  message: string;
  adapter?: {
    name?: string;
    features: string[];
    limits: Record<string, number>;
  };
};

export type WebGPUCapabilityOptions = {
  navigator?: {
    gpu?: {
      requestAdapter?: () => Promise<unknown>;
    };
  };
};

type AdapterLike = {
  name?: unknown;
  features?: unknown;
  limits?: unknown;
};

export async function detectWebGPUCapability(
  options: WebGPUCapabilityOptions = {}
): Promise<WebGPUCapability> {
  const navigatorLike =
    "navigator" in options
      ? options.navigator
      : (globalThis.navigator as WebGPUCapabilityOptions["navigator"] | undefined);

  if (!navigatorLike) {
    return {
      available: false,
      status: "unavailable",
      reason: "navigator-unavailable",
      message: "Navigator is not available in this environment."
    };
  }

  if (!navigatorLike.gpu || typeof navigatorLike.gpu.requestAdapter !== "function") {
    return {
      available: false,
      status: "unavailable",
      reason: "webgpu-unavailable",
      message: "WebGPU is not available in this browser."
    };
  }

  let adapter: unknown;
  try {
    adapter = await navigatorLike.gpu.requestAdapter();
  } catch (error) {
    return {
      available: false,
      status: "error",
      reason: "request-adapter-failed",
      message: `Unable to request a WebGPU adapter: ${formatError(error)}`
    };
  }

  if (!adapter) {
    return {
      available: false,
      status: "unavailable",
      reason: "adapter-unavailable",
      message: "WebGPU is available, but no compatible GPU adapter was found."
    };
  }

  return {
    available: true,
    status: "available",
    reason: "webgpu-available",
    message: "WebGPU is available.",
    adapter: serializeAdapter(adapter as AdapterLike)
  };
}

function serializeAdapter(adapter: AdapterLike): WebGPUCapability["adapter"] {
  const serialized: WebGPUCapability["adapter"] = {
    features: serializeFeatures(adapter.features),
    limits: serializeLimits(adapter.limits)
  };

  if (typeof adapter.name === "string" && adapter.name.length > 0) {
    serialized.name = adapter.name;
  }

  return serialized;
}

function serializeFeatures(features: unknown): string[] {
  if (!features || typeof (features as Iterable<unknown>)[Symbol.iterator] !== "function") {
    return [];
  }

  return Array.from(features as Iterable<unknown>)
    .filter((feature): feature is string => typeof feature === "string")
    .sort();
}

function serializeLimits(limits: unknown): Record<string, number> {
  if (!limits) {
    return {};
  }

  const entries =
    limits instanceof Map
      ? Array.from(limits.entries())
      : Object.entries(limits as Record<string, unknown>);

  return Object.fromEntries(
    entries.filter(
      (entry): entry is [string, number] =>
        typeof entry[0] === "string" && typeof entry[1] === "number"
    )
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "unknown error";
}
