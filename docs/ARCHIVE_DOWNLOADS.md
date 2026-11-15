# Archive download recovery

SPHEREx image and calibration downloads share `spherex_client.download_cutout`.
An IRSA HTTP 503 response can be temporary even when the full FITS file exists.
The downloader now allows five total attempts for connection/read failures,
broken transfers, invalid FITS responses, and HTTP 408, 429, 500, 502, 503 or 504.
Other HTTP errors fail immediately; HTTP 422 retains its distinct no-overlap
exception so callers can skip exposures outside the requested field.

Retries use exponential delays of 2, 4, 8 and 16 seconds plus up to one second
of random jitter. A valid `Retry-After` header is a minimum delay, whether
expressed as seconds or an HTTP date, as defined by
[RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3).
Malformed headers fall back to the local delay. Each wait is limited to 60
seconds: if the server asks for longer, the download fails with a retry-later
message instead of retrying before the requested time. Responses are closed
before waiting, and failed attempts are logged.

Connection establishment has a 15-second timeout; the existing 120-second
read timeout is retained for slow archive processing. These are socket
timeouts, not a wall-clock deadline for an entire transfer, consistent with
[Requests' timeout semantics](https://requests.readthedocs.io/en/latest/user/advanced/#timeouts).
An archive outage can still exhaust retries. More attempts can increase the
time before a failure or pending cancellation is reported; cancellation still
waits for the current exposure/download to finish.

Response bodies stream into temporary files in 64 KiB chunks. A download is
published atomically only after checking its FITS signature, 2880-byte block
alignment and declared length when HTTP content encoding permits comparison.
Failed temporary files are removed. HTTP-compressed responses are checked
after decompression without comparing their decoded length to the compressed
`Content-Length`. Existing cached files receive the same cheap signature and
block checks. These checks are not a full FITS/scientific validation: the
science loaders continue to validate detector identity, units and calibration.

## Validation

`backend/tests/test_downloads.py` covers both Retry-After forms, malformed and
oversized delays, rate limits, timeouts, retry exhaustion, permanent HTTP
errors, response cleanup, partial transfers, invalid cached files and write
failures. Local HTTP servers also exercise real Requests behavior for a
503 → broken chunked transfer → success sequence and gzip content encoding.

On 2026-11-15, the updated downloader fetched the original QR3 D4 cutout into
a fresh cache. It returned 3,962,880 bytes with the exact original SHA-256 and
left no temporary files. This live request succeeded on its first attempt;
the deterministic HTTP tests establish the retry behavior. See the
[live download record](validation/downloader-2026-11-15.json).
