"""Archive download recovery and cache safety without live archive dependence."""
from contextlib import contextmanager
from email.utils import formatdate
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
import threading

from astropy.io import fits
import numpy as np
import pytest
import requests

from backend.app import spherex_client as sx


@pytest.fixture
def download_env(tmp_path, monkeypatch):
    monkeypatch.setattr(sx, 'CACHE_DIR', str(tmp_path))
    monkeypatch.setattr(sx.random, 'uniform', lambda *args: 0)
    waits = []
    monkeypatch.setattr(sx.time, 'sleep', waits.append)
    data = BytesIO()
    fits.PrimaryHDU(np.arange(16, dtype=np.float32)).writeto(data)
    return tmp_path, waits, data.getvalue()


class Reply:
    def __init__(self, status=200, data=b'', headers=None, stream_error=None):
        self.status_code, self.data = status, data
        self.headers = requests.structures.CaseInsensitiveDict(headers or {})
        self.stream_error, self.closed = stream_error, False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def iter_content(self, chunk_size):
        yield self.data
        if self.stream_error:
            raise self.stream_error


def serve_replies(monkeypatch, replies):
    calls = []
    def get(url, **kwargs):
        calls.append((url, kwargs))
        reply = replies[len(calls) - 1]
        if isinstance(reply, Exception):
            raise reply
        return reply
    monkeypatch.setattr(sx.requests, 'get', get)
    return calls


def test_retry_after_closes_response_before_wait_and_success_is_cached(download_env, monkeypatch):
    directory, waits, payload = download_env
    busy, ok = Reply(503, headers={'Retry-After': '5'}), Reply(data=payload)
    calls = serve_replies(monkeypatch, [busy, ok])
    def wait(seconds):
        assert busy.closed
        assert not list(directory.iterdir())
        waits.append(seconds)
    monkeypatch.setattr(sx.time, 'sleep', wait)
    result = sx.download_cutout('https://archive.test/exposure.fits')
    assert Path(result).read_bytes() == payload
    assert waits == [5] and len(calls) == 2 and ok.closed
    assert calls[0][1] == {'timeout': (15, 120), 'stream': True}
    assert sx.download_cutout(calls[0][0]) == result and len(calls) == 2
    assert list(directory.iterdir()) == [Path(result)]


@pytest.mark.parametrize('header,delay', [
    (formatdate(1_700_000_007, usegmt=True), 7),
    (formatdate(1_699_999_990, usegmt=True), 2),
    ('invalid date', 2), ('-5', 2), ('', 2), ('0', 2), ('00000000005', 5),
])
def test_date_and_malformed_retry_after(download_env, monkeypatch, header, delay):
    _, waits, payload = download_env
    monkeypatch.setattr(sx.time, 'time', lambda: 1_700_000_000)
    serve_replies(monkeypatch, [Reply(429, headers={'Retry-After': header}), Reply(data=payload)])
    sx.download_cutout('https://archive.test/exposure.fits')
    assert waits == [delay]


@pytest.mark.parametrize('status', [408, 429, 500, 502, 503, 504])
def test_transient_status_recovers(download_env, monkeypatch, status):
    _, waits, payload = download_env
    replies = [Reply(status), Reply(data=payload)]
    calls = serve_replies(monkeypatch, replies)
    assert Path(sx.download_cutout('https://archive.test/exposure.fits')).read_bytes() == payload
    assert len(calls) == 2 and waits == [2] and all(r.closed for r in replies)


@pytest.mark.parametrize('status', [400, 401, 403, 404, 422])
def test_permanent_errors_never_retry(download_env, monkeypatch, status):
    directory, waits, _ = download_env
    reply = Reply(status)
    calls = serve_replies(monkeypatch, [reply])
    with pytest.raises(sx.CutoutNoOverlapError if status == 422 else sx.CutoutDownloadError):
        sx.download_cutout('https://archive.test/exposure.fits')
    assert len(calls) == 1 and not waits and reply.closed
    assert not list(directory.iterdir())


@pytest.mark.parametrize('header', ['61', '999999999999999999999', formatdate(1_700_000_120, usegmt=True)])
def test_long_server_delay_fails_instead_of_retrying_early(download_env, monkeypatch, header):
    directory, waits, _ = download_env
    monkeypatch.setattr(sx.time, 'time', lambda: 1_700_000_000)
    reply = Reply(503, headers={'Retry-After': header})
    calls = serve_replies(monkeypatch, [reply])
    with pytest.raises(sx.CutoutDownloadError, match='retry wait limit'):
        sx.download_cutout('https://archive.test/exposure.fits')
    assert len(calls) == 1 and reply.closed and not waits and not list(directory.iterdir())


def test_timeout_exhaustion_has_bounded_backoff_and_no_cache(download_env, monkeypatch):
    directory, waits, _ = download_env
    calls = serve_replies(monkeypatch, [requests.Timeout('no data')] * 5)
    with pytest.raises(sx.CutoutDownloadError, match='after 5 attempts.*Timeout'):
        sx.download_cutout('https://archive.test/exposure.fits')
    assert len(calls) == 5 and waits == [2, 4, 8, 16]
    assert not list(directory.iterdir())


def test_jitter_never_shortens_server_delay(download_env, monkeypatch):
    _, waits, payload = download_env
    monkeypatch.setattr(sx.random, 'uniform', lambda *args: .75)
    serve_replies(monkeypatch, [Reply(503, headers={'Retry-After': '5'}), Reply(data=payload)])
    sx.download_cutout('https://archive.test/exposure.fits')
    assert waits == [5.75]


@pytest.mark.parametrize('failure', ['midstream', 'short', 'length', 'html'])
def test_bad_transfers_are_removed_before_retry(download_env, monkeypatch, failure):
    directory, waits, payload = download_env
    first = {
        'midstream': Reply(data=payload[:2880], stream_error=requests.ConnectionError('stream timeout')),
        'short': Reply(data=payload[:-1]),
        'length': Reply(data=payload, headers={'Content-Length': str(len(payload) + 2880)}),
        'html': Reply(data=b'<html>error</html>'.ljust(5760, b' ')),
    }[failure]
    serve_replies(monkeypatch, [first, Reply(data=payload)])
    def wait(seconds):
        assert first.closed and not list(directory.iterdir())
        waits.append(seconds)
    monkeypatch.setattr(sx.time, 'sleep', wait)
    result = sx.download_cutout('https://archive.test/exposure.fits')
    assert Path(result).read_bytes() == payload and waits == [2]


def test_invalid_old_cache_is_replaced(download_env, monkeypatch):
    _, _, payload = download_env
    url = 'https://archive.test/exposure.fits'
    Path(sx._cache_path(url)).write_bytes(b'old HTML error'.ljust(5760, b' '))
    calls = serve_replies(monkeypatch, [Reply(data=payload)])
    assert Path(sx.download_cutout(url)).read_bytes() == payload and len(calls) == 1


def test_cache_write_failure_cleans_temporary_file_without_network_retries(download_env, monkeypatch):
    directory, waits, payload = download_env
    calls = serve_replies(monkeypatch, [Reply(data=payload)])
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(sx.os, 'replace', fail)
    with pytest.raises(OSError, match='disk full'):
        sx.download_cutout('https://archive.test/exposure.fits')
    assert len(calls) == 1 and not waits and not list(directory.iterdir())


@contextmanager
def local_archive(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/exposure.fits'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_real_http_busy_then_broken_chunked_transfer_then_success(download_env):
    directory, waits, payload = download_env
    class Archive(BaseHTTPRequestHandler):
        attempts = 0
        def log_message(self, *args):
            pass
        def do_GET(self):
            type(self).attempts += 1
            if self.attempts == 1:
                self.send_response(503)
                self.send_header('Retry-After', '5')
                self.end_headers()
            elif self.attempts == 2:
                self.send_response(200)
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                self.wfile.write(b'10\r\nshort')  # close halfway through a promised chunk
            else:
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
    with local_archive(Archive) as url:
        result = sx.download_cutout(url)
    assert Path(result).read_bytes() == payload and Archive.attempts == 3
    assert waits == [5, 4] and list(directory.iterdir()) == [Path(result)]


def test_real_http_content_encoding_does_not_compare_compressed_length(download_env):
    _, waits, payload = download_env
    compressed = gzip.compress(payload)
    class Archive(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(compressed)))
            self.end_headers()
            self.wfile.write(compressed)
    with local_archive(Archive) as url:
        assert Path(sx.download_cutout(url)).read_bytes() == payload
    assert not waits
