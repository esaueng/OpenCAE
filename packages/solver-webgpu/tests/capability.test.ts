import { describe, expect, test } from "vitest";
import { detectWebGPUCapability } from "../src/capability";

describe("detectWebGPUCapability", () => {
  test("reports unavailable when navigator is missing", async () => {
    const capability = await detectWebGPUCapability({ navigator: undefined });

    expect(capability).toEqual({
      available: false,
      status: "unavailable",
      reason: "navigator-unavailable",
      message: "Navigator is not available in this environment."
    });
  });

  test("reports unavailable when navigator.gpu is missing", async () => {
    const capability = await detectWebGPUCapability({ navigator: {} });

    expect(capability).toEqual({
      available: false,
      status: "unavailable",
      reason: "webgpu-unavailable",
      message: "WebGPU is not available in this browser."
    });
  });

  test("reports unavailable when requestAdapter returns null", async () => {
    const capability = await detectWebGPUCapability({
      navigator: {
        gpu: {
          requestAdapter: async () => null
        }
      }
    });

    expect(capability).toEqual({
      available: false,
      status: "unavailable",
      reason: "adapter-unavailable",
      message: "WebGPU is available, but no compatible GPU adapter was found."
    });
  });

  test("reports error when requestAdapter throws", async () => {
    const capability = await detectWebGPUCapability({
      navigator: {
        gpu: {
          requestAdapter: async () => {
            throw new Error("adapter blocked");
          }
        }
      }
    });

    expect(capability).toEqual({
      available: false,
      status: "error",
      reason: "request-adapter-failed",
      message: "Unable to request a WebGPU adapter: adapter blocked"
    });
  });

  test("reports available when an adapter is available", async () => {
    const capability = await detectWebGPUCapability({
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            name: "Mock Adapter",
            features: new Set(["texture-compression-bc", "timestamp-query"]),
            limits: {
              maxBufferSize: 268435456,
              maxBindGroups: 4,
              nonNumericLimit: "ignored"
            }
          })
        }
      }
    });

    expect(capability).toEqual({
      available: true,
      status: "available",
      reason: "webgpu-available",
      message: "WebGPU is available.",
      adapter: {
        name: "Mock Adapter",
        features: ["texture-compression-bc", "timestamp-query"],
        limits: {
          maxBufferSize: 268435456,
          maxBindGroups: 4
        }
      }
    });
  });

  test("serializes array-like features and Map limits into plain data", async () => {
    const capability = await detectWebGPUCapability({
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            features: ["shader-f16"],
            limits: new Map<string, number>([["maxStorageBufferBindingSize", 134217728]])
          })
        }
      }
    });

    expect(capability.adapter?.features).toEqual(["shader-f16"]);
    expect(capability.adapter?.limits).toEqual({
      maxStorageBufferBindingSize: 134217728
    });
  });
});
