// EXCEPTION: This is the ONE place outside src/config/ allowed to read process.env
// directly, because initTracing() runs BEFORE ConfigModule is wired (the OpenTelemetry
// SDK must patch modules at import time, which means before NestJS's DI container
// exists). Documented in design.md §Decision 5.

// TODO: @opentelemetry/instrumentation-fastify@0.57.0 is deprecated in favor of
// @fastify/otel. Upgrade when @fastify/otel has stable NestJS support.

export async function initTracing(): Promise<void> {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  if (!endpoint) {
    console.log(
      '[tracing] OTEL_EXPORTER_OTLP_ENDPOINT unset, tracing disabled',
    );
    return;
  }

  // Dynamic imports avoid loading the heavy OTel SDK when tracing is disabled.
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } =
    await import('@opentelemetry/exporter-trace-otlp-http');
  const { getNodeAutoInstrumentations } =
    await import('@opentelemetry/auto-instrumentations-node');

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  // NodeSDK.start() is synchronous in v0.214.0 — no await needed.
  sdk.start();

  process.on('SIGTERM', () => {
    sdk.shutdown().catch(console.error);
  });
}
