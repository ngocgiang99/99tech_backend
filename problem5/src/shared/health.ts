export type HealthStatus = 'up' | 'down';

export interface CheckResult {
  status: HealthStatus;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: Record<string, CheckResult>;
}

type HealthCheckFn = () => Promise<CheckResult>;

export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheckFn>();

  register(name: string, fn: HealthCheckFn): void {
    this.checks.set(name, fn);
  }

  async run(): Promise<HealthReport> {
    if (this.checks.size === 0) {
      return { status: 'ok', checks: {} };
    }

    const results: Record<string, CheckResult> = {};
    let degraded = false;

    await Promise.all(
      Array.from(this.checks.entries()).map(async ([name, fn]) => {
        try {
          const result = await fn();
          results[name] = result;
          if (result.status === 'down') {
            degraded = true;
          }
        } catch (err) {
          results[name] = {
            status: 'down',
            error: err instanceof Error ? err.message : String(err),
          };
          degraded = true;
        }
      }),
    );

    return {
      status: degraded ? 'degraded' : 'ok',
      checks: results,
    };
  }
}
