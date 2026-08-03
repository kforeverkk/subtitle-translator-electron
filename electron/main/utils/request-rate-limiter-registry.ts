import { createApiAccountIdentity } from "./api-account";
import {
  RequestRateLimiter,
  type RequestRateLimitPolicy,
} from "./request-rate-limiter";

interface AcquireRequestRateLimiterOptions extends RequestRateLimitPolicy {
  apiHost: string;
  apiKey: string;
}

export interface RequestRateLimiterLease {
  limiter: RequestRateLimiter;
  release: () => void;
}

interface RegistryEntry {
  limiter: RequestRateLimiter;
  leases: Map<symbol, RequestRateLimitPolicy>;
}

export class RequestRateLimiterRegistry {
  private readonly accounts = new Map<string, RegistryEntry>();

  acquire(
    options: AcquireRequestRateLimiterOptions
  ): RequestRateLimiterLease {
    const identity = createApiAccountIdentity(options.apiHost, options.apiKey);
    const policy: RequestRateLimitPolicy = {
      requestsPerMinute: options.requestsPerMinute,
      minimumIntervalMs: options.minimumIntervalMs,
    };
    let entry = this.accounts.get(identity);
    if (!entry) {
      entry = {
        limiter: new RequestRateLimiter(policy),
        leases: new Map(),
      };
      this.accounts.set(identity, entry);
    }

    const leaseId = Symbol();
    entry.leases.set(leaseId, policy);
    this.applyStrictestPolicy(entry);

    let released = false;
    return {
      limiter: entry.limiter,
      release: () => {
        if (released) return;
        released = true;
        entry.leases.delete(leaseId);
        if (entry.leases.size === 0) {
          this.accounts.delete(identity);
          return;
        }
        this.applyStrictestPolicy(entry);
      },
    };
  }

  private applyStrictestPolicy(entry: RegistryEntry): void {
    const policies = [...entry.leases.values()];
    entry.limiter.updatePolicy({
      requestsPerMinute: Math.min(
        ...policies.map((policy) => policy.requestsPerMinute)
      ),
      minimumIntervalMs: Math.max(
        ...policies.map((policy) => policy.minimumIntervalMs)
      ),
    });
  }
}
