# scoreboard-streaming

## Purpose

The end-to-end live-update path for the scoreboard module. Owns the SSE controller `GET /v1/leaderboard/stream` (JWT-gated), the initial `event: snapshot` frame sourced from `LeaderboardCache.getTop(10)`, the local-emitter subscription that forwards `scoreboard-events` JetStream messages to connected SSE clients, the 15s heartbeat loop, the GAP-02 backpressure policy (drop-oldest after 50 pending messages per client + disconnect after 5000ms buffer-full), the per-instance connection-count cap returning `503 TEMPORARILY_UNAVAILABLE`, and the clean resource teardown on disconnect. Establishes the user-facing real-time contract that top-10 changes propagate to all connected clients within ≤ 1s p95 (NFR-03).

## Requirements

### Requirement: GET /v1/leaderboard/stream serves SSE with initial snapshot

The system SHALL expose `GET /v1/leaderboard/stream` (decorated with `@UseGuards(JwtGuard)`). On connection, the controller SHALL set headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, and SHALL send an initial `event: snapshot` frame containing the current top-10 from `LeaderboardCache.getTop(10)`.

#### Scenario: Connection establishes with correct SSE headers
- **GIVEN** a request `GET /v1/leaderboard/stream` with a valid JWT
- **WHEN** the controller handles the request
- **THEN** the response status is `200`
- **AND** the response headers include `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- **AND** the underlying socket stays open

#### Scenario: Initial snapshot is sent
- **GIVEN** a populated cache with 10 users
- **WHEN** an SSE connection establishes
- **THEN** the FIRST frame written is `event: snapshot\ndata: <json>\n\n` where `<json>` contains the top-10 entries

#### Scenario: Live updates flow from local emitter to client
- **GIVEN** an established SSE connection
- **WHEN** the local emitter receives a `leaderboard.updated` event (from the JetStream subscriber)
- **THEN** the controller writes a `event: leaderboard.updated\ndata: <json>\n\n` frame to the client
- **AND** the client receives it within the local emitter's latency budget (< 5ms)

### Requirement: Heartbeats every 15 seconds

The SSE controller SHALL send a `event: heartbeat\ndata: {}\n\n` frame every 15 seconds (configurable via `SSE_HEARTBEAT_INTERVAL_MS`). This keeps proxies and load balancers from timing out idle connections.

#### Scenario: Heartbeat fires after 15 seconds of inactivity
- **GIVEN** an SSE connection with no data events for 15 seconds
- **WHEN** the heartbeat timer fires
- **THEN** the controller writes a heartbeat frame
- **AND** the connection stays open

#### Scenario: Heartbeat continues even with active data events
- **GIVEN** an SSE connection receiving data events every 5 seconds
- **WHEN** 15 seconds pass
- **THEN** a heartbeat frame is sent in addition to the data frames
- **AND** the heartbeat schedule is independent of data event arrival

### Requirement: SSE backpressure (drop-oldest + disconnect on overflow) — GAP-02

The SSE controller SHALL track each connection's pending write buffer. When the buffer reaches `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES` pending messages, the controller SHALL drop the OLDEST pending message before adding the new one. If the buffer remains full for more than `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS` milliseconds, the controller SHALL close the connection cleanly and increment the `sse_slow_client_disconnected` metric.

#### Scenario: Drop-oldest activates when buffer is full
- **GIVEN** an SSE client whose pending buffer has reached `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES`
- **WHEN** a new `leaderboard.updated` message arrives for that client
- **THEN** the controller removes the OLDEST pending message
- **AND** appends the new message
- **AND** the buffer size remains at the cap (or one less if the write succeeded immediately)
- **AND** safety: each message contains the FULL current top-10, so dropping is lossless from a "current state" perspective

#### Scenario: Slow client disconnected after timeout
- **GIVEN** an SSE client whose buffer has been at the cap for `> SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS` milliseconds
- **WHEN** the slow-client tick runs
- **THEN** the controller writes a final SSE termination frame
- **AND** closes the underlying socket cleanly
- **AND** increments the `sse_slow_client_disconnected` metric
- **AND** removes the local-emitter subscription

#### Scenario: Healthy client unaffected by slow neighbor
- **GIVEN** one slow client and 1000 healthy clients on the same instance
- **WHEN** a leaderboard update fires
- **THEN** the slow client experiences drop-oldest (or eventual disconnect)
- **AND** the 1000 healthy clients receive the update without delay

### Requirement: Connection-count cap per instance

The SSE controller SHALL track the current SSE connection count for the instance. When the count reaches `MAX_SSE_CONN_PER_INSTANCE`, new connection attempts SHALL be rejected with `503 TEMPORARILY_UNAVAILABLE`. The metric `scoreboard_sse_connections` SHALL reflect the live count.

#### Scenario: New connection rejected when cap reached
- **GIVEN** the instance currently has `MAX_SSE_CONN_PER_INSTANCE` active SSE connections
- **WHEN** a new connection request arrives
- **THEN** the controller responds with `503 TEMPORARILY_UNAVAILABLE`
- **AND** the response envelope is the standard error format

#### Scenario: Counter decrements on disconnect
- **GIVEN** a connected SSE client
- **WHEN** the client disconnects (clean or unclean)
- **THEN** the controller decrements `currentConnectionCount`
- **AND** the `scoreboard_sse_connections` gauge is updated

### Requirement: Clean disconnect releases all per-connection resources

When an SSE client disconnects, the controller SHALL: (1) remove its subscription from the local emitter, (2) clear its heartbeat timer, (3) clear its slow-client monitoring tick, (4) decrement the connection counter. No memory leaks SHALL occur from disconnected clients.

#### Scenario: Disconnect cleans up all resources
- **GIVEN** an active SSE connection with an emitter subscription, a heartbeat timer, and a backpressure tick
- **WHEN** the client disconnects
- **THEN** the emitter subscription is removed
- **AND** the heartbeat timer is cleared
- **AND** the backpressure tick is cleared
- **AND** the connection counter is decremented
- **AND** subsequent leaderboard updates do NOT attempt to write to the closed socket
