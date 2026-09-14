// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";

function headerValue(req, name) {
  let occurrences = 0;
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === name) occurrences += 1;
  }
  const value = req.headers[name];
  if (occurrences > 1 || Array.isArray(value)) {
    throw new HttpError(400, "ambiguous_header", `${name} must appear once.`);
  }
  return typeof value === "string" ? value.trim() : "";
}

export function validateContentType(req, kind) {
  const contentEncoding = headerValue(req, "content-encoding").toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new HttpError(415, "unsupported_content_encoding", "Compressed request bodies are not accepted.");
  }

  const raw = headerValue(req, "content-type");
  const [mediaType, ...parameters] = raw.split(";").map((part) => part.trim());
  if (kind === "json") {
    if (mediaType.toLowerCase() !== "application/json") {
      throw new HttpError(415, "unsupported_content_type", "Content-Type must be application/json.");
    }
    if (parameters.length > 1) {
      throw new HttpError(415, "unsupported_json_parameter", "Only one UTF-8 charset parameter is accepted.");
    }
    for (const parameter of parameters) {
      if (parameter && parameter.toLowerCase() !== "charset=utf-8") {
        throw new HttpError(415, "unsupported_json_parameter", "Only UTF-8 JSON is accepted.");
      }
    }
    return "application/json";
  }

  if (mediaType.toLowerCase() !== "multipart/form-data") {
    throw new HttpError(415, "unsupported_content_type", "Content-Type must be multipart/form-data.");
  }
  const boundaryParameters = parameters.filter((parameter) => /^boundary=/iu.test(parameter));
  if (boundaryParameters.length !== 1 || parameters.length !== 1) {
    throw new HttpError(415, "invalid_multipart_boundary", "A single multipart boundary is required.");
  }
  let boundary = boundaryParameters[0].slice("boundary=".length);
  if (boundary.startsWith("\"") && boundary.endsWith("\"")) {
    boundary = boundary.slice(1, -1);
  }
  if (!boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,./:=?-]+$/u.test(boundary)) {
    throw new HttpError(415, "invalid_multipart_boundary", "Multipart boundary is invalid.");
  }
  return raw;
}

const STAT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

// Per-route statistics window limits in days. WeChat's single-day article
// statistics interfaces require begin_date === end_date; the account summary
// accepts windows of up to 30 days.
const DATACUBE_SPAN_DAYS = new Map([
  ["datacube.getarticlesummary", 1],
  ["datacube.getarticletotal", 1],
  ["datacube.getarticleread", 1],
  ["datacube.getarticleshare", 1],
  ["datacube.getarticletotaldetail", 1],
  ["datacube.getbizsummary", 30],
]);

function parseStatDate(value) {
  if (typeof value !== "string" || !STAT_DATE_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const utc = Date.UTC(year, month - 1, day);
  const probe = new Date(utc);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utc / DAY_MS);
}

// WeChat aggregates statistics on Beijing calendar days, and same-day data is
// never final. Compare against the Asia/Shanghai date instead of the host
// timezone so a UTC container does not misjudge which day is "today".
function beijingToday() {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  return Math.floor(new Date(`${formatted}T00:00:00Z`).getTime() / DAY_MS);
}

function validateDatacubeDates(data, maxSpanDays) {
  const keys = Object.keys(data);
  if (keys.length !== 2 || !("begin_date" in data) || !("end_date" in data)) {
    throw new HttpError(400, "invalid_json_shape", "Statistics requests accept only begin_date and end_date.");
  }
  const begin = parseStatDate(data.begin_date);
  const end = parseStatDate(data.end_date);
  if (begin === null || end === null) {
    throw new HttpError(400, "invalid_date_format", "Dates must be calendar-valid YYYY-MM-DD strings.");
  }
  if (begin > end || end - begin + 1 > maxSpanDays) {
    throw new HttpError(400, "date_span_not_supported", "The date window must be ordered and within this route's span limit.");
  }
  if (end >= beijingToday()) {
    throw new HttpError(400, "date_not_finalized", "end_date must be a finalized Beijing statistics day (yesterday or earlier).");
  }
}

function declaredLength(req) {
  const raw = headerValue(req, "content-length");
  if (!raw) return null;
  if (!/^\d+$/u.test(raw)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
  }
  return value;
}

export function assertNoBody(req) {
  const contentLength = headerValue(req, "content-length");
  const transferEncoding = headerValue(req, "transfer-encoding");
  if ((contentLength && contentLength !== "0") || transferEncoding) {
    throw new HttpError(400, "unexpected_body", "This endpoint does not accept a request body.");
  }
}

export function readBody(req, maximumBytes, timeoutMs) {
  const announced = declaredLength(req);
  if (announced !== null && announced > maximumBytes) {
    req.resume();
    throw new HttpError(413, "body_too_large", "Request body exceeds the configured limit.");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const fail = (error, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) req.destroy();
      else req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        fail(new HttpError(413, "body_too_large", "Request body exceeds the configured limit."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = () => fail(new HttpError(400, "request_aborted", "Request body was aborted."));
    const onError = () => fail(new HttpError(400, "request_stream_error", "Request body could not be read."));
    const timer = setTimeout(() => {
      fail(new HttpError(408, "body_timeout", "Request body timed out."), true);
    }, timeoutMs);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
  });
}

export function bodySha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

export function validateJsonBody(routeId, body) {
  let text;
  let data;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid UTF-8 JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "invalid_json_shape", "JSON body must be an object.");
  }
  if (routeId === "draft.add") {
    if (!Array.isArray(data.articles) || data.articles.length < 1 || data.articles.length > 8) {
      throw new HttpError(400, "invalid_articles", "Draft request must contain between one and eight articles.");
    }
    if (data.articles.some((article) => !article || typeof article !== "object" || Array.isArray(article))) {
      throw new HttpError(400, "invalid_articles", "Each article must be an object.");
    }
  }
  if (routeId === "draft.get") {
    if (typeof data.media_id !== "string" || !data.media_id || data.media_id.length > 256) {
      throw new HttpError(400, "invalid_media_reference", "Draft lookup requires a valid media reference.");
    }
  }
  const datacubeSpanDays = DATACUBE_SPAN_DAYS.get(routeId);
  if (datacubeSpanDays !== undefined) {
    validateDatacubeDates(data, datacubeSpanDays);
  }
}

export function readIdempotencyKey(req, mode) {
  const key = headerValue(req, "idempotency-key");
  if (!key && mode === "required") {
    throw new HttpError(400, "missing_idempotency_key", "Idempotency-Key is required for draft creation.");
  }
  if (!key) return "";
  if (mode === "forbidden") {
    throw new HttpError(400, "idempotency_not_supported", "This route does not accept Idempotency-Key.");
  }
  if (key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key format is invalid.");
  }
  return key;
}
