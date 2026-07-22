export interface DistributionProfileDescriptor {
  readonly profileId: string;
  readonly version: string;
  readonly capabilityDefaults: Readonly<Record<string, string>>;
}
