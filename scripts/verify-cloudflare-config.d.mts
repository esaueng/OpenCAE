export function parseJsonc(source: string, label?: string): unknown;
export function readCloudflareConfigs(baseDir?: string): {
  defaultConfig: unknown;
  staticConfig: unknown;
  packageJson: unknown;
};
export function validateCloudflareConfigs(configs: {
  defaultConfig?: unknown;
  staticConfig?: unknown;
  packageJson?: unknown;
}): void;
