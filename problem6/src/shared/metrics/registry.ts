import { Registry } from 'prom-client';

/**
 * Central Prometheus registry for all scoreboard metrics.
 * Metrics are declared once at module load time (prom-client throws on re-registration).
 * Use `registers: [registry]` in each metric's options to bind it here.
 */
export const registry = new Registry();
