/**
 * HTTP helper wrappers for k6 benchmark scenarios.
 *
 * All helpers read BASE_URL from the k6 __ENV object (set via -e or the
 * docker-compose bench profile). Defaults to http://localhost:3000 so
 * local runs work without any extra configuration.
 *
 * Every mutating request sets Content-Type: application/json.
 */

import http from 'k6/http';

/** Resolve base URL from environment with a safe default. */
function baseUrl() {
  const url = __ENV.BASE_URL;
  if (!url) {
    return 'http://localhost:3000';
  }
  return url.replace(/\/$/, '');
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * GET /api/v1/resources/:id
 * @param {string} id - Resource UUID
 * @returns {import('k6/http').RefinedResponse<'text'>}
 */
export function getResource(id) {
  return http.get(`${baseUrl()}/api/v1/resources/${id}`);
}

/**
 * GET /api/v1/resources with optional query parameters.
 * @param {Object} [params] - Query params (limit, cursor, type, status, etc.)
 * @returns {import('k6/http').RefinedResponse<'text'>}
 */
export function listResources(params = {}) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = query ? `${baseUrl()}/api/v1/resources?${query}` : `${baseUrl()}/api/v1/resources`;
  return http.get(url);
}

/**
 * POST /api/v1/resources
 * @param {Object} payload - Resource body (name, type, status?, tags?, metadata?, owner_id?)
 * @returns {import('k6/http').RefinedResponse<'text'>}
 */
export function createResource(payload) {
  return http.post(`${baseUrl()}/api/v1/resources`, JSON.stringify(payload), {
    headers: JSON_HEADERS,
  });
}

/**
 * PATCH /api/v1/resources/:id
 * @param {string} id - Resource UUID
 * @param {Object} payload - Fields to update
 * @returns {import('k6/http').RefinedResponse<'text'>}
 */
export function patchResource(id, payload) {
  return http.patch(`${baseUrl()}/api/v1/resources/${id}`, JSON.stringify(payload), {
    headers: JSON_HEADERS,
  });
}

/**
 * DELETE /api/v1/resources/:id
 * @param {string} id - Resource UUID
 * @returns {import('k6/http').RefinedResponse<'text'>}
 */
export function deleteResource(id) {
  return http.del(`${baseUrl()}/api/v1/resources/${id}`);
}
