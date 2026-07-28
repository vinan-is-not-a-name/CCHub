import { test, expect } from '@playwright/test';
import { EventEmitter } from 'events';
import { SshChannel } from '../src/server/infrastructure/transport/connector.js';

// Regression for the ghost-text bug: ssh2 slices its data stream at packet
// boundaries that can fall inside a multibyte UTF-8 char. Decoding each Buffer
// independently (Buffer.toString('utf8')) turns the split halves into U+FFFD,
// which corrupts cc's column-width math and strands frankenstein rows above
// the input box. SshChannel must buffer the incomplete tail via StringDecoder.

/** Minimal stand-in for ssh2's ClientChannel: an EventEmitter with a `.stderr`
 * sub-emitter, plus the no-op methods SshChannel touches. */
function fakeStream() {
  const stream = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    write: () => void;
    setWindow: () => void;
    close: () => void;
  };
  stream.stderr = new EventEmitter();
  stream.write = () => {};
  stream.setWindow = () => {};
  stream.close = () => {};
  return stream;
}

function collect(ch: SshChannel): { text: () => string } {
  let out = '';
  ch.on('data', (d: string) => { out += d; });
  return { text: () => out };
}

test.describe('SshChannel multibyte decode', () => {
  test('3-byte char split across two Buffers is not corrupted to U+FFFD', () => {
    const stream = fakeStream();
    const ch = new SshChannel();
    const sink = collect(ch);
    ch.attachStream(stream as never, new EventEmitter() as never);

    // '之' = U+4E4B = 0xE4 0xB9 0x8B. Split after the first byte, mirroring
    // the recorded event #8057 that started with ��.
    const full = Buffer.from('之', 'utf8');
    stream.emit('data', full.subarray(0, 1));
    stream.emit('data', full.subarray(1));

    expect(sink.text()).toBe('之');
    expect(sink.text()).not.toContain('�');
  });

  test('naive per-Buffer decode WOULD corrupt (proves the hazard is real)', () => {
    const full = Buffer.from('之', 'utf8');
    const naive = full.subarray(0, 1).toString('utf8') + full.subarray(1).toString('utf8');
    expect(naive).toContain('�');
  });

  test('stdout and stderr decoders are independent', () => {
    const stream = fakeStream();
    const ch = new SshChannel();
    const sink = collect(ch);
    ch.attachStream(stream as never, new EventEmitter() as never);

    // Interleave two different split chars on the two streams. If they shared
    // one decoder, the buffered tail of one would corrupt the other.
    const a = Buffer.from('中', 'utf8'); // 0xE4 0xB8 0xAD
    const b = Buffer.from('文', 'utf8'); // 0xE6 0x96 0x87
    stream.emit('data', a.subarray(0, 2));
    stream.stderr.emit('data', b.subarray(0, 2));
    stream.emit('data', a.subarray(2));
    stream.stderr.emit('data', b.subarray(2));

    expect(sink.text()).toBe('中文');
    expect(sink.text()).not.toContain('�');
  });

  test('multi-char chunk with a trailing partial char defers the tail', () => {
    const stream = fakeStream();
    const ch = new SshChannel();
    const sink = collect(ch);
    ch.attachStream(stream as never, new EventEmitter() as never);

    // "ab之" but the final char's last byte lands in the next chunk.
    const buf = Buffer.from('ab之', 'utf8');
    stream.emit('data', buf.subarray(0, buf.length - 1));
    expect(sink.text()).toBe('ab'); // partial '之' held back, no U+FFFD
    expect(sink.text()).not.toContain('�');
    stream.emit('data', buf.subarray(buf.length - 1));
    expect(sink.text()).toBe('ab之');
  });
});
